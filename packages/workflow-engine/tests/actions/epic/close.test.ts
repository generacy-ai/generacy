/**
 * Tests for epic.close action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloseEpicAction } from '../../../src/actions/epic/close.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  listBranches: vi.fn(),
  getPRForBranch: vi.fn(),
  addIssueComment: vi.fn(),
  updateIssue: vi.fn(),
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
    uses: 'epic.close',
    with: inputs,
  };
}

describe('CloseEpicAction', () => {
  let action: CloseEpicAction;

  beforeEach(() => {
    action = new CloseEpicAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
    mockGitHubClient.updateIssue.mockResolvedValue(undefined);
    mockGitHubClient.addIssueComment.mockResolvedValue({
      id: 999,
      body: '',
      author: 'bot',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles epic.close action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'epic.create_pr',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('requires epic_issue_number input', async () => {
      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'epic_issue_number'");
    });

    it('closes epic issue with comment', async () => {
      const step = createStep({
        epic_issue_number: 123,
        pr_number: 456,
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);

      // Should add completion comment
      expect(mockGitHubClient.addIssueComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        123,
        expect.stringContaining('Epic Completed')
      );

      // Comment should mention PR
      const commentCall = mockGitHubClient.addIssueComment.mock.calls[0];
      expect(commentCall[3]).toContain('#456');

      // Should close issue
      expect(mockGitHubClient.updateIssue).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        123,
        { state: 'closed' }
      );

      const output = result.output as Record<string, unknown>;
      expect(output.closed).toBe(true);
      expect(output.issue_url).toContain('123');
    });

    it('auto-detects merged PR when pr_number not provided', async () => {
      mockGitHubClient.listBranches.mockResolvedValue(['main', '123-epic-branch']);
      mockGitHubClient.getPRForBranch.mockResolvedValue({
        number: 789,
        title: 'Epic PR',
        body: '',
        state: 'merged',
        draft: false,
        head: { ref: '123-epic-branch', sha: 'abc', repo: 'test-owner/test-repo' },
        base: { ref: 'main', sha: 'def', repo: 'test-owner/test-repo' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);

      // Comment should mention auto-detected PR
      const commentCall = mockGitHubClient.addIssueComment.mock.calls[0];
      expect(commentCall[3]).toContain('#789');
    });

    it('closes without PR reference when not found', async () => {
      mockGitHubClient.listBranches.mockResolvedValue(['main', 'other-branch']);

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);

      // Comment should not contain PR reference
      const commentCall = mockGitHubClient.addIssueComment.mock.calls[0];
      expect(commentCall[3]).not.toContain('Merged via');

      // Should still close the issue
      expect(mockGitHubClient.updateIssue).toHaveBeenCalled();
    });

    it('handles close failure', async () => {
      mockGitHubClient.updateIssue.mockRejectedValue(new Error('Issue not found'));

      const step = createStep({
        epic_issue_number: 999,
        pr_number: 456,
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Issue not found');
    });
  });
});
