import { describe, expect, it, vi } from 'vitest';
import type { ReviewArtifact } from '../../review-artifact.js';
import { computeReviewDelta, type ReviewDeltaGitHub } from '../review-delta.js';

function makeGithub(overrides: Partial<ReviewDeltaGitHub> = {}): ReviewDeltaGitHub {
  return {
    getFilesChangedBetween: vi.fn().mockResolvedValue(['src/a.ts']),
    getCurrentCommitSha: vi.fn().mockResolvedValue('HEAD_SHA'),
    commitExistsInCheckout: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

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

describe('computeReviewDelta (FR-002 / FR-007 / FR-009 / SC-001)', () => {
  it('selects last-reviewed base when commitExistsInCheckout is true', async () => {
    const github = makeGithub();

    const delta = await computeReviewDelta({ github, artifact: artifact(), prBaseRef: 'develop' });

    expect(delta.base).toEqual({ source: 'last-reviewed', base: 'LAST', head: 'HEAD_SHA' });
    expect(delta.round).toBe(2);
    expect(github.getFilesChangedBetween).toHaveBeenCalledWith('LAST', 'HEAD_SHA');
    expect(delta.files).toEqual(['src/a.ts']);
  });

  it('identical base/head ⇒ empty delta, no git call (SC-001)', async () => {
    const github = makeGithub({
      getCurrentCommitSha: vi.fn().mockResolvedValue('LAST'),
    });

    const delta = await computeReviewDelta({ github, artifact: artifact(), prBaseRef: 'develop' });

    expect(delta.base).toEqual({ source: 'last-reviewed', base: 'LAST', head: 'LAST' });
    expect(delta.files).toEqual([]);
    expect(github.getFilesChangedBetween).not.toHaveBeenCalled();
  });

  it('unresolvable lastReviewedCommitSha (commitExistsInCheckout false) ⇒ full-diff fallback', async () => {
    const github = makeGithub({
      commitExistsInCheckout: vi.fn().mockResolvedValue(false),
    });

    const delta = await computeReviewDelta({
      github,
      artifact: artifact({ round: 2, lastReviewedCommitSha: 'GONE' }),
      prBaseRef: 'develop',
    });

    expect(delta.base).toEqual({ source: 'full-diff', base: 'develop', head: 'HEAD_SHA' });
    expect(delta.round).toBe(3);
  });

  it('genuine git error from getFilesChangedBetween propagates', async () => {
    const github = makeGithub({
      getFilesChangedBetween: vi.fn().mockRejectedValue(new Error('fatal: bad revision')),
    });

    await expect(
      computeReviewDelta({ github, artifact: artifact(), prBaseRef: 'develop' }),
    ).rejects.toThrow('fatal: bad revision');
  });

  describe('resolution branch (FR-007, T014)', () => {
    it('pauseContext resolution SHAs take highest priority', async () => {
      const github = makeGithub();

      const delta = await computeReviewDelta({
        github,
        artifact: artifact(),
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

      const delta = await computeReviewDelta({
        github,
        artifact: artifact({ round: 2 }),
        pauseContext: { resolutionBaseSha: 'RBASE', resolutionHeadSha: 'RHEAD' },
        prBaseRef: 'develop',
      });

      expect(github.getFilesChangedBetween).toHaveBeenCalledWith('RBASE', 'RHEAD');
      expect(delta.files).toEqual(['src/resolved.ts']);
    });

    it('only one resolution SHA present ⇒ falls through to last-reviewed', async () => {
      const github = makeGithub();

      const delta = await computeReviewDelta({
        github,
        artifact: artifact(),
        pauseContext: { resolutionBaseSha: 'RBASE' },
        prBaseRef: 'develop',
      });

      expect(delta.base).toEqual({ source: 'last-reviewed', base: 'LAST', head: 'HEAD_SHA' });
    });
  });
});
