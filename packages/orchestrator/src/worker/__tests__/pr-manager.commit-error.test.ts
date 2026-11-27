/**
 * #1239 FR-005 — PrManager surfaces staging/commit throws as a distinct
 * `commitError` outcome instead of swallowing them as a benign `no-changes`.
 *
 * Pins: a throw inside the getStatus → stageFiles → commit span yields
 * `commitError` on the CommitResult, `hasChanges: false`, and NEVER calls
 * `ensureDraftPr` (the phase produced no commit, so a PR must not be
 * opened/updated). A throw from the LATER push stays under the outer catch and
 * still collapses to the pre-existing non-fatal `no-changes` behavior.
 */
import { vi, describe, it, expect } from 'vitest';
import type { GitHubClient, GitStatus } from '@generacy-ai/workflow-engine';
import { PrManager } from '../pr-manager.js';
import type { Logger } from '../types.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'feature',
    has_changes: true,
    staged: [],
    unstaged: [],
    untracked: [],
    hasUnpushed: false,
    unpushedCount: 0,
    ...overrides,
  };
}

function makeGithub(overrides: Partial<Record<keyof GitHubClient, unknown>> = {}) {
  return {
    getStatus: vi.fn().mockResolvedValue(makeStatus({ unstaged: ['src/product.ts'] })),
    stageFiles: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ sha: 'abc', files_committed: ['src/product.ts'] }),
    getCurrentBranch: vi.fn().mockResolvedValue('feature'),
    branchExists: vi.fn().mockResolvedValue(false),
    getDefaultBranch: vi.fn().mockResolvedValue('develop'),
    getCommitsBetween: vi.fn().mockResolvedValue([]),
    push: vi.fn().mockResolvedValue({ success: true, ref: 'feature', remote: 'origin' }),
    findPRForBranchAnyState: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as GitHubClient;
}

function makeManager(github: GitHubClient): PrManager {
  return new PrManager(github, 'o', 'r', 42, mockLogger);
}

/** Drive the private commit/stage path directly. */
function commitAndPush(mgr: PrManager) {
  return (
    mgr as unknown as {
      commitAndPush: (phase: string, message?: string) => Promise<{ kind: string }>;
    }
  ).commitAndPush('implement');
}

describe('PrManager commit-error surfacing (#1239 FR-005)', () => {
  it('a throwing stageFiles yields commitError and does NOT call ensureDraftPr', async () => {
    const github = makeGithub({
      stageFiles: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    const mgr = makeManager(github);
    const ensureDraftPr = vi.spyOn(mgr as any, 'ensureDraftPr');

    const result = await mgr.commitPushAndEnsurePr('implement');

    expect(result.hasChanges).toBe(false);
    expect(result.commitError).toEqual({ message: 'disk full' });
    expect(result.pushRefused).toBeUndefined();
    expect(result.prUrl).toBeUndefined();
    expect(ensureDraftPr).not.toHaveBeenCalled();
  });

  it('a throwing commit yields commitError and does NOT call ensureDraftPr', async () => {
    const github = makeGithub({
      commit: vi.fn().mockRejectedValue(new Error('commit hook failed')),
    });
    const mgr = makeManager(github);
    const ensureDraftPr = vi.spyOn(mgr as any, 'ensureDraftPr');

    const result = await mgr.commitPushAndEnsurePr('implement');

    expect(result.commitError).toEqual({ message: 'commit hook failed' });
    expect(result.hasChanges).toBe(false);
    expect(ensureDraftPr).not.toHaveBeenCalled();
  });

  it('a throwing push stays under the outer catch and still yields non-fatal no-changes', async () => {
    // hasUnpushed must be true to reach the push call: the phase committed
    // directly, branch exists on the remote, and there is one unpushed commit.
    const github = makeGithub({
      getStatus: vi.fn().mockResolvedValue(makeStatus()),
      branchExists: vi.fn().mockResolvedValue(true),
      getCommitsBetween: vi.fn().mockResolvedValue([{ sha: 'deadbeef' }]),
      push: vi.fn().mockRejectedValue(new Error('network down')),
    });

    const outcome = await commitAndPush(makeManager(github));

    expect(outcome.kind).toBe('no-changes');
  });
});
