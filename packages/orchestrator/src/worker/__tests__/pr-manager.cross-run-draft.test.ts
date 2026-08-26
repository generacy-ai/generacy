// #1156 T012 — cross-run draft conversion via the sidecar flag (FR-006/FR-007).
//
// A fresh PrManager (new process → in-memory markedReadyByEngine reset to false)
// must still convert the PR back to draft on remediate entry when a PRIOR run
// persisted markedReadyByEngine:true in the review sidecar (SC-005). Conversely,
// a sidecar flag of false (the PR was made ready by a human, never by the engine)
// must leave the PR untouched (SC-006, FR-007).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import { PrManager } from '../pr-manager.js';
import { writeReviewArtifact, type ReviewArtifact } from '../review-artifact.js';
import type { Logger } from '../types.js';

const WORKFLOW_ID = 'o/r#42';

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

function baseArtifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    findings: [],
    verdict: 'clean',
    round: 1,
    lastReviewedCommitSha: 'a1b2c3d4',
    remediationCount: 0,
    markedReadyByEngine: false,
    ...overrides,
  };
}

describe('#1156 PrManager cross-run draft conversion', () => {
  let checkoutPath: string;
  let github: GitHubClient;

  beforeEach(async () => {
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'cross-run-draft-'));
    github = makeGithub();
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('SC-005: fresh manager reconstructs markedReadyByEngine:true from the sidecar and converts to draft', async () => {
    // A PRIOR run marked the PR ready and persisted the flag.
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, baseArtifact({ markedReadyByEngine: true }));

    // Fresh manager — in-memory flag defaults to false.
    const mgr = withPrNumber(
      new PrManager(github, 'o', 'r', 42, mockLogger, checkoutPath, WORKFLOW_ID),
      42,
    );

    await mgr.convertToDraftIfEngineMarkedReady();

    expect(github.convertPullRequestToDraft).toHaveBeenCalledTimes(1);
    expect(github.convertPullRequestToDraft).toHaveBeenCalledWith('o', 'r', 42);
  });

  it('SC-006: sidecar markedReadyByEngine:false (human-marked-ready) leaves the PR untouched', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, baseArtifact({ markedReadyByEngine: false }));

    const mgr = withPrNumber(
      new PrManager(github, 'o', 'r', 42, mockLogger, checkoutPath, WORKFLOW_ID),
      42,
    );

    await mgr.convertToDraftIfEngineMarkedReady();

    expect(github.convertPullRequestToDraft).not.toHaveBeenCalled();
  });

  it('no-ops when no sidecar exists (nothing to reconstruct)', async () => {
    const mgr = withPrNumber(
      new PrManager(github, 'o', 'r', 42, mockLogger, checkoutPath, WORKFLOW_ID),
      42,
    );

    await mgr.convertToDraftIfEngineMarkedReady();

    expect(github.convertPullRequestToDraft).not.toHaveBeenCalled();
  });

  it('clears the sidecar flag after a successful convert (a second entry is a no-op)', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, baseArtifact({ markedReadyByEngine: true }));

    const mgr = withPrNumber(
      new PrManager(github, 'o', 'r', 42, mockLogger, checkoutPath, WORKFLOW_ID),
      42,
    );

    await mgr.convertToDraftIfEngineMarkedReady();
    expect(github.convertPullRequestToDraft).toHaveBeenCalledTimes(1);

    // A brand-new manager on the same checkout reads the now-cleared flag.
    const mgr2 = withPrNumber(
      new PrManager(github, 'o', 'r', 42, mockLogger, checkoutPath, WORKFLOW_ID),
      42,
    );
    await mgr2.convertToDraftIfEngineMarkedReady();
    expect(github.convertPullRequestToDraft).toHaveBeenCalledTimes(1);
  });
});
