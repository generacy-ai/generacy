/**
 * Tests for github.mark_pr_ready action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarkPRReadyAction } from '../../../src/actions/github/mark-pr-ready.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  markPRReady: vi.fn(),
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
    uses: 'github.mark_pr_ready',
    with: inputs,
  };
}

describe('MarkPRReadyAction', () => {
  let action: MarkPRReadyAction;

  beforeEach(() => {
    action = new MarkPRReadyAction();
    vi.clearAllMocks();

    // Default mock setup
    mockGitHubClient.getRepoInfo.mockResolvedValue({
      owner: 'test-owner',
      repo: 'test-repo',
      default_branch: 'main',
    });
    mockGitHubClient.markPRReady.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.mark_pr_ready action', () => {
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

    it('marks PR as ready for review', async () => {
      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.markPRReady).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        123
      );

      const output = result.output as Record<string, unknown>;
      expect(output.success).toBe(true);
      expect(output.pr_number).toBe(123);
      expect(output.pr_url).toBe('https://github.com/test-owner/test-repo/pull/123');
    });

    it('handles PR not found error', async () => {
      mockGitHubClient.markPRReady.mockRejectedValue(new Error('Pull request not found'));

      const step = createStep({ pr_number: 999 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('handles PR already ready error', async () => {
      mockGitHubClient.markPRReady.mockRejectedValue(
        new Error('Pull request is not a draft')
      );

      const step = createStep({ pr_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a draft');
    });
  });
});
