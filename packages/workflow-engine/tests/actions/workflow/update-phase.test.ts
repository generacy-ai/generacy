/**
 * Tests for workflow.update_phase action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdatePhaseAction } from '../../../src/actions/workflow/update-phase.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  addLabels: vi.fn(),
  removeLabels: vi.fn(),
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
    uses: 'workflow.update_phase',
    with: inputs,
  };
}

describe('UpdatePhaseAction', () => {
  let action: UpdatePhaseAction;

  beforeEach(() => {
    action = new UpdatePhaseAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
    mockGitHubClient.addLabels.mockResolvedValue(undefined);
    mockGitHubClient.removeLabels.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles workflow.update_phase action', () => {
      const step = createStep();
      expect(action.canHandle(step)).toBe(true);
    });

    it('rejects other actions', () => {
      const step: StepDefinition = {
        name: 'test',
        uses: 'github.preflight',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('execute', () => {
    it('requires issue_number input', async () => {
      const step = createStep({ phase: 'implement', action: 'start' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'issue_number'");
    });

    it('requires phase input', async () => {
      const step = createStep({ issue_number: 123, action: 'start' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'phase'");
    });

    it('requires action input', async () => {
      const step = createStep({ issue_number: 123, phase: 'implement' });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'action'");
    });

    describe('action: start', () => {
      it('removes waiting-for label', async () => {
        const step = createStep({
          issue_number: 123,
          phase: 'spec-review',
          action: 'start',
        });
        const context = createMockContext();

        const result = await action.execute(step, context);

        expect(result.success).toBe(true);
        expect(mockGitHubClient.removeLabels).toHaveBeenCalledWith(
          'test-owner',
          'test-repo',
          123,
          ['waiting-for:spec-review']
        );
        const output = result.output as Record<string, unknown>;
        expect(output.labels_removed).toContain('waiting-for:spec-review');
      });

      it('handles missing waiting-for label gracefully', async () => {
        mockGitHubClient.removeLabels.mockRejectedValue(new Error('Label not found'));

        const step = createStep({
          issue_number: 123,
          phase: 'plan-review',
          action: 'start',
        });
        const context = createMockContext();

        const result = await action.execute(step, context);

        expect(result.success).toBe(true);
      });
    });

    describe('action: complete', () => {
      it('adds completed label and removes waiting-for', async () => {
        const step = createStep({
          issue_number: 123,
          phase: 'spec-review',
          action: 'complete',
        });
        const context = createMockContext();

        const result = await action.execute(step, context);

        expect(result.success).toBe(true);
        expect(mockGitHubClient.addLabels).toHaveBeenCalledWith(
          'test-owner',
          'test-repo',
          123,
          ['completed:spec-review']
        );
        expect(mockGitHubClient.removeLabels).toHaveBeenCalled();
        const output = result.output as Record<string, unknown>;
        expect(output.labels_added).toContain('completed:spec-review');
      });
    });

    describe('action: block', () => {
      it('adds waiting-for label', async () => {
        const step = createStep({
          issue_number: 123,
          phase: 'manual-validation',
          action: 'block',
        });
        const context = createMockContext();

        const result = await action.execute(step, context);

        expect(result.success).toBe(true);
        expect(mockGitHubClient.addLabels).toHaveBeenCalledWith(
          'test-owner',
          'test-repo',
          123,
          ['waiting-for:manual-validation']
        );
        const output = result.output as Record<string, unknown>;
        expect(output.labels_added).toContain('waiting-for:manual-validation');
      });
    });

    describe('action: set_current', () => {
      it('sets phase label and removes others', async () => {
        const step = createStep({
          issue_number: 123,
          phase: 'implement',
          action: 'set_current',
        });
        const context = createMockContext();

        const result = await action.execute(step, context);

        expect(result.success).toBe(true);
        expect(mockGitHubClient.removeLabels).toHaveBeenCalled();
        expect(mockGitHubClient.addLabels).toHaveBeenCalledWith(
          'test-owner',
          'test-repo',
          123,
          ['phase:implement']
        );
        const output = result.output as Record<string, unknown>;
        expect(output.labels_added).toContain('phase:implement');
      });
    });

    describe('action: add_completion', () => {
      it('adds completed label for core phase', async () => {
        const step = createStep({
          issue_number: 123,
          phase: 'specify',
          action: 'add_completion',
        });
        const context = createMockContext();

        const result = await action.execute(step, context);

        expect(result.success).toBe(true);
        expect(mockGitHubClient.addLabels).toHaveBeenCalledWith(
          'test-owner',
          'test-repo',
          123,
          ['completed:specify']
        );
        const output = result.output as Record<string, unknown>;
        expect(output.labels_added).toContain('completed:specify');
      });
    });

    it('returns error for unknown action', async () => {
      const step = createStep({
        issue_number: 123,
        phase: 'implement',
        action: 'invalid_action',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });

    it('handles API errors', async () => {
      mockGitHubClient.addLabels.mockRejectedValue(new Error('API error'));

      const step = createStep({
        issue_number: 123,
        phase: 'spec-review',
        action: 'block',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('API error');
    });
  });
});
