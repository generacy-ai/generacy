/**
 * Tests for github.review_changes action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReviewChangesAction } from '../../../src/actions/github/review-changes.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

const mockGitHubClient = {
  getStatus: vi.fn(),
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
    uses: 'github.review_changes',
    with: inputs,
  };
}

describe('ReviewChangesAction', () => {
  let action: ReviewChangesAction;

  beforeEach(() => {
    action = new ReviewChangesAction();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canHandle', () => {
    it('handles github.review_changes action', () => {
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
    it('returns no changes when working tree is clean', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'main',
        has_changes: false,
        staged: [],
        unstaged: [],
        untracked: [],
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.has_changes).toBe(false);
      expect((output.files as unknown[]).length).toBe(0);
      expect(output.summary).toBe('No uncommitted changes');
    });

    it('lists staged files', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['src/file1.ts', 'src/file2.ts'],
        unstaged: [],
        untracked: [],
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const files = output.files as Array<Record<string, unknown>>;
      expect(files.length).toBe(2);
      expect(files[0].path).toBe('src/file1.ts');
      expect(files[0].staged).toBe(true);
      expect(output.summary).toContain('2 staged');
    });

    it('lists unstaged files', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: [],
        unstaged: ['src/modified.ts'],
        untracked: [],
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const files = output.files as Array<Record<string, unknown>>;
      expect(files.length).toBe(1);
      expect(files[0].path).toBe('src/modified.ts');
      expect(files[0].staged).toBe(false);
      expect(output.summary).toContain('1 modified');
    });

    it('includes untracked files by default', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: [],
        unstaged: [],
        untracked: ['new-file.ts'],
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const files = output.files as Array<Record<string, unknown>>;
      expect(files.length).toBe(1);
      expect(files[0].status).toBe('untracked');
      expect(output.summary).toContain('1 untracked');
    });

    it('excludes untracked files when include_untracked is false', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['staged.ts'],
        unstaged: [],
        untracked: ['untracked.ts'],
      });

      const step = createStep({ include_untracked: false });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const files = output.files as Array<Record<string, unknown>>;
      expect(files.length).toBe(1);
      expect(files[0].path).toBe('staged.ts');
    });

    it('handles mixed file states', async () => {
      mockGitHubClient.getStatus.mockResolvedValue({
        branch: 'feature',
        has_changes: true,
        staged: ['src/staged.ts'],
        unstaged: ['src/modified.ts'],
        untracked: ['src/new.ts'],
      });

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      const files = output.files as Array<Record<string, unknown>>;
      expect(files.length).toBe(3);
      expect(output.summary).toContain('1 staged');
      expect(output.summary).toContain('1 modified');
      expect(output.summary).toContain('1 untracked');
    });

    it('handles git errors gracefully', async () => {
      mockGitHubClient.getStatus.mockRejectedValue(new Error('Not a git repository'));

      const step = createStep();
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not a git repository');
    });
  });
});
