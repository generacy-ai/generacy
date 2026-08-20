import { describe, expect, it, vi } from 'vitest';
import type { FindingsArtifact } from '../findings-artifact.js';
import { computeReviewDelta, type ReviewDeltaGitHub } from '../review-delta.js';

function makeGithub(overrides: Partial<ReviewDeltaGitHub> = {}): ReviewDeltaGitHub {
  return {
    getFilesChangedBetween: vi.fn().mockResolvedValue(['src/a.ts']),
    getCurrentCommitSha: vi.fn().mockResolvedValue('HEAD_SHA'),
    commitExistsInCheckout: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('computeReviewDelta (FR-002 / FR-007 / FR-009 / SC-001)', () => {
  it('selects last-reviewed base when commitExistsInCheckout is true', async () => {
    const github = makeGithub();
    const artifact: FindingsArtifact = {
      round: 1,
      findings: [],
      lastReviewedSha: 'LAST',
    };

    const delta = await computeReviewDelta({ github, artifact, prBaseRef: 'develop' });

    expect(delta.base).toEqual({ source: 'last-reviewed', base: 'LAST', head: 'HEAD_SHA' });
    expect(delta.round).toBe(2);
    expect(github.getFilesChangedBetween).toHaveBeenCalledWith('LAST', 'HEAD_SHA');
    expect(delta.files).toEqual(['src/a.ts']);
  });

  it('identical base/head ⇒ empty delta, no git call (SC-001)', async () => {
    const github = makeGithub({
      getCurrentCommitSha: vi.fn().mockResolvedValue('LAST'),
    });
    const artifact: FindingsArtifact = { round: 1, findings: [], lastReviewedSha: 'LAST' };

    const delta = await computeReviewDelta({ github, artifact, prBaseRef: 'develop' });

    expect(delta.base).toEqual({ source: 'last-reviewed', base: 'LAST', head: 'LAST' });
    expect(delta.files).toEqual([]);
    expect(github.getFilesChangedBetween).not.toHaveBeenCalled();
  });

  it('missing lastReviewedSha ⇒ full-diff fallback, round still artifact.round + 1', async () => {
    const github = makeGithub();
    const artifact: FindingsArtifact = { round: 3, findings: [] };

    const delta = await computeReviewDelta({ github, artifact, prBaseRef: 'develop' });

    expect(delta.base).toEqual({ source: 'full-diff', base: 'develop', head: 'HEAD_SHA' });
    expect(delta.round).toBe(4);
    expect(github.commitExistsInCheckout).not.toHaveBeenCalled();
  });

  it('unresolvable lastReviewedSha (commitExistsInCheckout false) ⇒ full-diff fallback', async () => {
    const github = makeGithub({
      commitExistsInCheckout: vi.fn().mockResolvedValue(false),
    });
    const artifact: FindingsArtifact = { round: 2, findings: [], lastReviewedSha: 'GONE' };

    const delta = await computeReviewDelta({ github, artifact, prBaseRef: 'develop' });

    expect(delta.base).toEqual({ source: 'full-diff', base: 'develop', head: 'HEAD_SHA' });
    expect(delta.round).toBe(3);
  });

  it('genuine git error from getFilesChangedBetween propagates', async () => {
    const github = makeGithub({
      getFilesChangedBetween: vi.fn().mockRejectedValue(new Error('fatal: bad revision')),
    });
    const artifact: FindingsArtifact = { round: 1, findings: [], lastReviewedSha: 'LAST' };

    await expect(
      computeReviewDelta({ github, artifact, prBaseRef: 'develop' }),
    ).rejects.toThrow('fatal: bad revision');
  });

  describe('resolution branch (FR-007, T014)', () => {
    it('pauseContext resolution SHAs take highest priority', async () => {
      const github = makeGithub();
      const artifact: FindingsArtifact = {
        round: 1,
        findings: [],
        lastReviewedSha: 'LAST',
      };

      const delta = await computeReviewDelta({
        github,
        artifact,
        pauseContext: { resolutionBaseSha: 'RBASE', resolutionHeadSha: 'RHEAD' },
        prBaseRef: 'develop',
      });

      expect(delta.base).toEqual({ source: 'resolution', base: 'RBASE', head: 'RHEAD' });
      expect(delta.round).toBe(2);
      // last-reviewed path never consulted
      expect(github.commitExistsInCheckout).not.toHaveBeenCalled();
      expect(github.getCurrentCommitSha).not.toHaveBeenCalled();
    });

    it('resolution delta excludes files untouched by the resolution', async () => {
      const github = makeGithub({
        getFilesChangedBetween: vi.fn().mockResolvedValue(['src/resolved.ts']),
      });
      const artifact: FindingsArtifact = { round: 2, findings: [], lastReviewedSha: 'LAST' };

      const delta = await computeReviewDelta({
        github,
        artifact,
        pauseContext: { resolutionBaseSha: 'RBASE', resolutionHeadSha: 'RHEAD' },
        prBaseRef: 'develop',
      });

      expect(github.getFilesChangedBetween).toHaveBeenCalledWith('RBASE', 'RHEAD');
      expect(delta.files).toEqual(['src/resolved.ts']);
    });

    it('only one resolution SHA present ⇒ falls through to last-reviewed', async () => {
      const github = makeGithub();
      const artifact: FindingsArtifact = { round: 1, findings: [], lastReviewedSha: 'LAST' };

      const delta = await computeReviewDelta({
        github,
        artifact,
        pauseContext: { resolutionBaseSha: 'RBASE' },
        prBaseRef: 'develop',
      });

      expect(delta.base).toEqual({ source: 'last-reviewed', base: 'LAST', head: 'HEAD_SHA' });
    });
  });
});
