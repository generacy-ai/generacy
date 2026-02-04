/**
 * Tests for epic.dispatch_children action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DispatchChildrenAction } from '../../../src/actions/epic/dispatch-children.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  getIssue: vi.fn(),
  updateIssue: vi.fn(),
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
    uses: 'epic.dispatch_children',
    with: inputs,
  };
}

describe('DispatchChildrenAction', () => {
  let action: DispatchChildrenAction;

  beforeEach(() => {
    action = new DispatchChildrenAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
    mockGitHubClient.updateIssue.mockResolvedValue(undefined);
    mockGitHubClient.addLabels.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles epic.dispatch_children action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'epic.close',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('requires epic_issue_number input', async () => {
      const step = createStep({ child_issues: [1, 2, 3] });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'epic_issue_number'");
    });

    it('requires child_issues input', async () => {
      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'child_issues'");
    });

    it('returns error for empty child_issues array', async () => {
      const step = createStep({
        epic_issue_number: 123,
        child_issues: [],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('non-empty array');
    });

    it('dispatches child issues successfully', async () => {
      mockGitHubClient.getIssue
        .mockResolvedValueOnce({
          number: 201,
          title: 'Child 1',
          body: '',
          state: 'open',
          labels: [],
          assignees: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        })
        .mockResolvedValueOnce({
          number: 202,
          title: 'Child 2',
          body: '',
          state: 'open',
          labels: [],
          assignees: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        });

      const step = createStep({
        epic_issue_number: 123,
        child_issues: [201, 202],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);

      // Should assign to agent
      expect(mockGitHubClient.updateIssue).toHaveBeenCalledTimes(2);
      expect(mockGitHubClient.updateIssue).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        201,
        { assignees: ['generacy-bot'] }
      );

      // Should add dispatched label
      expect(mockGitHubClient.addLabels).toHaveBeenCalledTimes(2);
      expect(mockGitHubClient.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        201,
        ['agent:dispatched']
      );

      const output = result.output as Record<string, unknown>;
      expect((output.dispatched as number[]).length).toBe(2);
      expect((output.failed as unknown[]).length).toBe(0);
      expect(output.agent_account).toBe('generacy-bot');
    });

    it('skips closed issues', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 201,
        title: 'Closed Child',
        body: '',
        state: 'closed',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        epic_issue_number: 123,
        child_issues: [201],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      // Should fail because no issues were dispatched
      expect(result.success).toBe(false);

      const output = result.error as string;
      expect(output).toContain('closed');
    });

    it('skips already dispatched issues', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 201,
        title: 'Already Dispatched',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:dispatched', color: 'blue' }],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        epic_issue_number: 123,
        child_issues: [201],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(mockGitHubClient.updateIssue).not.toHaveBeenCalled();
    });

    it('handles partial failures', async () => {
      mockGitHubClient.getIssue
        .mockResolvedValueOnce({
          number: 201,
          title: 'Good Child',
          body: '',
          state: 'open',
          labels: [],
          assignees: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        })
        .mockRejectedValueOnce(new Error('Issue not found'));

      const step = createStep({
        epic_issue_number: 123,
        child_issues: [201, 202],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true); // At least one succeeded

      const output = result.output as Record<string, unknown>;
      expect(output.dispatched).toContain(201);
      const failed = output.failed as Array<{ issue_number: number; reason: string }>;
      expect(failed.length).toBe(1);
      expect(failed[0].issue_number).toBe(202);
      expect(failed[0].reason).toContain('not found');
    });

    it('uses GENERACY_AGENT_ACCOUNT from environment', async () => {
      const originalEnv = process.env.GENERACY_AGENT_ACCOUNT;
      process.env.GENERACY_AGENT_ACCOUNT = 'custom-agent';

      mockGitHubClient.getIssue.mockResolvedValue({
        number: 201,
        title: 'Child',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        epic_issue_number: 123,
        child_issues: [201],
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.updateIssue).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        201,
        { assignees: ['custom-agent'] }
      );

      const output = result.output as Record<string, unknown>;
      expect(output.agent_account).toBe('custom-agent');

      // Restore
      if (originalEnv) {
        process.env.GENERACY_AGENT_ACCOUNT = originalEnv;
      } else {
        delete process.env.GENERACY_AGENT_ACCOUNT;
      }
    });
  });
});
