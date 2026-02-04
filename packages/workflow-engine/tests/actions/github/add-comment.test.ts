/**
 * Tests for github.add_comment action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AddCommentAction } from '../../../src/actions/github/add-comment.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  addIssueComment: vi.fn(),
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
    uses: 'github.add_comment',
    with: inputs,
  };
}

describe('AddCommentAction', () => {
  let action: AddCommentAction;

  beforeEach(() => {
    action = new AddCommentAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.add_comment action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'github.read_pr_feedback',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('requires issue_number input', async () => {
      const step = createStep({ body: 'Test comment' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'issue_number'");
    });

    it('requires body input', async () => {
      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'body'");
    });

    it('adds comment to issue successfully', async () => {
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 456789,
        body: 'Test comment body',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        body: 'Test comment body',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.addIssueComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        123,
        'Test comment body'
      );

      const output = result.output as Record<string, unknown>;
      expect(output.comment_id).toBe(456789);
      expect(output.comment_url).toBe(
        'https://github.com/test-owner/test-repo/issues/123#issuecomment-456789'
      );
    });

    it('adds comment with markdown content', async () => {
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 789,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const markdownBody = `## Status Update

### Completed
- [x] Task 1
- [x] Task 2

### In Progress
- [ ] Task 3
`;

      const step = createStep({
        issue_number: 456,
        body: markdownBody,
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.addIssueComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        456,
        markdownBody
      );
    });

    it('accepts optional phase parameter', async () => {
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 111,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        body: 'Phase update',
        phase: 'implement',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      // Phase is accepted but not currently used in the comment body
      // (could be used for labeling or categorization later)
      expect(result.success).toBe(true);
    });

    it('handles issue not found error', async () => {
      mockGitHubClient.addIssueComment.mockRejectedValue(
        new Error('Issue not found')
      );

      const step = createStep({
        issue_number: 999,
        body: 'Comment on non-existent issue',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('handles rate limit error', async () => {
      mockGitHubClient.addIssueComment.mockRejectedValue(
        new Error('API rate limit exceeded')
      );

      const step = createStep({
        issue_number: 123,
        body: 'Test comment',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limit');
    });
  });
});
