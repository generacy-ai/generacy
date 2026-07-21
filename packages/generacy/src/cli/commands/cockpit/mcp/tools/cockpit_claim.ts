/**
 * `cockpit_claim` MCP tool (#1015).
 *
 * Idempotent acquire-or-refresh-or-takeover of the active-driver claim on a
 * scope. Skill calls this at arm time and on every wake-tick heartbeat.
 *
 * See contracts/cockpit_claim.md.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitClaimInputSchema,
  type CockpitClaimInput,
} from '../schemas.js';
import { acquireClaim } from '../claim/acquire.js';
import type {
  AcquireResult,
  ClaimPayload,
  RefusalPayload,
} from '../claim/payload.js';

export interface CockpitClaimData {
  action: 'acquired' | 'refreshed' | 'taken-over';
  claim: ClaimPayload;
  commentUrl: string;
  /** Present only when `action === 'taken-over'`. */
  displaced?: ClaimPayload;
}

export interface CockpitClaimDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  now?: () => Date;
}

/**
 * Return envelope: either a standard `ToolResult<T>` OR the narrowed
 * `RefusalPayload` (adds `holder` + `commentUrl` on the `claim-conflict`
 * class). Structurally assignable to `ToolResult<T>` because Zod-optional
 * fields on the error variant permit the extras.
 */
export type CockpitClaimResult = ToolResult<CockpitClaimData> | RefusalPayload;

export async function cockpitClaim(
  input: CockpitClaimInput,
  deps: CockpitClaimDeps = {},
): Promise<CockpitClaimResult> {
  return (await wrapToolBoundary<CockpitClaimData>(async () => {
    const parsed = CockpitClaimInputSchema.safeParse(input);
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
      const result = await acquireClaim({
        gh,
        scope: {
          owner: scopeN.value.ref.owner,
          repo: scopeN.value.ref.repo,
          number: scopeN.value.ref.number,
        },
        sessionId: parsed.data.sessionId,
        ledger: parsed.data.ledger,
        takeover: parsed.data.takeover,
        now,
      });

      if (result.status === 'ok') {
        return toOkEnvelope(result);
      }
      // RefusalPayload — narrow ToolErrorResult with extra claim fields.
      return result;
    } catch (err) {
      return classifyGhError(err, scopeN.value.ref.nwo, scopeN.value.ref.number);
    }
  })) as CockpitClaimResult;
}

function toOkEnvelope(result: AcquireResult): CockpitClaimResult {
  if (result.action === 'taken-over') {
    return {
      status: 'ok',
      data: {
        action: result.action,
        claim: result.claim,
        commentUrl: result.commentUrl,
        displaced: result.displaced,
      },
    };
  }
  return {
    status: 'ok',
    data: {
      action: result.action,
      claim: result.claim,
      commentUrl: result.commentUrl,
    },
  };
}

function classifyGhError(
  err: unknown,
  nwo: string,
  number: number,
): CockpitClaimResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (/404|not found|no such/i.test(msg)) {
    return {
      status: 'error',
      class: 'scope-not-found',
      detail: `scope issue ${nwo}#${number} not found`,
    };
  }
  return { status: 'error', class: 'transport', detail: firstLine(msg) };
}

function firstLine(s: string): string {
  const first = s.split('\n')[0];
  return first != null && first.length > 0 ? first : s;
}
