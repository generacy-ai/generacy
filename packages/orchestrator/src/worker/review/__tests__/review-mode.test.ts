import { describe, expect, it } from 'vitest';
import type { ReviewArtifact } from '../../review-artifact.js';
import { determineReviewMode } from '../review-mode.js';

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    findings: [],
    verdict: 'changes-required',
    round: 1,
    lastReviewedCommitSha: 'LAST',
    remediationCount: 0,
    markedReadyByEngine: false,
    ...overrides,
  };
}

describe('determineReviewMode (FR-001 / SC-001)', () => {
  it('absent artifact ⇒ full-review round 1', () => {
    expect(determineReviewMode(undefined)).toEqual({ kind: 'full-review', round: 1 });
    expect(determineReviewMode(null)).toEqual({ kind: 'full-review', round: 1 });
  });

  it('round 0 artifact ⇒ full-review round 1', () => {
    expect(determineReviewMode(artifact({ round: 0 }))).toEqual({ kind: 'full-review', round: 1 });
  });

  it('non-zero round but missing lastReviewedCommitSha ⇒ full-review round 1', () => {
    const noSha = artifact({ round: 2 });
    // The schema requires the field, but the function is defensive against a
    // missing value; simulate a pre-stamp artifact.
    (noSha as { lastReviewedCommitSha?: string }).lastReviewedCommitSha = undefined;
    expect(determineReviewMode(noSha)).toEqual({ kind: 'full-review', round: 1 });
  });

  it('round 1 with lastReviewedCommitSha ⇒ verification round 2', () => {
    expect(determineReviewMode(artifact({ round: 1, lastReviewedCommitSha: 'abc' }))).toEqual({
      kind: 'verification',
      round: 2,
    });
  });

  it('round 3 with lastReviewedCommitSha ⇒ verification round 4', () => {
    expect(determineReviewMode(artifact({ round: 3, lastReviewedCommitSha: 'def' }))).toEqual({
      kind: 'verification',
      round: 4,
    });
  });
});
