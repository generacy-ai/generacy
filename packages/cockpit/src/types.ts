/**
 * Curated cockpit state — the union every consumer (UI, CLI, service) renders.
 *
 * Tier semantics (data-model.md §"Curated state"):
 *   terminal — closed / epic-approval merged / children complete
 *   error    — any `failed:*` or `agent:error`
 *   waiting  — any `waiting-for:*` or `needs:*`
 *   active   — `phase:*`, `agent:in-progress`, `agent:dispatched`
 *   pending  — type/process/workflow identity labels, `agent:paused`
 *   unknown  — label not in WORKFLOW_LABELS
 */
export const COCKPIT_STATES = [
  'pending',
  'active',
  'waiting',
  'error',
  'terminal',
  'stage-complete',
  'unknown',
] as const;

export type CockpitState = (typeof COCKPIT_STATES)[number];

export interface ClassifyResult {
  state: CockpitState;
  sourceLabel: string;
}
