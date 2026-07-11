/**
 * `cockpit_merge` MCP tool handler.
 *
 * Wraps `runMerge`. Unlike other tools, this one accepts a *PR ref* — an
 * issue number passed here is a `wrong-kind` schema-level rejection.
 * (The CLI's `runMerge` today takes an issue number and resolves it to a PR,
 * but the MCP contract per spec § 4 is symmetric: PR-in, PR-out.)
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { runMerge } from '../../merge.js';
import { normalizeIssueRef } from '../ref-input.js';
import { getLogger } from '../../../../utils/logger.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitMergeInputSchema, type IssueRefInput } from '../schemas.js';

export interface CockpitMergeInput {
  pr: IssueRefInput;
}

export interface CockpitMergeData {
  pr: { owner: string; repo: string; number: number; url: string };
  action: 'merged' | 'blocked';
  checksState: 'success' | 'failure' | 'pending' | 'none';
  mergeCommitSha?: string;
  reason?: string;
  raw?: unknown;
}

export interface CockpitMergeDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
}

export function cockpitMerge(
  input: CockpitMergeInput,
  deps: CockpitMergeDeps = {},
): Promise<ToolResult<CockpitMergeData>> {
  return wrapToolBoundary(async () => {
    const parsed = CockpitMergeInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    const normalized = await normalizeIssueRef(parsed.data.pr, {
      expects: 'pr',
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.gh != null ? { gh: deps.gh } : {}),
    });
    if (!normalized.ok) return normalized.error;

    const logger = getLogger();
    const result = await runMerge({
      gh: deps.gh ?? normalized.value.gh,
      issue: normalized.value.ref.number,
      repo: normalized.value.ref.nwo,
      logger,
    });

    const url = `https://github.com/${normalized.value.ref.nwo}/pull/${normalized.value.ref.number}`;
    if (result.exitCode === 0) {
      return {
        status: 'ok',
        data: {
          pr: {
            owner: normalized.value.ref.owner,
            repo: normalized.value.ref.repo,
            number: normalized.value.ref.number,
            url,
          },
          action: 'merged',
          checksState: 'success',
        },
      };
    }

    let raw: unknown = null;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      // fall through — non-JSON stdout, treat opaquely
    }
    const reason = extractReason(raw) ?? result.stdout.trim().split('\n')[0] ?? 'merge blocked';

    return {
      status: 'error',
      class: 'gate-refusal',
      detail: reason,
    };
  });
}

function extractReason(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as { reason?: unknown };
  if (typeof r.reason === 'string') return r.reason;
  return null;
}
