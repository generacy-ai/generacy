/**
 * `cockpit_merge` MCP tool handler.
 *
 * Wraps `runMerge` (or `runMergeWithExplicitPr` when `pr` is supplied). Takes
 * an issue ref, resolves it to a linked PR, and squash-merges IFF the PR is
 * green and the issue carries `completed:validate`. Fully symmetric with the
 * CLI verb `cockpit merge <issue>` — the same contract on both transports.
 *
 * If the caller's `issue` resolves to a *PR* node (rather than an issue), the
 * resolver returns `{ kind: 'pr-number' }` and the CLI emits exit-2 with
 * `reason: 'pr-number'`. `toMcpResult` maps that to `class: 'wrong-kind'`
 * with the guidance hint carried over verbatim.
 *
 * Optional `pr: <number>` mirrors the CLI's `--pr <number>` escape hatch:
 * skips resolution but keeps every safety precondition (linkage verification,
 * completed:validate, checks green). Never a resolution bypass of safety.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { runMerge, runMergeWithExplicitPr } from '../../merge.js';
import { assertQualifiedString, normalizeIssueRef } from '../ref-input.js';
import { getLogger } from '../../../../utils/logger.js';
import { toMcpResult, wrapToolBoundary, type ToolResult } from '../errors.js';
import { CockpitMergeInputSchema, type IssueRefInput } from '../schemas.js';

export interface CockpitMergeInput {
  issue: IssueRefInput;
  pr?: number;
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
      // Q5 → B: preserve the old-field-name redirection. If the caller sent
      // a `pr` key whose value is NOT a positive integer (i.e. they meant
      // the pre-#928 shape where `pr` carried the issue ref), surface the
      // renamed-field guidance instead of Zod's raw unknown-key diagnosis.
      if (isPrLikelyOldFieldName(input)) {
        return {
          status: 'error',
          class: 'invalid-args',
          detail:
            "the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number",
        };
      }
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    // Q1 → A: bare strings on the MCP transport must be qualified refs.
    if (typeof parsed.data.issue === 'string') {
      const qualified = assertQualifiedString(parsed.data.issue);
      if (!qualified.ok) {
        return { status: 'error', class: 'invalid-args', detail: qualified.error };
      }
    }

    const normalized = await normalizeIssueRef(parsed.data.issue, {
      expects: 'issue',
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.gh != null ? { gh: deps.gh } : {}),
    });
    if (!normalized.ok) return normalized.error;

    const logger = getLogger();
    const nwo = normalized.value.ref.nwo;
    const issueNumber = normalized.value.ref.number;
    const gh = deps.gh ?? normalized.value.gh;

    const result =
      parsed.data.pr != null
        ? await runMergeWithExplicitPr({
            gh,
            issue: issueNumber,
            repo: nwo,
            prNumber: parsed.data.pr,
            logger,
          })
        : await runMerge({
            gh,
            issue: issueNumber,
            repo: nwo,
            logger,
          });

    // Successful merge → synthesize a MCP payload. The CLI emits either an
    // empty stdout (no notes) or a note followed by a branch-deletion suffix
    // on success — neither is JSON. `result.prNumber` carries the resolved
    // PR (or the caller's explicit `--pr <n>`).
    if (result.exitCode === 0) {
      const prNumber = result.prNumber ?? parsed.data.pr ?? issueNumber;
      const url = `https://github.com/${nwo}/pull/${prNumber}`;
      return {
        status: 'ok',
        data: {
          pr: {
            owner: normalized.value.ref.owner,
            repo: normalized.value.ref.repo,
            number: prNumber,
            url,
          },
          action: 'merged',
          checksState: 'success',
        },
      };
    }

    return toMcpResult<CockpitMergeData>(result.stdout, result.exitCode);
  });
}

/**
 * Detects the pre-#928 field shape: a `pr` key whose value is NOT a positive
 * integer (i.e. either a string, object, or non-integer number). Used to
 * emit the renamed-field guidance instead of Zod's default error.
 */
function isPrLikelyOldFieldName(raw: unknown): boolean {
  if (raw == null || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (!('pr' in r)) return false;
  const pr = r.pr;
  if (typeof pr === 'number' && Number.isInteger(pr) && pr > 0) return false;
  return true;
}
