/**
 * Tests for workflow.check_gate action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CheckGateAction } from '../../../src/actions/workflow/check-gate.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  getIssue: vi.fn(),
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
    uses: 'workflow.check_gate',
    with: inputs,
  };
}

describe('CheckGateAction', () => {
  let action: CheckGateAction;

  beforeEach(() => {
    action = new CheckGateAction();
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
    it('handles workflow.check_gate action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'workflow.update_phase',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('requires issue_number input', async () => {
      const step = createStep({ phase: 'spec-review' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'issue_number'");
    });

    it('requires phase input', async () => {
      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'phase'");
    });

    it('allows proceeding when no gate labels exist', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        phase: 'spec-review',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.can_proceed).toBe(true);
      expect(output.gate_active).toBe(false);
    });

    it('blocks when needs label present without completed', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [{ name: 'needs:spec-review', color: 'red' }],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        phase: 'spec-review',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.can_proceed).toBe(false);
      expect(output.gate_active).toBe(true);
      expect(output.waiting_for).toBe('spec-review');
      expect(output.blocked_reason).toContain('approval');
    });

    it('blocks when waiting-for label present without completed', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [{ name: 'waiting-for:plan-review', color: 'yellow' }],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        phase: 'plan-review',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.can_proceed).toBe(false);
      expect(output.gate_active).toBe(true);
    });

    it('allows proceeding when completed label exists', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [
          { name: 'needs:spec-review', color: 'red' },
          { name: 'completed:spec-review', color: 'green' },
        ],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        phase: 'spec-review',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.can_proceed).toBe(true);
      expect(output.gate_active).toBe(true);
      expect(output.completed).toBe('spec-review');
    });

    it('allows proceeding when only completed label exists', async () => {
      mockGitHubClient.getIssue.mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: '',
        state: 'open',
        labels: [{ name: 'completed:tasks-review', color: 'green' }],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        phase: 'tasks-review',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.can_proceed).toBe(true);
      expect(output.completed).toBe('tasks-review');
    });

    it('handles API errors', async () => {
      mockGitHubClient.getIssue.mockRejectedValue(new Error('Issue not found'));

      const step = createStep({
        issue_number: 999,
        phase: 'spec-review',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
