import { describe, expect, it } from 'vitest';
import type { FindingsArtifact } from '../findings-artifact.js';
import { determineReviewMode } from '../review-mode.js';

describe('determineReviewMode (FR-001 / SC-001)', () => {
  it('absent artifact ⇒ full-review round 1', () => {
    expect(determineReviewMode(undefined)).toEqual({ kind: 'full-review', round: 1 });
    expect(determineReviewMode(null)).toEqual({ kind: 'full-review', round: 1 });
  });

  it('round 0 empty artifact ⇒ full-review round 1', () => {
    const artifact: FindingsArtifact = { round: 0, findings: [] };
    expect(determineReviewMode(artifact)).toEqual({ kind: 'full-review', round: 1 });
  });

  it('round 0 with no lastReviewedSha ⇒ full-review round 1', () => {
    const artifact: FindingsArtifact = { round: 0, findings: [], lastReviewedSha: undefined };
    expect(determineReviewMode(artifact)).toEqual({ kind: 'full-review', round: 1 });
  });

  it('non-zero round but missing lastReviewedSha ⇒ full-review round 1', () => {
    const artifact: FindingsArtifact = { round: 2, findings: [] };
    expect(determineReviewMode(artifact)).toEqual({ kind: 'full-review', round: 1 });
  });

  it('round 1 with lastReviewedSha ⇒ verification round 2', () => {
    const artifact: FindingsArtifact = { round: 1, findings: [], lastReviewedSha: 'abc' };
    expect(determineReviewMode(artifact)).toEqual({ kind: 'verification', round: 2 });
  });

  it('round 3 with lastReviewedSha ⇒ verification round 4', () => {
    const artifact: FindingsArtifact = { round: 3, findings: [], lastReviewedSha: 'def' };
    expect(determineReviewMode(artifact)).toEqual({ kind: 'verification', round: 4 });
  });
});
