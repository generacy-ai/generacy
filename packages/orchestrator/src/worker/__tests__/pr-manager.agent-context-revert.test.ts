/**
 * #1218 T008 — PrManager spec-stage agent-context exclude-and-revert (US1, SC-001/SC-004).
 *
 * At spec-stage phase completions (`specify`, `clarify`, `plan`, `tasks`) the
 * repo-root agent-context files (`EXCLUDED_EXACT_PATHS`: CLAUDE.md, AGENTS.md,
 * GEMINI.md, .github/copilot-instructions.md) are excluded from the commit and
 * reverted in the working tree via `GitHubClient.revertPaths`, with a warning
 * naming them. Implement-and-later phases are untouched. An exclusion-emptied
 * commit proceeds as a normal `no-changes` outcome (Q3). A revert failure is
 * non-fatal — the product commit and push still complete (D4).
 */
import { vi, describe, it, expect } from 'vitest';
import type { GitHubClient, GitStatus } from '@generacy-ai/workflow-engine';
import { PrManager } from '../pr-manager.js';
import type { Logger } from '../types.js';

function makeLogger() {
  const warn = vi.fn();
  const logger = {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  return { logger, warn };
}

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
 * Same isolation posture as `pr-manager.staging-filter.test.ts`: the post-stage
 * path resolves to "committed, nothing unpushed" so each test exercises only the
 * exclude-and-revert filter. `revertPaths` is a spy; its resolution is overridable.
 */
function makeGithub(status: GitStatus, revertPaths = vi.fn().mockResolvedValue(undefined)) {
  const stageFiles = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn().mockResolvedValue({ sha: 'abc123', files_committed: [] });
  return {
    github: {
      getStatus: vi.fn().mockResolvedValue(status),
      stageFiles,
      commit,
      revertPaths,
      getCurrentBranch: vi.fn().mockResolvedValue('feature'),
      branchExists: vi.fn().mockResolvedValue(false),
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCommitsBetween: vi.fn().mockResolvedValue([]),
      push: vi.fn().mockResolvedValue({ success: true, ref: 'feature', remote: 'origin' }),
    } as unknown as GitHubClient,
    stageFiles,
    commit,
    revertPaths,
  };
}

/** Drive the private commit/stage path directly for a given phase. */
function commitAndPush(mgr: PrManager, phase: string) {
  return (
    mgr as unknown as {
      commitAndPush: (phase: string, message?: string) => Promise<{ kind: string }>;
    }
  ).commitAndPush(phase);
}

describe('PrManager spec-stage agent-context revert (#1218)', () => {
  it('plan phase: dirty CLAUDE.md + stack.md stages only stack.md and reverts CLAUDE.md with a warning', async () => {
    const status = makeStatus({ unstaged: ['CLAUDE.md', 'specs/x/stack.md'] });
    const { github, stageFiles, commit, revertPaths } = makeGithub(status);
    const { logger, warn } = makeLogger();

    const outcome = await commitAndPush(new PrManager(github, 'o', 'r', 42, logger), 'plan');

    expect(stageFiles).toHaveBeenCalledWith(['specs/x/stack.md']);
    expect(commit).toHaveBeenCalledWith(expect.any(String), ['specs/x/stack.md']);
    expect(revertPaths).toHaveBeenCalledWith(['CLAUDE.md']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'plan', reverted: ['CLAUDE.md'] }),
      expect.stringMatching(/Reverted agent-context files/),
    );
    expect(outcome.kind).toBe('pushed');
  });

  it('excludes all four EXCLUDED_EXACT_PATHS across staged/unstaged/untracked', async () => {
    const status = makeStatus({
      staged: ['CLAUDE.md'],
      unstaged: ['AGENTS.md', 'src/product.ts'],
      untracked: ['GEMINI.md', '.github/copilot-instructions.md'],
    });
    const { github, stageFiles, commit, revertPaths } = makeGithub(status);
    const { logger } = makeLogger();

    await commitAndPush(new PrManager(github, 'o', 'r', 42, logger), 'plan');

    expect(stageFiles).toHaveBeenCalledWith(['src/product.ts']);
    expect(commit).toHaveBeenCalledWith(expect.any(String), ['src/product.ts']);
    const reverted = revertPaths.mock.calls[0][0] as string[];
    expect(new Set(reverted)).toEqual(
      new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md']),
    );
  });

  it.each(['specify', 'clarify', 'tasks'])(
    '%s phase is guarded identically to plan',
    async (phase) => {
      const status = makeStatus({ unstaged: ['CLAUDE.md', 'specs/x/spec.md'] });
      const { github, stageFiles, revertPaths } = makeGithub(status);
      const { logger } = makeLogger();

      await commitAndPush(new PrManager(github, 'o', 'r', 42, logger), phase);

      expect(stageFiles).toHaveBeenCalledWith(['specs/x/spec.md']);
      expect(revertPaths).toHaveBeenCalledWith(['CLAUDE.md']);
    },
  );

  it('implement phase: dirty CLAUDE.md is committed unchanged; revertPaths never called', async () => {
    const status = makeStatus({ unstaged: ['CLAUDE.md', 'src/product.ts'] });
    const { github, stageFiles, commit, revertPaths } = makeGithub(status);
    const { logger, warn } = makeLogger();

    await commitAndPush(new PrManager(github, 'o', 'r', 42, logger), 'implement');

    expect(stageFiles).toHaveBeenCalledWith(['CLAUDE.md', 'src/product.ts']);
    expect(commit).toHaveBeenCalledWith(expect.any(String), ['CLAUDE.md', 'src/product.ts']);
    expect(revertPaths).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/Reverted agent-context files/),
    );
  });

  it('exclusion-emptied commit: no stage/commit, revertPaths called, warn logged, outcome no-changes', async () => {
    const status = makeStatus({ unstaged: ['CLAUDE.md'], untracked: ['AGENTS.md'] });
    const { github, stageFiles, commit, revertPaths } = makeGithub(status);
    const { logger, warn } = makeLogger();

    const outcome = await commitAndPush(new PrManager(github, 'o', 'r', 42, logger), 'plan');

    expect(stageFiles).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    const reverted = revertPaths.mock.calls[0][0] as string[];
    expect(new Set(reverted)).toEqual(new Set(['CLAUDE.md', 'AGENTS.md']));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reverted: expect.arrayContaining(['CLAUDE.md', 'AGENTS.md']) }),
      expect.stringMatching(/Reverted agent-context files/),
    );
    expect(outcome.kind).toBe('no-changes');
  });

  it('revertPaths rejection is non-fatal: product commit still completes', async () => {
    const status = makeStatus({ unstaged: ['CLAUDE.md', 'src/product.ts'] });
    const revertPaths = vi.fn().mockRejectedValue(new Error('git checkout failed'));
    const { github, commit } = makeGithub(status, revertPaths);
    const { logger, warn } = makeLogger();

    const outcome = await commitAndPush(new PrManager(github, 'o', 'r', 42, logger), 'plan');

    expect(commit).toHaveBeenCalledWith(expect.any(String), ['src/product.ts']);
    expect(outcome.kind).toBe('pushed');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/git checkout failed/) }),
      expect.stringMatching(/Failed to revert agent-context files/),
    );
  });
});
