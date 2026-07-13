import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';
import type { CockpitState } from '../types.js';

// Explicit terminal set for completed:* labels (#841). Every other completed:*
// falls through to 'stage-complete' — promotion to terminal requires editing
// this set, so silent mid-pipeline demotion of waiting-for:* is impossible.
const TERMINAL_COMPLETED_LABELS = new Set<string>([
  'completed:validate',
  'completed:epic-approval',
  'completed:children-complete',
]);

/**
 * Build-time-static lookup table mapping label name → curated CockpitState.
 *
 * Rules (plan.md §D2, #841):
 *   closed                                                         → terminal
 *   completed:* ∈ TERMINAL_COMPLETED_LABELS                        → terminal
 *   any other completed:*                                          → stage-complete
 *   failed:* / agent:error                                         → error
 *   waiting-for:* / needs:* / blocked:*                            → waiting
 *   phase:* / agent:in-progress / agent:dispatched                 → active
 *   agent:paused / type:* / process:* / workflow:* / epic-child    → pending
 *
 * Built once at module load by iterating WORKFLOW_LABELS, plus a special
 * `closed` entry that is not in WORKFLOW_LABELS but still classifies as
 * terminal (per plan.md §D2).
 */
function classifyByPattern(label: string): CockpitState {
  if (label === 'closed') return 'terminal';
  if (label.startsWith('completed:')) {
    return TERMINAL_COMPLETED_LABELS.has(label) ? 'terminal' : 'stage-complete';
  }
  if (label.startsWith('failed:') || label === 'agent:error') return 'error';
  if (
    label.startsWith('waiting-for:') ||
    label.startsWith('needs:') ||
    label.startsWith('blocked:')
  ) return 'waiting';
  if (label.startsWith('phase:') || label === 'agent:in-progress' || label === 'agent:dispatched') {
    return 'active';
  }
  if (
    label === 'agent:paused' ||
    label.startsWith('type:') ||
    label.startsWith('process:') ||
    label.startsWith('workflow:') ||
    label === 'epic-child'
  ) {
    return 'pending';
  }
  return 'unknown';
}

const LABEL_TO_STATE: Map<string, CockpitState> = (() => {
  const map = new Map<string, CockpitState>();
  for (const def of WORKFLOW_LABELS) {
    map.set(def.name, classifyByPattern(def.name));
  }
  // `closed` is not in WORKFLOW_LABELS but is a curated terminal state.
  map.set('closed', 'terminal');
  return map;
})();

/**
 * Returns the curated CockpitState for a label name, or 'unknown' when the
 * label is not in WORKFLOW_LABELS (and is not the special `closed` label).
 */
export function mapLabelToState(label: string): CockpitState {
  return LABEL_TO_STATE.get(label) ?? 'unknown';
}

/**
 * Returns the index of a label in WORKFLOW_LABELS for tie-break ordering.
 * Returns -1 when the label is not in the canonical list.
 */
const WORKFLOW_LABEL_INDEX: Map<string, number> = (() => {
  const map = new Map<string, number>();
  WORKFLOW_LABELS.forEach((def, i) => {
    map.set(def.name, i);
  });
  return map;
})();

export function workflowLabelIndex(label: string): number {
  return WORKFLOW_LABEL_INDEX.get(label) ?? -1;
}
