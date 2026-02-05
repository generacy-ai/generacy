/**
 * Tests for github.commit_and_push action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommitAndPushAction } from '../../../src/actions/github/commit-and-push.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getStatus: vi.fn(),
  stageFiles: vi.fn(),
  stageAll: vi.fn(),
  commit: vi.fn(),
  getCurrentBranch: vi.fn(),
  push: vi.fn(),
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
    uses: 'github.commit_and_push',
    with: inputs,
  };
}

describe('CommitAndPushAction', () => {
  let action: CommitAndPushAction;

  beforeEach(() => {
    action = new CommitAndPushAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getCurrentBranch.mockResolvedValue('feature-branch');
    mockGitHubClient.push.mockResolvedValue({
      success: true,
      ref: 'feature-branch',
      remote: 'origin',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.commit_and_push action', () => {
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
    it('requires message input', async () => {
      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'message'");
    });

    it('requires issue_number input', async () => {
      const step = createStep({ message: 'Test commit' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'issue_number'");
    });

    it('returns early when no changes to commit', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: false,
        staged: [],
        unstaged: [],
        untracked: [],
      });

      const step = createStep({ message: 'Test commit', issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.pushed).toBe(false);
      expect(output.commit_sha).toBe('');
      expect(mockGitHubClient.commit).not.toHaveBeenCalled();
    });

    it('stages all changes when no files specified', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: [],
        unstaged: ['file.ts'],
        untracked: [],
      });
      mockGitHubClient.commit.mockResolvedValue({
        sha: 'abc123def456',
        files_committed: ['file.ts'],
      });

      const step = createStep({ message: 'Test commit', issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.stageAll).toHaveBeenCalled();
      expect(mockGitHubClient.stageFiles).not.toHaveBeenCalled();
    });

    it('stages specific files when files array provided', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: [],
        unstaged: ['file1.ts', 'file2.ts'],
        untracked: [],
      });
      mockGitHubClient.commit.mockResolvedValue({
        sha: 'abc123',
        files_committed: ['file1.ts'],
      });

      const step = createStep({
        message: 'Test commit',
        issue_number: 123,
        files: ['file1.ts'],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.stageFiles).toHaveBeenCalledWith(['file1.ts']);
      expect(mockGitHubClient.stageAll).not.toHaveBeenCalled();
    });

    it('appends issue reference to commit message', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.commit.mockResolvedValue({
        sha: 'abc123',
        files_committed: ['file.ts'],
      });

      const step = createStep({
        message: 'Add new feature',
        issue_number: 123,
      });
      const context = createMockContext();

      await action.execute(step, context);

      expect(mockGitHubClient.commit).toHaveBeenCalledWith('Add new feature (#123)');
    });

    it('preserves conventional commit format', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.commit.mockResolvedValue({
        sha: 'abc123',
        files_committed: ['file.ts'],
      });

      const step = createStep({
        message: 'feat: add new feature',
        issue_number: 123,
      });
      const context = createMockContext();

      await action.execute(step, context);

      expect(mockGitHubClient.commit).toHaveBeenCalledWith('feat: add new feature (#123)');
    });

    it('preserves conventional commit with scope', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.commit.mockResolvedValue({
        sha: 'abc123',
        files_committed: ['file.ts'],
      });

      const step = createStep({
        message: 'feat(api): add new endpoint',
        issue_number: 456,
      });
      const context = createMockContext();

      await action.execute(step, context);

      expect(mockGitHubClient.commit).toHaveBeenCalledWith('feat(api): add new endpoint (#456)');
    });

    it('does not duplicate issue reference', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.commit.mockResolvedValue({
        sha: 'abc123',
        files_committed: ['file.ts'],
      });

      const step = createStep({
        message: 'Fix bug for #123',
        issue_number: 123,
      });
      const context = createMockContext();

      await action.execute(step, context);

      expect(mockGitHubClient.commit).toHaveBeenCalledWith('Fix bug for #123');
    });

    it('pushes to remote after commit', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.commit.mockResolvedValue({
        sha: 'abc123def456',
        files_committed: ['file.ts'],
      });

      const step = createStep({ message: 'Test commit', issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.push).toHaveBeenCalledWith('origin', 'feature-branch', true);
      const output = result.output as Record<string, unknown>;
      expect(output.pushed).toBe(true);
      expect(output.commit_sha).toBe('abc123def456');
    });

    it('handles commit errors', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.commit.mockRejectedValue(new Error('Commit failed: pre-commit hook error'));

      const step = createStep({ message: 'Test commit', issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('pre-commit hook error');
    });

    it('handles push errors', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['file.ts'],
        unstaged: [],
        untracked: [],
      });
      mockGitHubClient.commit.mockResolvedValue({
        sha: 'abc123',
        files_committed: ['file.ts'],
      });
      mockGitHubClient.push.mockRejectedValue(new Error('Push failed: remote rejected'));

      const step = createStep({ message: 'Test commit', issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('remote rejected');
    });
  });
});
