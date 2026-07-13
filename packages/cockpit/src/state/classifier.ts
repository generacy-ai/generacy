import type { CockpitState, ClassifyResult } from '../types.js';
import { mapLabelToState, workflowLabelIndex } from './label-map.js';
import { TIER_RANK, compareSourceLabels } from './precedence.js';

/**
 * Pure classifier: maps a set of label names to a single curated
 * { state, sourceLabel } pair. See contracts/classifier.md for spec.
 */
export function classify(labels: Iterable<string>): ClassifyResult {
  const seen = new Set<string>();
  const candidates: Array<{ label: string; state: CockpitState }> = [];

  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    const state = mapLabelToState(label);
    if (state === 'unknown') continue;
    candidates.push({ label, state });
  }

  if (candidates.length === 0) {
    return { state: 'unknown', sourceLabel: '' };
  }

  let winner = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const next = candidates[i]!;
    const winnerRank = TIER_RANK[winner.state];
    const nextRank = TIER_RANK[next.state];
    if (nextRank < winnerRank) {
      winner = next;
      continue;
    }
    if (nextRank > winnerRank) continue;
    // Same tier — apply tie-break comparator.
    const cmp = compareSourceLabels(next.label, winner.label, winner.state, workflowLabelIndex);
    if (cmp < 0) {
      winner = next;
    }
  }

  return { state: winner.state, sourceLabel: winner.label };
}
