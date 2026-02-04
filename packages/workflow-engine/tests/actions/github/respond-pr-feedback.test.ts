/**
 * Tests for github.respond_pr_feedback action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RespondPRFeedbackAction } from '../../../src/actions/github/respond-pr-feedback.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  replyToPRComment: vi.fn(),
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
    uses: 'github.respond_pr_feedback',
    with: inputs,
  };
}

describe('RespondPRFeedbackAction', () => {
  let action: RespondPRFeedbackAction;

  beforeEach(() => {
    action = new RespondPRFeedbackAction();
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
    it('handles github.respond_pr_feedback action', () => {
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
    it('requires pr_number input', async () => {
      const step = createStep({ responses: [] });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'pr_number'");
    });

    it('requires responses input', async () => {
      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'responses'");
    });

    it('posts single response successfully', async () => {
      mockGitHubClient.replyToPRComment.mockResolvedValue({
        id: 456,
        body: 'Reply body',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        pr_number: 123,
        responses: [
          { comment_id: 100, body: 'Thank you for the review!' },
        ],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.replyToPRComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        123,
        100,
        'Thank you for the review!'
      );

      const output = result.output as Record<string, unknown>;
      const posted = output.posted as Array<Record<string, unknown>>;
      expect(posted.length).toBe(1);
      expect(posted[0].comment_id).toBe(100);
      expect(posted[0].reply_id).toBe(456);
      expect(posted[0].success).toBe(true);
    });

    it('posts multiple responses', async () => {
      mockGitHubClient.replyToPRComment
        .mockResolvedValueOnce({ id: 201, body: '', author: 'bot', created_at: '', updated_at: '' })
        .mockResolvedValueOnce({ id: 202, body: '', author: 'bot', created_at: '', updated_at: '' })
        .mockResolvedValueOnce({ id: 203, body: '', author: 'bot', created_at: '', updated_at: '' });

      const step = createStep({
        pr_number: 123,
        responses: [
          { comment_id: 1, body: 'Response 1' },
          { comment_id: 2, body: 'Response 2' },
          { comment_id: 3, body: 'Response 3' },
        ],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.replyToPRComment).toHaveBeenCalledTimes(3);

      const output = result.output as Record<string, unknown>;
      const posted = output.posted as Array<Record<string, unknown>>;
      expect(posted.length).toBe(3);
    });

    it('handles partial failures', async () => {
      mockGitHubClient.replyToPRComment
        .mockResolvedValueOnce({ id: 201, body: '', author: 'bot', created_at: '', updated_at: '' })
        .mockRejectedValueOnce(new Error('Comment not found'))
        .mockResolvedValueOnce({ id: 203, body: '', author: 'bot', created_at: '', updated_at: '' });

      const step = createStep({
        pr_number: 123,
        responses: [
          { comment_id: 1, body: 'Response 1' },
          { comment_id: 2, body: 'Response 2' },
          { comment_id: 3, body: 'Response 3' },
        ],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      // Action succeeds even with partial failures
      expect(result.success).toBe(true);

      const output = result.output as Record<string, unknown>;
      const posted = output.posted as Array<Record<string, unknown>>;
      const failed = output.failed as number[];

      expect(posted.length).toBe(2);
      expect(failed.length).toBe(1);
      expect(failed).toContain(2);
    });

    it('logs failures with warnings', async () => {
      mockGitHubClient.replyToPRComment.mockRejectedValue(new Error('API error'));

      const step = createStep({
        pr_number: 123,
        responses: [{ comment_id: 1, body: 'Response' }],
      });
      const context = createMockContext();

      await action.execute(step, context);

      expect(context.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to reply to comment 1')
      );
    });

    it('handles empty responses array', async () => {
      const step = createStep({
        pr_number: 123,
        responses: [],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.replyToPRComment).not.toHaveBeenCalled();

      const output = result.output as Record<string, unknown>;
      expect((output.posted as unknown[]).length).toBe(0);
      expect((output.failed as unknown[]).length).toBe(0);
    });
  });
});
