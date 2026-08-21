// #1156 T010 — ReviewPoster resolves the PR number live per call (FR-004, D-4).
//
// SC-003: when getPrNumber() returns undefined the poster is inert — no
// createReview / getPRReviewThreads / resolveReviewThread call fires, so it can
// never post to PR #0. When a real number is available every call targets it.
import { vi, describe, it, expect } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import { ReviewPoster } from '../review-poster.js';
import type { ReviewFinding } from '../review-artifact.js';
import type { Logger } from '../types.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

function makeGithub() {
  return {
    listReviews: vi.fn().mockResolvedValue([]),
    listPullRequestFiles: vi.fn().mockResolvedValue([]),
    createReview: vi.fn().mockResolvedValue(undefined),
    getPRReviewThreads: vi.fn().mockResolvedValue([]),
    resolveReviewThread: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;
}

const CLEAN: ReviewFinding[] = [];
const WITH_RESOLVED: ReviewFinding[] = [
  {
    id: 'm1',
    severity: 'critical',
    file: 'src/a.ts',
    title: 't',
    detail: 'd',
    round: 1,
    status: 'resolved',
  },
];

describe('#1156 ReviewPoster PR-number getter', () => {
  it('SC-003: postRound is inert when getPrNumber returns undefined (no PR #0 post)', async () => {
    const github = makeGithub();
    const poster = new ReviewPoster({
      github,
      owner: 'o',
      repo: 'r',
      getPrNumber: () => undefined,
      logger: mockLogger,
    });

    await poster.postRound(CLEAN, 1, 'critical');

    expect(github.listReviews).not.toHaveBeenCalled();
    expect(github.listPullRequestFiles).not.toHaveBeenCalled();
    expect(github.createReview).not.toHaveBeenCalled();
  });

  it('SC-003: resolveResolvedThreads is inert when getPrNumber returns undefined', async () => {
    const github = makeGithub();
    const poster = new ReviewPoster({
      github,
      owner: 'o',
      repo: 'r',
      getPrNumber: () => undefined,
      logger: mockLogger,
    });

    await poster.resolveResolvedThreads(WITH_RESOLVED);

    expect(github.getPRReviewThreads).not.toHaveBeenCalled();
    expect(github.resolveReviewThread).not.toHaveBeenCalled();
  });

  it('targets the live PR number returned by getPrNumber on postRound', async () => {
    const github = makeGithub();
    const poster = new ReviewPoster({
      github,
      owner: 'o',
      repo: 'r',
      getPrNumber: () => 42,
      logger: mockLogger,
    });

    await poster.postRound(CLEAN, 1, 'critical');

    expect(github.listReviews).toHaveBeenCalledWith('o', 'r', 42);
    expect(github.createReview).toHaveBeenCalledWith('o', 'r', 42, expect.anything());
  });

  it('re-resolves the PR number on each call (undefined then present)', async () => {
    const github = makeGithub();
    const prRef: { value: number | undefined } = { value: undefined };
    const poster = new ReviewPoster({
      github,
      owner: 'o',
      repo: 'r',
      getPrNumber: () => prRef.value,
      logger: mockLogger,
    });

    // First call: no PR yet — inert.
    await poster.postRound(CLEAN, 1, 'critical');
    expect(github.createReview).not.toHaveBeenCalled();

    // PR now exists — second call targets it.
    prRef.value = 9;
    await poster.postRound(CLEAN, 2, 'critical');
    expect(github.createReview).toHaveBeenCalledWith('o', 'r', 9, expect.anything());
  });
});
