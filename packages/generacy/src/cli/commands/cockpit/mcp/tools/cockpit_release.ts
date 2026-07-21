/**
 * `cockpit_release` MCP tool (#1015).
 *
 * Explicit release of the active-driver claim. Fully idempotent — release
 * as non-holder returns `not-holder` (success), release with no live claim
 * returns `no-claim` (success).
 *
 * Never emits `claim-conflict` — release is by-session-id only.
 *
 * See contracts/cockpit_release.md.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitReleaseInputSchema,
  type CockpitReleaseInput,
} from '../schemas.js';
import { releaseClaim } from '../claim/release.js';
import type { ClaimPayload } from '../claim/payload.js';

export interface CockpitReleaseData {
  action: 'released' | 'not-holder' | 'no-claim';
  releasedClaim?: ClaimPayload;
  currentHolder?: ClaimPayload;
}

export interface CockpitReleaseDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  now?: () => Date;
}

export function cockpitRelease(
  input: CockpitReleaseInput,
  deps: CockpitReleaseDeps = {},
): Promise<ToolResult<CockpitReleaseData>> {
  return wrapToolBoundary(async () => {
    const parsed = CockpitReleaseInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    const scopeN = await normalizeIssueRef(parsed.data.scope, {
      expects: 'issue',
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.gh != null ? { gh: deps.gh } : {}),
    });
    if (!scopeN.ok) return scopeN.error;

    const gh = deps.gh ?? scopeN.value.gh;
    const now = deps.now?.() ?? new Date();

    try {
      const result = await releaseClaim({
        gh,
        scope: {
          owner: scopeN.value.ref.owner,
          repo: scopeN.value.ref.repo,
          number: scopeN.value.ref.number,
        },
        sessionId: parsed.data.sessionId,
        now,
      });

      if (result.action === 'released') {
        return {
          status: 'ok',
          data: { action: 'released', releasedClaim: result.releasedClaim },
        };
      }
      if (result.action === 'not-holder') {
        const data: CockpitReleaseData = { action: 'not-holder' };
        if (result.currentHolder !== undefined) {
          data.currentHolder = result.currentHolder;
        }
        return { status: 'ok', data };
      }
      return { status: 'ok', data: { action: 'no-claim' } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|not found|no such/i.test(msg)) {
        return {
          status: 'error',
          class: 'scope-not-found',
          detail:
            `scope issue ${scopeN.value.ref.nwo}#${scopeN.value.ref.number} not found`,
        };
      }
      return { status: 'error', class: 'transport', detail: firstLine(msg) };
    }
  });
}

function firstLine(s: string): string {
  const first = s.split('\n')[0];
  return first != null && first.length > 0 ? first : s;
}
