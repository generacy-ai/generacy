/**
 * Tests for workflow.update_stage action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdateStageAction } from '../../../src/actions/workflow/update-stage.js';
import type { ActionContext, StepDefinition, StageProgress } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  getIssueComments: vi.fn(),
  addIssueComment: vi.fn(),
  updateComment: vi.fn(),
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
    uses: 'workflow.update_stage',
    with: inputs,
  };
}

describe('UpdateStageAction', () => {
  let action: UpdateStageAction;

  beforeEach(() => {
    action = new UpdateStageAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
    mockGitHubClient.getIssueComments.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles workflow.update_stage action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'workflow.check_gate',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('requires issue_number input', async () => {
      const step = createStep({
        stage: 'specification',
        status: 'in_progress',
        progress: [],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'issue_number'");
    });

    it('requires stage input', async () => {
      const step = createStep({
        issue_number: 123,
        status: 'in_progress',
        progress: [],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'stage'");
    });

    it('requires status input', async () => {
      const step = createStep({
        issue_number: 123,
        stage: 'specification',
        progress: [],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'status'");
    });

    it('requires progress input', async () => {
      const step = createStep({
        issue_number: 123,
        stage: 'specification',
        status: 'in_progress',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'progress'");
    });

    it('creates new stage comment when none exists', async () => {
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 123456,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const progress: StageProgress[] = [
        { command: '/speckit:specify', status: 'complete' },
        { command: '/speckit:clarify', status: 'in_progress' },
      ];

      const step = createStep({
        issue_number: 123,
        stage: 'specification',
        status: 'in_progress',
        progress,
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.addIssueComment).toHaveBeenCalled();

      const output = result.output as Record<string, unknown>;
      expect(output.comment_id).toBe(123456);
      expect(output.created).toBe(true);

      // Check comment body contains stage marker
      const callArgs = mockGitHubClient.addIssueComment.mock.calls[0];
      expect(callArgs[3]).toContain('<!-- stage:specification -->');
    });

    it('updates existing stage comment when marker found', async () => {
      mockGitHubClient.getIssueComments.mockResolvedValue([
        {
          id: 111,
          body: 'Some other comment',
          author: 'user',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 222,
          body: '<!-- stage:planning -->\n## Planning\n...',
          author: 'bot',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);
      mockGitHubClient.updateComment.mockResolvedValue(undefined);

      const progress: StageProgress[] = [
        { command: '/speckit:plan', status: 'complete', summary: 'Plan generated' },
        { command: '/speckit:tasks', status: 'in_progress' },
      ];

      const step = createStep({
        issue_number: 123,
        stage: 'planning',
        status: 'in_progress',
        progress,
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updateComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        222,
        expect.stringContaining('<!-- stage:planning -->')
      );
      expect(mockGitHubClient.addIssueComment).not.toHaveBeenCalled();

      const output = result.output as Record<string, unknown>;
      expect(output.comment_id).toBe(222);
      expect(output.created).toBe(false);
    });

    it('includes branch and PR info in comment', async () => {
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 789,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        stage: 'implementation',
        status: 'in_progress',
        progress: [{ command: '/speckit:implement', status: 'in_progress' }],
        branch: '123-feature-branch',
        pr_number: 456,
      });
      const context = createMockContext();

      await action.execute(step, context);

      const callArgs = mockGitHubClient.addIssueComment.mock.calls[0];
      const commentBody = callArgs[3];
      expect(commentBody).toContain('**Branch:** `123-feature-branch`');
      expect(commentBody).toContain('**PR:** #456');
    });

    it('includes next step when provided', async () => {
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 111,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        stage: 'specification',
        status: 'in_progress',
        progress: [{ command: '/speckit:specify', status: 'complete' }],
        next_step: 'Awaiting clarification',
      });
      const context = createMockContext();

      await action.execute(step, context);

      const callArgs = mockGitHubClient.addIssueComment.mock.calls[0];
      expect(callArgs[3]).toContain('**Next:** Awaiting clarification');
    });

    it('includes blocked reason when status is blocked', async () => {
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 222,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        stage: 'planning',
        status: 'blocked',
        progress: [{ command: '/speckit:plan', status: 'pending' }],
        blocked_reason: 'Waiting for spec review approval',
      });
      const context = createMockContext();

      await action.execute(step, context);

      const callArgs = mockGitHubClient.addIssueComment.mock.calls[0];
      expect(callArgs[3]).toContain('**Blocked:** Waiting for spec review approval');
    });

    it('formats progress items with summaries', async () => {
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 333,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const progress: StageProgress[] = [
        { command: '/speckit:specify', status: 'complete', summary: 'Spec created with 5 sections' },
        { command: '/speckit:clarify', status: 'complete', summary: '3 questions answered' },
      ];

      const step = createStep({
        issue_number: 123,
        stage: 'specification',
        status: 'complete',
        progress,
      });
      const context = createMockContext();

      await action.execute(step, context);

      const callArgs = mockGitHubClient.addIssueComment.mock.calls[0];
      const body = callArgs[3];
      expect(body).toContain('/speckit:specify');
      expect(body).toContain('Spec created with 5 sections');
      expect(body).toContain('/speckit:clarify');
      expect(body).toContain('3 questions answered');
    });

    it('handles API errors', async () => {
      mockGitHubClient.addIssueComment.mockRejectedValue(new Error('API error'));

      const step = createStep({
        issue_number: 123,
        stage: 'specification',
        status: 'in_progress',
        progress: [],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('API error');
    });
  });
});
