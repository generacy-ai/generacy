/**
 * #1125 T020 — PrManager draft/ready lifecycle (US3, FR-006).
 *
 * `convertToDraftIfEngineMarkedReady` demotes the PR back to draft on remediate
 * entry — but ONLY when the engine itself marked it ready. Pins: no-op when the
 * flag is false (never demote a human-marked-ready PR), convert + clear the flag
 * when true, best-effort on failure, and sibling coverage.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GitHubClient, LinkedPR } from '@generacy-ai/workflow-engine';
import { PrManager } from '../pr-manager.js';
import type { Logger } from '../types.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

function makeGithub(overrides: Partial<Record<keyof GitHubClient, unknown>> = {}) {
  return {
    markPRReady: vi.fn().mockResolvedValue(undefined),
    convertPullRequestToDraft: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

/** Set the private prNumber so the manager behaves as if a PR exists. */
function withPrNumber(mgr: PrManager, n: number): PrManager {
  (mgr as unknown as { prNumber: number }).prNumber = n;
  return mgr;
}

function makeManager(github: GitHubClient): PrManager {
  return new PrManager(github, 'o', 'r', 42, mockLogger);
}

describe('PrManager.convertToDraftIfEngineMarkedReady', () => {
  let github: GitHubClient;

  beforeEach(() => {
    github = makeGithub();
  });

  it('no-ops when the engine never marked the PR ready (never demotes a human-ready PR)', async () => {
    const mgr = withPrNumber(makeManager(github), 42);
    // No markReadyForReview call — flag stays false.

    await mgr.convertToDraftIfEngineMarkedReady();

    expect(github.convertPullRequestToDraft).not.toHaveBeenCalled();
  });

  it('no-ops when no PR number has been resolved yet', async () => {
    const mgr = makeManager(github); // prNumber undefined

    await mgr.convertToDraftIfEngineMarkedReady();

    expect(github.convertPullRequestToDraft).not.toHaveBeenCalled();
  });

  it('converts to draft after the engine marked it ready, then clears the flag', async () => {
    const mgr = withPrNumber(makeManager(github), 42);
    await mgr.markReadyForReview(); // sets markedReadyByEngine = true

    await mgr.convertToDraftIfEngineMarkedReady();

    expect(github.convertPullRequestToDraft).toHaveBeenCalledTimes(1);
    expect(github.convertPullRequestToDraft).toHaveBeenCalledWith('o', 'r', 42);

    // Flag cleared → a second remediate entry is a no-op.
    await mgr.convertToDraftIfEngineMarkedReady();
    expect(github.convertPullRequestToDraft).toHaveBeenCalledTimes(1);
  });

  it('is best-effort — a convert failure does not throw (FR-008)', async () => {
    github = makeGithub({ convertPullRequestToDraft: vi.fn().mockRejectedValue(new Error('boom')) });
    const mgr = withPrNumber(makeManager(github), 42);
    await mgr.markReadyForReview();

    await expect(mgr.convertToDraftIfEngineMarkedReady()).resolves.toBeUndefined();
  });

  it('converts linked sibling PRs too', async () => {
    const mgr = withPrNumber(makeManager(github), 42);
    await mgr.markReadyForReview();

    const linkedPRs: LinkedPR[] = [
      { url: 'https://github.com/o/sibling/pull/9' } as LinkedPR,
    ];

    await mgr.convertToDraftIfEngineMarkedReady(linkedPRs);

    expect(github.convertPullRequestToDraft).toHaveBeenCalledWith('o', 'r', 42);
    expect(github.convertPullRequestToDraft).toHaveBeenCalledWith('o', 'sibling', 9);
  });
});
