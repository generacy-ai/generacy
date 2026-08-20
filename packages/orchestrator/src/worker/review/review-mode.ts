import type { FindingsArtifact } from './findings-artifact.js';

/**
 * Review mode (FR-001).
 * - `full-review` (round 1): absent / round-0 / no-lastReviewedSha artifact.
 * - `verification` (round n+1): a prior review recorded a last-reviewed SHA.
 */
export type ReviewMode =
  | { kind: 'full-review'; round: 1 }
  | { kind: 'verification'; round: number };

/**
 * FR-001: determine whether this `review` entry is a first full review or a
 * verification pass over a prior review's artifact.
 *
 * Rule: `artifact` absent OR `artifact.round === 0` OR no `lastReviewedSha`
 * ⇒ `full-review` (round 1). Otherwise `verification` at `artifact.round + 1`.
 */
export function determineReviewMode(artifact?: FindingsArtifact | null): ReviewMode {
  if (artifact == null || artifact.round === 0 || artifact.lastReviewedSha == null) {
    return { kind: 'full-review', round: 1 };
  }
  return { kind: 'verification', round: artifact.round + 1 };
}
