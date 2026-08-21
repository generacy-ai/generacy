/**
 * #1162 T003 — PrManager targeted staging filter (US1, FR-001/FR-002).
 *
 * The phase-completion commit path used to stage the whole working tree with an
 * unscoped `git add -A`, committing engine bookkeeping sidecars
 * (`.generacy/review-findings-*`, `review-candidate-*`, `pause-context-*`) into
 * product PR diffs. `commitAndPush` now stages only genuine product paths.
 *
 * Pins: sidecars are never staged/committed (SC-001); genuine product edits —
 * modify, add, delete — are still staged and committed (SC-004, G2); a
 * sidecar-only phase produces no commit at all (G3, no empty commits); and a
 * legitimately-tracked `.generacy/config.yaml` edit is staged and committed
 * (G4).
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

/**
 * Wires a GitHub stub whose downstream (post-stage) path resolves to
 * "committed, nothing unpushed" — no push guard, no ensureDraftPr — so each
 * test isolates the staging filter. `getStatus` returns the supplied status;
 * `commit` echoes the staged file list.
 */
function makeGithub(status: GitStatus) {
  const stageFiles = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn().mockResolvedValue({ sha: 'abc123', files_committed: [] });
  return {
    github: {
      getStatus: vi.fn().mockResolvedValue(status),
      stageFiles,
      commit,
      getCurrentBranch: vi.fn().mockResolvedValue('feature'),
      branchExists: vi.fn().mockResolvedValue(false),
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCommitsBetween: vi.fn().mockResolvedValue([]),
      push: vi.fn().mockResolvedValue({ success: true, ref: 'feature', remote: 'origin' }),
    } as unknown as GitHubClient,
    stageFiles,
    commit,
  };
}

function makeManager(github: GitHubClient): PrManager {
  return new PrManager(github, 'o', 'r', 42, mockLogger);
}

/** Drive the private commit/stage path directly. */
function commitAndPush(mgr: PrManager) {
  return (
    mgr as unknown as {
      commitAndPush: (phase: string, message?: string) => Promise<unknown>;
    }
  ).commitAndPush('implement');
}

describe('PrManager staging filter (#1162 FR-001)', () => {
  it('SC-001: never stages or commits engine sidecars in a mixed phase', async () => {
    const status = makeStatus({
      unstaged: [
        'packages/x/y.ts',
        '.generacy/review-findings-o_r_42.json',
        '.generacy/pause-context-o_r_42.json',
      ],
      untracked: ['.generacy/review-candidate-o_r_42.json', 'README.md'],
    });
    const { github, stageFiles, commit } = makeGithub(status);

    await commitAndPush(makeManager(github));

    expect(stageFiles).toHaveBeenCalledTimes(1);
    expect(stageFiles).toHaveBeenCalledWith(['packages/x/y.ts', 'README.md']);
    const staged = stageFiles.mock.calls[0][0] as string[];
    expect(staged).not.toContain('.generacy/review-findings-o_r_42.json');
    expect(staged).not.toContain('.generacy/review-candidate-o_r_42.json');
    expect(staged).not.toContain('.generacy/pause-context-o_r_42.json');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('SC-004 / G2: stages genuine product edits — modify, add, delete', async () => {
    // gh-cli reports deletions in `unstaged` (like `git add -A`); they must be
    // staged so the removal is committed.
    const status = makeStatus({
      unstaged: ['src/modified.ts', 'src/deleted.ts'],
      untracked: ['src/added.ts'],
    });
    const { github, stageFiles, commit } = makeGithub(status);

    await commitAndPush(makeManager(github));

    expect(stageFiles).toHaveBeenCalledWith([
      'src/modified.ts',
      'src/deleted.ts',
      'src/added.ts',
    ]);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('G3: a sidecar-only phase produces no stage call and no commit (no empty commits)', async () => {
    const status = makeStatus({
      unstaged: ['.generacy/review-findings-o_r_42.json'],
      untracked: ['.generacy/pause-context-o_r_42.json'],
    });
    const { github, stageFiles, commit } = makeGithub(status);

    await commitAndPush(makeManager(github));

    expect(stageFiles).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('G4: a tracked .generacy/config.yaml edit is staged and committed', async () => {
    const status = makeStatus({ unstaged: ['.generacy/config.yaml'] });
    const { github, stageFiles, commit } = makeGithub(status);

    await commitAndPush(makeManager(github));

    expect(stageFiles).toHaveBeenCalledWith(['.generacy/config.yaml']);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
