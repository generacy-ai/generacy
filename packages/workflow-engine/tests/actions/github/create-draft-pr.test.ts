/**
 * Tests for github.create_draft_pr action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CreateDraftPRAction } from '../../../src/actions/github/create-draft-pr.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  getCurrentBranch: vi.fn(),
  getDefaultBranch: vi.fn(),
  createPullRequest: vi.fn(),
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
    uses: 'github.create_draft_pr',
    with: inputs,
  };
}

describe('CreateDraftPRAction', () => {
  let action: CreateDraftPRAction;

  beforeEach(() => {
    action = new CreateDraftPRAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
    mockGitHubClient.getCurrentBranch.mockResolvedValue('feature-branch');
    mockGitHubClient.getDefaultBranch.mockResolvedValue('main');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.create_draft_pr action', () => {
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
    it('requires issue_number input', async () => {
      const step = createStep({ title: 'Test PR' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'issue_number'");
    });

    it('requires title input', async () => {
      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'title'");
    });

    it('creates draft PR with default body', async () => {
      mockGitHubClient.createPullRequest.mockResolvedValue({
        number: 456,
        title: 'Test PR',
        body: 'Closes #123',
        state: 'open',
        draft: true,
        head: { ref: 'feature-branch', sha: 'abc', repo: 'test-owner/test-repo' },
        base: { ref: 'main', sha: 'def', repo: 'test-owner/test-repo' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        title: 'Test PR',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.createPullRequest).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        expect.objectContaining({
          title: 'Test PR',
          head: 'feature-branch',
          base: 'main',
          draft: true,
        })
      );

      // Check body contains issue reference
      const callArgs = mockGitHubClient.createPullRequest.mock.calls[0][2];
      expect(callArgs.body).toContain('#123');

      const output = result.output as Record<string, unknown>;
      expect(output.pr_number).toBe(456);
      expect(output.state).toBe('draft');
    });

    it('uses custom body when provided', async () => {
      mockGitHubClient.createPullRequest.mockResolvedValue({
        number: 456,
        title: 'Test PR',
        body: 'Custom body',
        state: 'open',
        draft: true,
        head: { ref: 'feature-branch', sha: 'abc', repo: 'test-owner/test-repo' },
        base: { ref: 'main', sha: 'def', repo: 'test-owner/test-repo' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        title: 'Test PR',
        body: 'Custom body for this PR',
      });
      const context = createMockContext();

      await action.execute(step, context);

      const callArgs = mockGitHubClient.createPullRequest.mock.calls[0][2];
      expect(callArgs.body).toBe('Custom body for this PR');
    });

    it('uses custom base branch when provided', async () => {
      mockGitHubClient.createPullRequest.mockResolvedValue({
        number: 456,
        title: 'Test PR',
        body: '',
        state: 'open',
        draft: true,
        head: { ref: 'feature-branch', sha: 'abc', repo: 'test-owner/test-repo' },
        base: { ref: 'develop', sha: 'def', repo: 'test-owner/test-repo' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        title: 'Test PR',
        base_branch: 'develop',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const callArgs = mockGitHubClient.createPullRequest.mock.calls[0][2];
      expect(callArgs.base).toBe('develop');
    });

    it('returns PR URL in output', async () => {
      mockGitHubClient.createPullRequest.mockResolvedValue({
        number: 789,
        title: 'Test PR',
        body: '',
        state: 'open',
        draft: true,
        head: { ref: 'feature-branch', sha: 'abc', repo: 'test-owner/test-repo' },
        base: { ref: 'main', sha: 'def', repo: 'test-owner/test-repo' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        title: 'Test PR',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.pr_url).toBe('https://github.com/test-owner/test-repo/pull/789');
      expect(output.head_branch).toBe('feature-branch');
      expect(output.base_branch).toBe('main');
    });

    it('handles API errors', async () => {
      mockGitHubClient.createPullRequest.mockRejectedValue(
        new Error('A pull request already exists for feature-branch')
      );

      const step = createStep({
        issue_number: 123,
        title: 'Test PR',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });
});
