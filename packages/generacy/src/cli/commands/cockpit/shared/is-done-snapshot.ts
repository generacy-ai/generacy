import type { Snapshot } from '../watch/snapshot.js';

/**
 * Issue state: closed dominates any label-derived actionability tier.
 *
 * A closed issue carrying `completed:validate` (or any other actionable-label
 * residue) is done, not actionable. This helper is the single decision
 * surface: both `isActionableSnapshot` (watch) and the status renderer route
 * through it. If you need to expand actionability tiers, extend
 * `isActionableSnapshot` — do not add a second done-gate.
 *
 * The predicate reads raw `snap.state`, NOT `snap.classified.state`. The
 * classified `'terminal'` tier is exactly the label residue this fix stops
 * trusting; reading it would perpetuate the bug pattern (#873).
 */
export function isDoneSnapshot(snap: Snapshot): boolean {
  return snap.state === 'CLOSED';
}
