/**
 * Tests for github.read_pr_feedback action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReadPRFeedbackAction } from '../../../src/actions/github/read-pr-feedback.js';
import type { ActionContext, StepDefinition, Comment } from '../../../src/types/index.js';
import type { ReviewThread } from '../../../src/types/github.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  getPRReviewThreads: vi.fn(),
};

// Helper to create mock context
function createMockContext(inputs: Record<string, unknown> = {}): ActionContext {
  return {
    workdir: '/test/workdir',
    siblingWorkdirs: {},
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
    uses: 'github.read_pr_feedback',
    with: inputs,
  };
}

// Helper: mock comment with a trusted author_association tier (matches #842).
function createMockComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    body: 'Test comment',
    author: 'reviewer',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    authorAssociation: 'MEMBER',
    ...overrides,
  };
}

// Helper: mock review thread (#861 shape, #883: id required)
function createMockThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  const comments = overrides.comments ?? [createMockComment({ id: overrides.rootCommentId ?? 1 })];
  return {
    id: overrides.id ?? `PRRT_${overrides.rootCommentId ?? comments[0]!.id}`,
    rootCommentId: overrides.rootCommentId ?? comments[0]!.id,
    isResolved: overrides.isResolved ?? false,
    comments,
  };
}

describe('ReadPRFeedbackAction', () => {
  let action: ReadPRFeedbackAction;

  beforeEach(() => {
    action = new ReadPRFeedbackAction();
    vi.clearAllMocks();

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
    it('handles github.read_pr_feedback action', () => {
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
    it('requires pr_number input', async () => {
      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'pr_number'");
    });

    it('returns empty comments when no threads exist', async () => {
      mockGitHubClient.getPRReviewThreads.mockResolvedValue([]);

      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.comments).toEqual([]);
      expect(output.has_unresolved).toBe(false);
      expect(output.unresolved_count).toBe(0);
    });

    it('filters out comments from resolved threads by default', async () => {
      mockGitHubClient.getPRReviewThreads.mockResolvedValue([
        createMockThread({
          rootCommentId: 1,
          isResolved: false,
          comments: [createMockComment({ id: 1 })],
        }),
        createMockThread({
          rootCommentId: 2,
          isResolved: true,
          comments: [createMockComment({ id: 2 })],
        }),
        createMockThread({
          rootCommentId: 3,
          isResolved: false,
          comments: [createMockComment({ id: 3 })],
        }),
      ]);

      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const comments = output.comments as Comment[];
      expect(comments.length).toBe(2);
      expect(comments.map(c => c.id).sort()).toEqual([1, 3]);
    });

    it('includes comments from all threads when include_resolved is true', async () => {
      mockGitHubClient.getPRReviewThreads.mockResolvedValue([
        createMockThread({
          rootCommentId: 1,
          isResolved: false,
          comments: [createMockComment({ id: 1 })],
        }),
        createMockThread({
          rootCommentId: 2,
          isResolved: true,
          comments: [createMockComment({ id: 2 })],
        }),
        createMockThread({
          rootCommentId: 3,
          isResolved: false,
          comments: [createMockComment({ id: 3 })],
        }),
      ]);

      const step = createStep({
        pr_number: 123,
        include_resolved: true,
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const comments = output.comments as Comment[];
      expect(comments.length).toBe(3);
    });

    it('unresolved_count reflects unresolved THREAD count (not comment count)', async () => {
      mockGitHubClient.getPRReviewThreads.mockResolvedValue([
        // One unresolved thread with 3 comments — counts as 1
        createMockThread({
          rootCommentId: 10,
          isResolved: false,
          comments: [
            createMockComment({ id: 10 }),
            createMockComment({ id: 11 }),
            createMockComment({ id: 12 }),
          ],
        }),
        // One resolved thread with 1 comment — counts as 0
        createMockThread({
          rootCommentId: 20,
          isResolved: true,
          comments: [createMockComment({ id: 20 })],
        }),
        // Another unresolved thread — counts as 1
        createMockThread({
          rootCommentId: 30,
          isResolved: false,
          comments: [createMockComment({ id: 30 })],
        }),
      ]);

      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.has_unresolved).toBe(true);
      expect(output.unresolved_count).toBe(2);
    });

    it('handles comments with file paths and line numbers', async () => {
      mockGitHubClient.getPRReviewThreads.mockResolvedValue([
        createMockThread({
          rootCommentId: 1,
          isResolved: false,
          comments: [
            createMockComment({
              id: 1,
              path: 'src/file.ts',
              line: 42,
            }),
          ],
        }),
      ]);

      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const comments = output.comments as Comment[];
      expect(comments[0]!.path).toBe('src/file.ts');
      expect(comments[0]!.line).toBe(42);
    });

    it('handles API errors', async () => {
      mockGitHubClient.getPRReviewThreads.mockRejectedValue(new Error('PR not found'));

      const step = createStep({ pr_number: 999 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
