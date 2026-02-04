/**
 * Tests for epic.create_pr action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CreateEpicPRAction } from '../../../src/actions/epic/create-pr.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

// Mock the CheckCompletionAction - must be defined before mock
const mockCheckCompletion = vi.fn();

vi.mock('../../../src/actions/epic/check-completion.js', () => ({
  CheckCompletionAction: class {
    execute = mockCheckCompletion;
  },
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(() => '5'),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  getIssue: vi.fn(),
  listBranches: vi.fn(),
  getPRForBranch: vi.fn(),
  createPR: vi.fn(),
  updatePR: vi.fn(),
  addLabels: vi.fn(),
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
    uses: 'epic.create_pr',
    with: inputs,
  };
}

describe('CreateEpicPRAction', () => {
  let action: CreateEpicPRAction;

  beforeEach(() => {
    action = new CreateEpicPRAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
    mockGitHubClient.addLabels.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles epic.create_pr action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'epic.update_status',
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

    it('returns error when epic not ready for PR', async () => {
      mockCheckCompletion.mockResolvedValue({
        success: true,
        output: {
          percentage: 50,
          ready_for_pr: false,
          completed_children: 2,
        },
        duration: 100,
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not ready for PR');
      expect(result.error).toContain('50%');
    });

    it('returns error when epic branch not found', async () => {
      mockCheckCompletion.mockResolvedValue({
        success: true,
        output: {
          percentage: 100,
          ready_for_pr: true,
          completed_children: 5,
        },
        duration: 100,
      });

      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Epic Title',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      mockGitHubClient.listBranches.mockResolvedValue(['main', 'develop', 'other-branch']);

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not find epic branch');
    });

    it('creates new PR when none exists', async () => {
      mockCheckCompletion.mockResolvedValue({
        success: true,
        output: {
          percentage: 100,
          ready_for_pr: true,
          completed_children: 3,
        },
        duration: 100,
      });

      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Epic: Add Feature',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      mockGitHubClient.listBranches.mockResolvedValue(['main', 'develop', '123-epic-add-feature']);
      mockGitHubClient.getPRForBranch.mockResolvedValue(null);
      mockGitHubClient.createPR.mockResolvedValue({
        number: 456,
        title: '[Epic] Epic: Add Feature',
        body: '',
        state: 'open',
        draft: false,
        head: { ref: '123-epic-add-feature', sha: 'abc', repo: 'test-owner/test-repo' },
        base: { ref: 'develop', sha: 'def', repo: 'test-owner/test-repo' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.createPR).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        expect.objectContaining({
          title: '[Epic] Epic: Add Feature',
          head: '123-epic-add-feature',
          base: 'develop',
          draft: false,
        })
      );

      const output = result.output as Record<string, unknown>;
      expect(output.pr_number).toBe(456);
      expect(output.children_merged).toBe(3);
    });

    it('updates existing PR when one exists', async () => {
      mockCheckCompletion.mockResolvedValue({
        success: true,
        output: {
          percentage: 100,
          ready_for_pr: true,
          completed_children: 2,
        },
        duration: 100,
      });

      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Epic Title',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      mockGitHubClient.listBranches.mockResolvedValue(['main', '123-epic-branch']);
      mockGitHubClient.getPRForBranch.mockResolvedValue({
        number: 789,
        title: 'Old Title',
        body: 'Old body',
        state: 'open',
        draft: true,
        head: { ref: '123-epic-branch', sha: 'abc', repo: 'test-owner/test-repo' },
        base: { ref: 'main', sha: 'def', repo: 'test-owner/test-repo' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });
      mockGitHubClient.updatePR.mockResolvedValue(undefined);

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updatePR).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        789,
        expect.objectContaining({
          title: '[Epic] Epic Title',
        })
      );
      expect(mockGitHubClient.createPR).not.toHaveBeenCalled();

      const output = result.output as Record<string, unknown>;
      expect(output.pr_number).toBe(789);
    });

    it('adds approval label by default', async () => {
      mockCheckCompletion.mockResolvedValue({
        success: true,
        output: {
          percentage: 100,
          ready_for_pr: true,
          completed_children: 1,
        },
        duration: 100,
      });

      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Epic',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      mockGitHubClient.listBranches.mockResolvedValue(['main', '123-epic']);
      mockGitHubClient.getPRForBranch.mockResolvedValue(null);
      mockGitHubClient.createPR.mockResolvedValue({
        number: 111,
        title: '',
        body: '',
        state: 'open',
        draft: false,
        head: { ref: '', sha: '', repo: '' },
        base: { ref: '', sha: '', repo: '' },
        labels: [],
        created_at: '',
        updated_at: '',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      await action.execute(step, context);

      expect(mockGitHubClient.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        111,
        ['needs:epic-approval']
      );
    });

    it('skips approval label when skip_approval_label is true', async () => {
      mockCheckCompletion.mockResolvedValue({
        success: true,
        output: {
          percentage: 100,
          ready_for_pr: true,
          completed_children: 1,
        },
        duration: 100,
      });

      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Epic',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      mockGitHubClient.listBranches.mockResolvedValue(['main', '123-epic']);
      mockGitHubClient.getPRForBranch.mockResolvedValue(null);
      mockGitHubClient.createPR.mockResolvedValue({
        number: 222,
        title: '',
        body: '',
        state: 'open',
        draft: false,
        head: { ref: '', sha: '', repo: '' },
        base: { ref: '', sha: '', repo: '' },
        labels: [],
        created_at: '',
        updated_at: '',
      });

      const step = createStep({
        epic_issue_number: 123,
        skip_approval_label: true,
      });
      const context = createMockContext();

      await action.execute(step, context);

      expect(mockGitHubClient.addLabels).not.toHaveBeenCalled();
    });

    it('uses custom title when provided', async () => {
      mockCheckCompletion.mockResolvedValue({
        success: true,
        output: {
          percentage: 100,
          ready_for_pr: true,
          completed_children: 1,
        },
        duration: 100,
      });

      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Epic',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      mockGitHubClient.listBranches.mockResolvedValue(['main', '123-epic']);
      mockGitHubClient.getPRForBranch.mockResolvedValue(null);
      mockGitHubClient.createPR.mockResolvedValue({
        number: 333,
        title: '',
        body: '',
        state: 'open',
        draft: false,
        head: { ref: '', sha: '', repo: '' },
        base: { ref: '', sha: '', repo: '' },
        labels: [],
        created_at: '',
        updated_at: '',
      });

      const step = createStep({
        epic_issue_number: 123,
        title: 'Custom PR Title',
      });
      const context = createMockContext();

      await action.execute(step, context);

      expect(mockGitHubClient.createPR).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        expect.objectContaining({
          title: 'Custom PR Title',
        })
      );
    });
  });
});
