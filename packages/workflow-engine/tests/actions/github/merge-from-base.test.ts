/**
 * Tests for github.merge_from_base action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MergeFromBaseAction } from '../../../src/actions/github/merge-from-base.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getStatus: vi.fn(),
  stash: vi.fn(),
  stashPop: vi.fn(),
  fetch: vi.fn(),
  getCurrentBranch: vi.fn(),
  branchExists: vi.fn(),
  getDefaultBranch: vi.fn(),
  merge: vi.fn(),
  mergeAbort: vi.fn(),
};

// Helper to create mock context
function createMockContext(inputs: Record<string, unknown> = {}): ActionContext {
  return {
    workdir: '/test/workdir',
    inputs,
    outputs: {},
    env: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    signal: new AbortController().signal,
    refs: {},
  };
}

// Helper to create step definition
function createStep(inputs: Record<string, unknown> = {}): StepDefinition {
  return {
    name: 'test-step',
    uses: 'github.merge_from_base',
    with: inputs,
  };
}

describe('MergeFromBaseAction', () => {
  let action: MergeFromBaseAction;

  beforeEach(() => {
    action = new MergeFromBaseAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getStatus.mockResolvedValue({
      branch: 'feature-branch',
      has_changes: false,
      staged: [],
      unstaged: [],
      untracked: [],
    });
    mockGitHubClient.fetch.mockResolvedValue(undefined);
    mockGitHubClient.getCurrentBranch.mockResolvedValue('feature-branch');
    mockGitHubClient.getDefaultBranch.mockResolvedValue('main');
    mockGitHubClient.branchExists.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.merge_from_base action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'github.preflight',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('merges from default branch successfully', async () => {
      mockGitHubClient.merge.mockResolvedValue({
        success: true,
        commits_merged: 3,
        already_up_to_date: false,
        conflicts: [],
        summary: 'Merged 3 commits from origin/main',
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.base_branch).toBe('main');
      expect(output.commits_merged).toBe(3);
      expect(output.already_up_to_date).toBe(false);
      expect(mockGitHubClient.merge).toHaveBeenCalledWith('origin/main');
    });

    it('reports already up to date', async () => {
      mockGitHubClient.merge.mockResolvedValue({
        success: true,
        commits_merged: 0,
        already_up_to_date: true,
        conflicts: [],
        summary: 'Already up to date',
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.already_up_to_date).toBe(true);
      expect(output.commits_merged).toBe(0);
    });

    it('stashes uncommitted changes before merge', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.stash.mockResolvedValue(true);
      mockGitHubClient.stashPop.mockResolvedValue({ success: true, conflicts: false });
      mockGitHubClient.merge.mockResolvedValue({
        success: true,
        commits_merged: 1,
        already_up_to_date: false,
        conflicts: [],
        summary: 'Merged 1 commit',
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.stash).toHaveBeenCalledWith('autodev: pre-merge stash');
      expect(mockGitHubClient.stashPop).toHaveBeenCalled();
      const output = result.output as Record<string, unknown>;
      expect(output.stash_created).toBe(true);
    });

    it('merges from epic branch when parent_epic_number provided', async () => {
      mockGitHubClient.branchExists.mockResolvedValue(true);
      mockGitHubClient.merge.mockResolvedValue({
        success: true,
        commits_merged: 2,
        already_up_to_date: false,
        conflicts: [],
        summary: 'Merged from epic branch',
      });

      const step = createStep({ parent_epic_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.merged_from_epic).toBe(true);
      expect(mockGitHubClient.branchExists).toHaveBeenCalledWith('123-', true);
    });

    it('falls back to default branch when epic branch not found', async () => {
      mockGitHubClient.branchExists.mockResolvedValue(false);
      mockGitHubClient.merge.mockResolvedValue({
        success: true,
        commits_merged: 1,
        already_up_to_date: false,
        conflicts: [],
        summary: 'Merged from main',
      });

      const step = createStep({ parent_epic_number: 999 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.merged_from_epic).toBe(false);
      expect(output.base_branch).toBe('main');
    });

    it('returns conflicts for agent resolution', async () => {
      mockGitHubClient.merge.mockResolvedValue({
        success: false,
        commits_merged: 0,
        already_up_to_date: false,
        conflicts: [
          { path: 'src/file1.ts', ours: 'content1', theirs: 'content2' },
          { path: 'src/file2.ts', ours: 'content3', theirs: 'content4' },
        ],
        summary: 'Merge conflict',
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('2 conflict(s)');
      const output = result.output as Record<string, unknown>;
      const conflicts = output.conflicts_remaining as unknown[];
      expect(conflicts.length).toBe(2);
    });

    it('aborts merge when abort_on_conflict is true', async () => {
      mockGitHubClient.merge.mockResolvedValue({
        success: false,
        commits_merged: 0,
        already_up_to_date: false,
        conflicts: [{ path: 'src/file.ts', ours: 'a', theirs: 'b' }],
        summary: 'Merge conflict',
      });

      const step = createStep({ abort_on_conflict: true });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Aborted');
      expect(mockGitHubClient.mergeAbort).toHaveBeenCalled();
    });

    it('restores stash after abort', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.stash.mockResolvedValue(true);
      mockGitHubClient.stashPop.mockResolvedValue({ success: true, conflicts: false });
      mockGitHubClient.merge.mockResolvedValue({
        success: false,
        commits_merged: 0,
        already_up_to_date: false,
        conflicts: [{ path: 'file.ts', ours: 'a', theirs: 'b' }],
        summary: 'Conflict',
      });

      const step = createStep({ abort_on_conflict: true });
      const context = createMockContext();

      await action.execute(step, context);

      expect(mockGitHubClient.mergeAbort).toHaveBeenCalled();
      expect(mockGitHubClient.stashPop).toHaveBeenCalled();
    });

    it('fetches before merge', async () => {
      mockGitHubClient.merge.mockResolvedValue({
        success: true,
        commits_merged: 0,
        already_up_to_date: true,
        conflicts: [],
        summary: 'Up to date',
      });

      const step = createStep();
      const context = createMockContext();

      await action.execute(step, context);

      expect(mockGitHubClient.fetch).toHaveBeenCalledWith('origin', true);
    });

    it('handles fetch errors', async () => {
      mockGitHubClient.fetch.mockRejectedValue(new Error('Network error'));

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('warns on stash pop conflicts', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.stash.mockResolvedValue(true);
      mockGitHubClient.stashPop.mockResolvedValue({ success: false, conflicts: true });
      mockGitHubClient.merge.mockResolvedValue({
        success: true,
        commits_merged: 1,
        already_up_to_date: false,
        conflicts: [],
        summary: 'Merged',
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(context.logger.warn).toHaveBeenCalledWith('Stash pop resulted in conflicts');
    });
  });
});
