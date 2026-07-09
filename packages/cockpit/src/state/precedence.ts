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
 * `address-pr-feedback`, `children-complete`, `epic-approval`,
 * `dependencies`, and `needs:*` labels also exist but fall back to
 * `WORKFLOW_LABELS` index when not listed here (see classifier).
 */
export const WAITING_PIPELINE_ORDER: string[] = [
  // #883: `blocked:stuck-feedback-loop` sorts ahead of every waiting-for:*
  // gate so cockpit surfaces the pause first when both labels coexist.
  'blocked:stuck-feedback-loop',
  'waiting-for:spec-review',
  'waiting-for:clarification',
  'waiting-for:plan-review',
  'waiting-for:tasks-review',
  'waiting-for:implementation-review',
  'waiting-for:manual-validation',
];

// Latest-phase-wins order for the `stage-complete` tier (FR-005).
// Reverse of pipeline: labels closer to workflow end come first so lower
// index wins the sourceLabel slot when multiple demoted completed:* co-occur.
export const STAGE_COMPLETE_PIPELINE_ORDER: string[] = [
  'completed:implementation-review',
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
