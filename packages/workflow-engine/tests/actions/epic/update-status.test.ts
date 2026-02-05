/**
 * Tests for epic.update_status action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdateStatusAction } from '../../../src/actions/epic/update-status.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

// Mock the CheckCompletionAction - must be defined before mock
const mockCheckCompletionExecute = vi.fn();

vi.mock('../../../src/actions/epic/check-completion.js', () => ({
  CheckCompletionAction: class {
    execute = mockCheckCompletionExecute;
  },
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
    uses: 'epic.update_status',
    with: inputs,
  };
}

describe('UpdateStatusAction', () => {
  let action: UpdateStatusAction;

  beforeEach(() => {
    action = new UpdateStatusAction();
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
    it('handles epic.update_status action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'epic.check_completion',
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

    it('creates new status comment when none exists', async () => {
      mockCheckCompletionExecute.mockResolvedValue({
        success: true,
        output: {
          percentage: 50,
          total_children: 4,
          completed_children: 2,
          in_progress_children: 1,
          blocked_children: 1,
          children: [
            { issue_number: 201, title: 'Child 1', state: 'closed', pr_merged: true, labels: [] },
            { issue_number: 202, title: 'Child 2', state: 'closed', pr_merged: true, labels: [] },
            { issue_number: 203, title: 'Child 3', state: 'open', pr_merged: false, labels: ['agent:in-progress'] },
            { issue_number: 204, title: 'Child 4', state: 'open', pr_merged: false, labels: ['waiting-for:review'] },
          ],
        },
        duration: 100,
      });

      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 456,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.addIssueComment).toHaveBeenCalled();

      const callArgs = mockGitHubClient.addIssueComment.mock.calls[0];
      const body = callArgs[3];
      expect(body).toContain('<!-- epic-status -->');
      expect(body).toContain('50%');
      expect(body).toContain('Completed');
      expect(body).toContain('In Progress');
      expect(body).toContain('Blocked');
    });

    it('updates existing status comment when marker found', async () => {
      mockCheckCompletionExecute.mockResolvedValue({
        success: true,
        output: {
          percentage: 75,
          total_children: 4,
          completed_children: 3,
          in_progress_children: 1,
          blocked_children: 0,
          children: [],
        },
        duration: 100,
      });

      mockGitHubClient.getIssueComments.mockResolvedValue([
        {
          id: 111,
          body: 'Random comment',
          author: 'user',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 222,
          body: '<!-- epic-status -->\n## Epic Progress\n...',
          author: 'bot',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]);
      mockGitHubClient.updateComment.mockResolvedValue(undefined);

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updateComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        222,
        expect.stringContaining('<!-- epic-status -->')
      );
      expect(mockGitHubClient.addIssueComment).not.toHaveBeenCalled();
    });

    it('includes progress bar in status comment', async () => {
      mockCheckCompletionExecute.mockResolvedValue({
        success: true,
        output: {
          percentage: 70,
          total_children: 10,
          completed_children: 7,
          in_progress_children: 2,
          blocked_children: 1,
          children: [],
        },
        duration: 100,
      });

      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 789,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      await action.execute(step, context);

      const callArgs = mockGitHubClient.addIssueComment.mock.calls[0];
      const body = callArgs[3];
      // Progress bar should show 7 filled blocks and 3 empty
      expect(body).toContain('█');
      expect(body).toContain('░');
    });

    it('handles check_completion failure', async () => {
      mockCheckCompletionExecute.mockResolvedValue({
        success: false,
        error: 'Failed to check completion',
        duration: 100,
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to check completion');
    });
  });
});
