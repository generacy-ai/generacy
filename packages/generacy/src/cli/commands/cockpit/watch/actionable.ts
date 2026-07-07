import type { Snapshot } from './snapshot.js';

export const ACTIONABLE_EXACT_LABELS = new Set<string>([
  'completed:validate',
  'needs:intervention',
  'agent:error',
]);

const ACTIONABLE_PREFIXES = ['waiting-for:', 'failed:'] as const;

export function isActionableLabel(label: string): boolean {
  if (ACTIONABLE_EXACT_LABELS.has(label)) return true;
  return ACTIONABLE_PREFIXES.some((p) => label.startsWith(p));
}

/**
 * Scans raw `Snapshot.labels[]`, not `classified.state`: an issue carrying both
 * `completed:specify` and `waiting-for:clarification` is ranked terminal by the
 * classifier's tier precedence, and trusting `classified.state` would silently
 * skip the exact issues this sweep exists to surface (FR-011 / Q2).
 */
export function isActionableSnapshot(snap: Snapshot): boolean {
  if (snap.labels.some(isActionableLabel)) return true;
  if (snap.kind === 'pr' && snap.checksRollup === 'failure') return true;
  return false;
}
