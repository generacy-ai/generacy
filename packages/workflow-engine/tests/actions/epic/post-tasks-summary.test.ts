/**
 * Tests for epic.post_tasks_summary action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PostTasksSummaryAction } from '../../../src/actions/epic/post-tasks-summary.js';
import type { ActionContext, StepDefinition } from '../../../src/types/index.js';

// Mock the GitHub client
vi.mock('../../../src/actions/github/client/index.js', () => ({
  createGitHubClient: vi.fn(() => mockGitHubClient),
}));

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { existsSync, readFileSync, readdirSync } from 'node:fs';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

const mockGitHubClient = {
  getRepoInfo: vi.fn(),
  addIssueComment: vi.fn(),
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
    uses: 'epic.post_tasks_summary',
    with: inputs,
  };
}

describe('PostTasksSummaryAction', () => {
  let action: PostTasksSummaryAction;

  beforeEach(() => {
    action = new PostTasksSummaryAction();
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
    it('handles epic.post_tasks_summary action', () => {
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
    it('requires issue_number input', async () => {
      const step = createStep({});
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Required input 'issue_number'");
    });

    it('returns error when spec directory not found', async () => {
      mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No spec directory found');
    });

    it('returns error when tasks.md not found', async () => {
      mockReaddirSync.mockReturnValue(['123-epic-feature'] as unknown as ReturnType<typeof readdirSync>);
      mockExistsSync.mockReturnValue(false);

      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('tasks.md not found');
    });

    it('posts tasks summary with per-task grouping', async () => {
      mockReaddirSync.mockReturnValue(['123-epic-feature'] as unknown as ReturnType<typeof readdirSync>);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`# Tasks
- [ ] T001 First task
- [x] T002 Second task completed
- [ ] T003 Third task
`);
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 456,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({ issue_number: 123 });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      expect(mockGitHubClient.addIssueComment).toHaveBeenCalled();

      const callArgs = mockGitHubClient.addIssueComment.mock.calls[0];
      expect(callArgs[3]).toContain('<!-- tasks-summary -->');

      const output = result.output as Record<string, unknown>;
      expect(output.comment_id).toBe(456);
      expect(output.task_count).toBe(3);
      expect(output.grouping_used).toBe('per-task');
    });

    it('supports per-phase grouping', async () => {
      mockReaddirSync.mockReturnValue(['123-epic'] as unknown as ReturnType<typeof readdirSync>);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`# Tasks
## Phase 1: Setup
- [ ] T001 Setup task
## Phase 2: Implementation
- [x] T002 Implement feature
`);
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 789,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        grouping_strategy: 'per-phase',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.grouping_used).toBe('per-phase');
    });

    it('supports per-story grouping', async () => {
      mockReaddirSync.mockReturnValue(['123-epic'] as unknown as ReturnType<typeof readdirSync>);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`# Tasks
- [ ] T001 [US1] User story 1 task
- [ ] T002 [US1] Another US1 task
- [x] T003 [US2] User story 2 task
`);
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 111,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        grouping_strategy: 'per-story',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      const output = result.output as Record<string, unknown>;
      expect(output.grouping_used).toBe('per-story');
    });

    it('accepts custom feature_dir', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('- [ ] Task 1');
      mockGitHubClient.addIssueComment.mockResolvedValue({
        id: 222,
        body: '',
        author: 'bot',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const step = createStep({
        issue_number: 123,
        feature_dir: '/custom/path/to/feature',
      });
      const context = createMockContext();

      const result = await action.execute(step, context);

      expect(result.success).toBe(true);
      // Should not try to find directory when feature_dir is provided
      expect(mockReaddirSync).not.toHaveBeenCalled();
    });
  });
});
