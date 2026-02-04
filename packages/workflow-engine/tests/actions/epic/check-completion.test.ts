/**
 * Tests for epic.check_completion action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CheckCompletionAction } from '../../../src/actions/epic/check-completion.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

// Mock cli-utils
vi.mock('../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
}));

import { executeCommand } from '../../../src/actions/cli-utils.js';

const mockExecuteCommand = vi.mocked(executeCommand);

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
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
    uses: 'epic.check_completion',
    with: inputs,
  };
}

describe('CheckCompletionAction', () => {
  let action: CheckCompletionAction;

  beforeEach(() => {
    action = new CheckCompletionAction();
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
    it('handles epic.check_completion action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'epic.post_tasks_summary',
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

    it('returns 0% when no children found', async () => {
      mockExecuteCommand.mockResolvedValue({
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.percentage).toBe(0);
      expect(output.total_children).toBe(0);
      expect(output.ready_for_pr).toBe(false);
    });

    it('calculates completion percentage correctly', async () => {
      // First call: find child issues
      mockExecuteCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 201, title: 'Child 1', state: 'closed', labels: [] },
          { number: 202, title: 'Child 2', state: 'open', labels: [{ name: 'agent:in-progress' }] },
          { number: 203, title: 'Child 3', state: 'open', labels: [] },
        ]),
        stderr: '',
      });

      // PR check calls - first child merged, others not
      mockExecuteCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '[{"number": 301}]',
        stderr: '',
      });
      mockExecuteCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      });
      mockExecuteCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.total_children).toBe(3);
      expect(output.completed_children).toBe(1);
      expect(output.in_progress_children).toBe(1);
      expect(output.percentage).toBe(33);
      expect(output.ready_for_pr).toBe(false);
    });

    it('returns ready_for_pr true when all children complete', async () => {
      mockExecuteCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 201, title: 'Child 1', state: 'closed', labels: [] },
          { number: 202, title: 'Child 2', state: 'closed', labels: [] },
        ]),
        stderr: '',
      });

      // Both PRs merged
      mockExecuteCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '[{"number": 301}]',
        stderr: '',
      });
      mockExecuteCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '[{"number": 302}]',
        stderr: '',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.percentage).toBe(100);
      expect(output.ready_for_pr).toBe(true);
      expect(output.completed_children).toBe(2);
    });

    it('detects blocked children', async () => {
      mockExecuteCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 201, title: 'Blocked Child', state: 'open', labels: [{ name: 'waiting-for:review' }] },
        ]),
        stderr: '',
      });

      mockExecuteCommand.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.blocked_children).toBe(1);
    });

    it('handles gh CLI errors gracefully', async () => {
      mockExecuteCommand.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'Error: Not Found',
      });

      const step = createStep({ epic_issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      // Should succeed with empty children
      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.total_children).toBe(0);
    });
  });
});
