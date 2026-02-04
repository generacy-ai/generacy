/**
 * Tests for github.read_pr_feedback action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReadPRFeedbackAction } from '../../../src/actions/github/read-pr-feedback.js';
import type { ActionContext, StepDefinition, Comment } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  getPRComments: vi.fn(),
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
    uses: 'github.read_pr_feedback',
    with: inputs,
  };
}

// Helper to create mock comment
function createMockComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    body: 'Test comment',
    author: 'reviewer',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ReadPRFeedbackAction', () => {
  let action: ReadPRFeedbackAction;

  beforeEach(() => {
    action = new ReadPRFeedbackAction();
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

    it('returns empty comments when none exist', async () => {
      mockGitHubClient.getPRComments.mockResolvedValue([]);

      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.comments).toEqual([]);
      expect(output.has_unresolved).toBe(false);
      expect(output.unresolved_count).toBe(0);
    });

    it('filters out resolved comments by default', async () => {
      mockGitHubClient.getPRComments.mockResolvedValue([
        createMockComment({ id: 1, resolved: false }),
        createMockComment({ id: 2, resolved: true }),
        createMockComment({ id: 3, resolved: false }),
      ]);

      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const comments = output.comments as Comment[];
      expect(comments.length).toBe(2);
      expect(comments.every(c => c.resolved !== true)).toBe(true);
    });

    it('includes resolved comments when include_resolved is true', async () => {
      mockGitHubClient.getPRComments.mockResolvedValue([
        createMockComment({ id: 1, resolved: false }),
        createMockComment({ id: 2, resolved: true }),
        createMockComment({ id: 3, resolved: false }),
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

    it('counts unresolved comments correctly', async () => {
      mockGitHubClient.getPRComments.mockResolvedValue([
        createMockComment({ id: 1, resolved: false }),
        createMockComment({ id: 2, resolved: false }),
        createMockComment({ id: 3, resolved: undefined }), // No resolved status
      ]);

      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.has_unresolved).toBe(true);
      expect(output.unresolved_count).toBe(2); // Only explicitly resolved: false
    });

    it('handles comments with file paths and line numbers', async () => {
      mockGitHubClient.getPRComments.mockResolvedValue([
        createMockComment({
          id: 1,
          path: 'src/file.ts',
          line: 42,
          resolved: false,
        }),
      ]);

      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const comments = output.comments as Comment[];
      expect(comments[0].path).toBe('src/file.ts');
      expect(comments[0].line).toBe(42);
    });

    it('handles API errors', async () => {
      mockGitHubClient.getPRComments.mockRejectedValue(new Error('PR not found'));

      const step = createStep({ pr_number: 999 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
