import type { CockpitState } from '../types.js';

/**
 * Tier precedence — lower rank wins.
 * Mirrors the table in data-model.md §"Curated state".
 */
export const TIER_RANK: Record<CockpitState, number> = {
  terminal: 0,
  error: 1,
  waiting: 2,
  active: 3,
  pending: 4,
  'stage-complete': 5,
  unknown: 6,
};

/**
 * Pipeline order for the `waiting` tier tie-break.
 * Earlier index wins. Gates not listed here sort after all listed gates.
 *
 * Note: `clarification-review`, `sibling-review`, `pr-feedback`,
 * `children-complete`, `epic-approval`, and `needs:*`
 * labels also exist but fall back to `WORKFLOW_LABELS` index when not
 * listed here (see classifier).
 */
export const WAITING_PIPELINE_ORDER: string[] = [
  // #883: `blocked:stuck-feedback-loop` sorts ahead of every waiting-for:*
  // gate so cockpit surfaces the pause first when both labels coexist. Retained
  // as the legacy (flag-OFF) PR-feedback bounded stop (#1130 / PR #1145 review).
  'blocked:stuck-feedback-loop',
  // #1070 D-3: terminal `blocked:fixer-timeout-*` labels outrank
  // `waiting-for:address-pr-feedback` — a terminal blocked state is the
  // more-specific and more-urgent thing to surface (mirrors the
  // `blocked:stuck-feedback-loop` precedent above).
  'blocked:fixer-timeout-no-progress',
  'blocked:fixer-timeout-repeat',
  // #1073 D-4: terminal `blocked:resolve-failed` (CLI-self-commit or
  // handler-commit landed but reply/resolve batch had zero successes) outranks
  // `waiting-for:address-pr-feedback` — no auto-retry window exists for a
  // resolve failure, so the cluster is not still "waiting-for:address-pr-feedback".
  'blocked:resolve-failed',
  // #926: `waiting-for:address-pr-feedback` outranks every waiting-for:*
  // gate — an actively-rewriting-code state is more-specific than any
  // passive gate it can coexist with (Q1→A, following #883's precedent).
  'waiting-for:address-pr-feedback',
  // #1070 D-3 / Q4=A: the retry-eligible `blocked:fixer-timeout` sorts
  // BELOW `waiting-for:address-pr-feedback`. The retry is coming; the
  // cluster IS still "waiting-for:address-pr-feedback" — that is the
  // more-informative status for the operator watching the retry window.
  'blocked:fixer-timeout',
  'waiting-for:spec-review',
  'waiting-for:clarification',
  'waiting-for:plan-review',
  'waiting-for:tasks-review',
  'waiting-for:implementation-review',
  // #1167 FR-008: the review/remediate cap pause sorts immediately after the
  // implementation-review gate it succeeds in the flow.
  'waiting-for:remediation-limit',
  // #1211: dependency-blocked implement pause — operator-grant cycle cap.
  'waiting-for:dependency-limit',
  // #1211: dependency-blocked implement pause — gate held until all refs closed.
  'waiting-for:dependencies',
  // #1211: dependency-blocked implement pause — operator-grant cycle cap.
  'waiting-for:dependency-limit',
  // #1211: dependency-blocked implement pause — gate held until all refs closed.
  'waiting-for:dependencies',
  'waiting-for:manual-validation',
  // #1167 FR-008: CI-green gate is the final pause in the flow, sorted last.
  'waiting-for:ci',
];

// #943: intra-error tie-break — the two enumerated blocked:* labels outrank
// agent:error and failed:* so cockpit surfaces the specific escalation gate
// rather than the generic error handler. Full label set remains available on
// the classified state for consumers that want the generic signal.
export const ERROR_PIPELINE_ORDER: string[] = [
  'blocked:stuck-merge-conflicts',
  'blocked:stuck-validate-fix',
];

// Latest-phase-wins order for the `stage-complete` tier (FR-005).
// Reverse of pipeline: labels closer to workflow end come first so lower
// index wins the sourceLabel slot when multiple demoted completed:* co-occur.
export const STAGE_COMPLETE_PIPELINE_ORDER: string[] = [
  // #1167 FR-009: review/remediate completions sort latest-phase-wins —
  // validate closes the flow (index 0), then the relocated implementation-review
  // gate, then remediate before review, both ahead of implement.
  'completed:validate',
  'completed:implementation-review',
  'completed:remediate',
  'completed:review',
  'completed:implement',
  'completed:tasks-review',
  'completed:tasks',
  'completed:plan-review',
  'completed:plan',
  'completed:clarification-review',
  'completed:clarification',
  'completed:clarify',
  'completed:spec-review',
  'completed:specify',
  'completed:setup',
  'completed:manual-validation',
];

/**
 * Tie-break comparator within a single tier. Returns negative when `a` wins.
 *
 * - For `waiting`: prefer the lower index in WAITING_PIPELINE_ORDER;
 *   unlisted gates sort after all listed gates and use `workflowIndex`
 *   for stable inter-unlisted ordering.
 * - For every other tier: prefer the lower `workflowIndex` (the position
 *   of the label in `WORKFLOW_LABELS`). Indexes of -1 sort last.
 */
export function compareSourceLabels(
  a: string,
  b: string,
  tier: CockpitState,
  workflowIndex: (label: string) => number,
): number {
  if (tier === 'waiting') {
    const ai = WAITING_PIPELINE_ORDER.indexOf(a);
    const bi = WAITING_PIPELINE_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      // At least one is in the pipeline order: listed gates win over unlisted.
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    // Neither listed: fall through to workflow-index comparison.
  }

  if (tier === 'error') {
    const ai = ERROR_PIPELINE_ORDER.indexOf(a);
    const bi = ERROR_PIPELINE_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    // Neither listed: fall through to workflow-index comparison.
  }

  if (tier === 'stage-complete') {
    const ai = STAGE_COMPLETE_PIPELINE_ORDER.indexOf(a);
    const bi = STAGE_COMPLETE_PIPELINE_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    // Neither listed: fall through to workflow-index comparison.
  }

  const aw = workflowIndex(a);
  const bw = workflowIndex(b);
  if (aw === -1 && bw === -1) return 0;
  if (aw === -1) return 1;
  if (bw === -1) return -1;
  return aw - bw;
}
