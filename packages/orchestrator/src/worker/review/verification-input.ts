import type { ReviewArtifact, ReviewFinding } from '../review-artifact.js';
import type { ReviewDelta } from './review-delta.js';

/**
 * Composed verification input (FR-003): the union of the computed delta and the
 * still-open findings.
 */
export interface VerificationInput {
  round: number;
  /** (a) the computed delta */
  deltaFiles: string[];
  /** (b) findings still `open` in the artifact */
  openFindings: ReviewFinding[];
}

/**
 * FR-003: compose the verification input from the delta and the artifact.
 *
 * ALL open findings are enumerated even if they fall outside the delta (Q2) —
 * the prompt lists them, but only delta-located ones are `resolved`-eligible
 * downstream in `advanceArtifact`. This function does not filter by delta.
 */
export function composeVerificationInput(
  delta: ReviewDelta,
  artifact: ReviewArtifact,
): VerificationInput {
  return {
    round: delta.round,
    deltaFiles: delta.files,
    openFindings: artifact.findings.filter((f) => f.status === 'open'),
  };
}
