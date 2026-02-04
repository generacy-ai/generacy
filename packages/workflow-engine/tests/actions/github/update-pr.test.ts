/**
 * Tests for github.update_pr action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdatePRAction } from '../../../src/actions/github/update-pr.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  getCurrentBranch: vi.fn(),
  findPRForBranch: vi.fn(),
  updatePullRequest: vi.fn(),
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
    uses: 'github.update_pr',
    with: inputs,
  };
}

describe('UpdatePRAction', () => {
  let action: UpdatePRAction;

  beforeEach(() => {
    action = new UpdatePRAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
    mockGitHubClient.getCurrentBranch.mockResolvedValue('feature-branch');
    mockGitHubClient.updatePullRequest.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.update_pr action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'github.create_draft_pr',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('finds PR by branch when pr_number not provided', async () => {
      mockGitHubClient.findPRForBranch.mockResolvedValue({
        number: 123,
        title: 'Existing PR',
        body: '',
        state: 'open',
        draft: false,
        head: { ref: 'feature-branch', sha: 'abc', repo: 'test-owner/test-repo' },
        base: { ref: 'main', sha: 'def', repo: 'test-owner/test-repo' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({ title: 'Updated Title' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.findPRForBranch).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        'feature-branch'
      );
      const output = result.output as Record<string, unknown>;
      expect(output.pr_number).toBe(123);
    });

    it('returns error when no PR found for branch', async () => {
      mockGitHubClient.findPRForBranch.mockResolvedValue(null);

      const step = createStep({ title: 'Updated Title' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No PR found');
    });

    it('updates PR title', async () => {
      mockGitHubClient.findPRForBranch.mockResolvedValue({
        number: 123,
        title: 'Old Title',
        body: '',
        state: 'open',
        draft: false,
        head: { ref: 'feature-branch', sha: 'abc', repo: 'test-owner/test-repo' },
        base: { ref: 'main', sha: 'def', repo: 'test-owner/test-repo' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({ title: 'New Title' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updatePullRequest).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        123,
        { title: 'New Title' }
      );
      const output = result.output as Record<string, unknown>;
      expect(output.updated).toBe(true);
    });

    it('updates PR body', async () => {
      const step = createStep({
        pr_number: 456,
        body: 'New body content',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updatePullRequest).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        456,
        { body: 'New body content' }
      );
    });

    it('updates both title and body', async () => {
      const step = createStep({
        pr_number: 789,
        title: 'New Title',
        body: 'New Body',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updatePullRequest).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        789,
        { title: 'New Title', body: 'New Body' }
      );
    });

    it('returns updated=false when no updates provided', async () => {
      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updatePullRequest).not.toHaveBeenCalled();
      const output = result.output as Record<string, unknown>;
      expect(output.updated).toBe(false);
    });

    it('handles API errors', async () => {
      mockGitHubClient.updatePullRequest.mockRejectedValue(
        new Error('Pull request not found')
      );

      const step = createStep({
        pr_number: 999,
        title: 'New Title',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
