/**
 * Integration tests for GitHub workflow actions
 *
 * These tests verify that actions work correctly together in a workflow context.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActionContext, StepDefinition } from '../../src/types/index.js';

// Import all actions
import { PreflightAction } from '../../src/actions/github/preflight.js';
import { GetContextAction } from '../../src/actions/github/get-context.js';
import { CommitAndPushAction } from '../../src/actions/github/commit-and-push.js';
import { CreateDraftPRAction } from '../../src/actions/github/create-draft-pr.js';
import { UpdatePhaseAction } from '../../src/actions/workflow/update-phase.js';
import { CheckGateAction } from '../../src/actions/workflow/check-gate.js';
import { AddCommentAction } from '../../src/actions/github/add-comment.js';

// Mock the GitHub client
vi.mock('../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

// Mock cli-utils
vi.mock('../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => '# Test spec content'),
  };
});

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { executeCommand } from '../../src/actions/cli-utils.js';
import { execSync } from 'child_process';

const mockExecuteCommand = vi.mocked(executeCommand);
const mockExecSync = vi.mocked(execSync);

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  getIssue: vi.fn(),
  addLabels: vi.fn(),
  removeLabels: vi.fn(),
  createPR: vi.fn(),
  addIssueComment: vi.fn(),
  getIssueComments: vi.fn(),
  updateComment: vi.fn(),
};

// Helper to create mock context with accumulated outputs
function createWorkflowContext(initialInputs: Record<string, unknown> = {}): ActionContext {
  return {
    workdir: '/test/workdir',
    inputs: initialInputs,
    outputs: {},
    env: {
      GITHUB_TOKEN: 'test-token',
    },
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

describe('GitHub Workflow Integration', () => {
  beforeEach(() => {
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

  describe('Feature workflow: update-phase', () => {
    it('updates phase labels on an issue', async () => {
      const context = createWorkflowContext();

      // Update phase
      const updatePhaseAction = new UpdatePhaseAction();
      mockGitHubClient.addLabels.mockResolvedValue(undefined);
      mockGitHubClient.removeLabels.mockResolvedValue(undefined);

      const updatePhaseStep: StepDefinition = {
        name: 'update-phase',
        uses: 'workflow.update_phase',
        with: {
          issue_number: 123,
          phase: 'implementation-review',
          action: 'complete',
        },
      };

      const phaseResult = await updatePhaseAction.execute(updatePhaseStep, context);

      expect(phaseResult.success).toBe(true);
      expect(mockGitHubClient.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        123,
        ['completed:implementation-review']
      );
    });
  });

  describe('PR workflow: add-comment', () => {
    it('adds comment to issue', async () => {
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 789,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const context = createWorkflowContext();

      // Add comment to issue
      const addCommentAction = new AddCommentAction();
      const addCommentStep: StepDefinition = {
        name: 'add-comment',
        uses: 'github.add_comment',
        with: {
          issue_number: 123,
          body: `## Implementation Started\n\nDraft PR created: #456`,
          phase: 'implement',
        },
      };

      const commentResult = await addCommentAction.execute(addCommentStep, context);

      expect(commentResult.success).toBe(true);
      expect(mockGitHubClient.addIssueComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        123,
        expect.stringContaining('Implementation Started')
      );
    });
  });

  describe('Review gate workflow: check-gate → update-phase', () => {
    it('checks gate and updates phase when approved', async () => {
      // Setup: Issue with completed review label
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Feature',
        body: '',
        state: 'open',
        labels: [
          { name: 'phase:plan', color: 'blue' },
          { name: 'completed:plan-review', color: 'green' },
        ],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const context = createWorkflowContext();

      // Step 1: Check gate
      const checkGateAction = new CheckGateAction();
      const checkGateStep: StepDefinition = {
        name: 'check-gate',
        uses: 'workflow.check_gate',
        with: {
          issue_number: 123,
          phase: 'plan-review',
        },
      };

      const gateResult = await checkGateAction.execute(checkGateStep, context);

      expect(gateResult.success).toBe(true);
      const gateOutput = gateResult.output as Record<string, unknown>;
      expect(gateOutput.can_proceed).toBe(true);

      // Step 2: Update to next phase
      const updatePhaseAction = new UpdatePhaseAction();
      mockGitHubClient.addLabels.mockResolvedValue(undefined);
      mockGitHubClient.removeLabels.mockResolvedValue(undefined);

      const updatePhaseStep: StepDefinition = {
        name: 'update-phase',
        uses: 'workflow.update_phase',
        with: {
          issue_number: 123,
          phase: 'tasks',
          action: 'set_current',
        },
      };

      const phaseResult = await updatePhaseAction.execute(updatePhaseStep, context);

      expect(phaseResult.success).toBe(true);
    });

    it('blocks when gate not passed', async () => {
      // Setup: Issue without completion label
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Feature',
        body: '',
        state: 'open',
        labels: [
          { name: 'phase:plan', color: 'blue' },
          { name: 'waiting-for:plan-review', color: 'yellow' },
        ],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const context = createWorkflowContext();

      // Check gate
      const checkGateAction = new CheckGateAction();
      const checkGateStep: StepDefinition = {
        name: 'check-gate',
        uses: 'workflow.check_gate',
        with: {
          issue_number: 123,
          phase: 'plan-review',
        },
      };

      const gateResult = await checkGateAction.execute(checkGateStep, context);

      expect(gateResult.success).toBe(true);
      const gateOutput = gateResult.output as Record<string, unknown>;
      expect(gateOutput.can_proceed).toBe(false);
      expect(gateOutput.waiting_for).toBe('plan-review');
    });
  });

  describe('Action registration', () => {
    it('all actions have unique type identifiers', () => {
      const actions = [
        new PreflightAction(),
        new GetContextAction(),
        new CommitAndPushAction(),
        new CreateDraftPRAction(),
        new UpdatePhaseAction(),
        new CheckGateAction(),
        new AddCommentAction(),
      ];

      const types = actions.map(a => a.type);
      const uniqueTypes = new Set(types);

      expect(uniqueTypes.size).toBe(types.length);
    });

    it('all actions correctly implement canHandle', () => {
      const actionConfigs = [
        { action: new PreflightAction(), uses: 'github.preflight' },
        { action: new GetContextAction(), uses: 'github.get_context' },
        { action: new CommitAndPushAction(), uses: 'github.commit_and_push' },
        { action: new CreateDraftPRAction(), uses: 'github.create_draft_pr' },
        { action: new UpdatePhaseAction(), uses: 'workflow.update_phase' },
        { action: new CheckGateAction(), uses: 'workflow.check_gate' },
        { action: new AddCommentAction(), uses: 'github.add_comment' },
      ];

      for (const { action, uses } of actionConfigs) {
        const step: StepDefinition = { name: 'test', uses };
        expect(action.canHandle(step)).toBe(true);

        // Should not handle other actions
        const otherStep: StepDefinition = { name: 'test', uses: 'other.action' };
        expect(action.canHandle(otherStep)).toBe(false);
      }
    });
  });

  describe('Error propagation', () => {
    it('propagates errors correctly through workflow', async () => {
      mockGitHubClient.getIssue.mockRejectedValue(new Error('API Error'));

      const context = createWorkflowContext();
      const preflightAction = new PreflightAction();

      const preflightStep: StepDefinition = {
        name: 'preflight',
        uses: 'github.preflight',
        with: { issue_url: 'https://github.com/test-owner/test-repo/issues/123' },
      };

      const result = await preflightAction.execute(preflightStep, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('API Error');
    });
  });
});
