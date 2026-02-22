import { vi, describe, it, expect, beforeEach } from 'vitest';
import { EpicPostTasks } from '../epic-post-tasks.js';
import type { WorkerContext, Logger } from '../types.js';
import type { TasksToIssuesOutput, ActionContext } from '@generacy-ai/workflow-engine';

// ---------------------------------------------------------------------------
// Mock executeTasksToIssues from workflow-engine
// ---------------------------------------------------------------------------
const mockExecuteTasksToIssues = vi.fn<(...args: unknown[]) => Promise<TasksToIssuesOutput>>();

vi.mock('@generacy-ai/workflow-engine', () => ({
  executeTasksToIssues: (...args: unknown[]) => mockExecuteTasksToIssues(...args),
}));

// Mock readdirSync for resolveFeatureDir
const mockReaddirSync = vi.fn<(path: string) => string[]>();

vi.mock('node:fs', () => ({
  readdirSync: (path: string) => mockReaddirSync(path),
}));

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------
function createMockLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  } as unknown as Logger;
  return logger;
}

// ---------------------------------------------------------------------------
// Mock GitHub client
// ---------------------------------------------------------------------------
function createMockGithub() {
  return {
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue({ id: 1, body: '' }),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    getCurrentBranch: vi.fn().mockResolvedValue('42-epic-branch'),
    listBranches: vi.fn().mockResolvedValue(['42-epic-branch', 'develop']),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createWorkerContext(overrides: Partial<WorkerContext> = {}): WorkerContext {
  const mockGithub = createMockGithub();
  return {
    workerId: 'test-worker-id',
    item: {
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 42,
      workflowName: 'speckit-epic',
      command: 'process',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
    },
    startPhase: 'specify',
    github: mockGithub as unknown as WorkerContext['github'],
    logger: createMockLogger(),
    signal: new AbortController().signal,
    checkoutPath: '/tmp/test-checkout',
    issueUrl: 'https://github.com/test-owner/test-repo/issues/42',
    ...overrides,
  };
}

function createTasksOutput(overrides: Partial<TasksToIssuesOutput> = {}): TasksToIssuesOutput {
  return {
    created_issues: [
      { issue_number: 101, title: 'Implement auth module', task_id: 'T001' },
      { issue_number: 102, title: 'Add database schema', task_id: 'T002' },
      { issue_number: 103, title: 'Write API endpoints', task_id: 'T003' },
    ],
    skipped_issues: [],
    failed_tasks: [],
    total_tasks: 3,
    ...overrides,
  };
}

/** Type-safe accessor for mockExecuteTasksToIssues call args */
interface TasksToIssuesCallInput {
  feature_dir: string;
  epic_issue_number: number;
  epic_branch: string;
  trigger_label: string;
}

function getTasksToIssuesCallArgs(callIndex = 0) {
  const args = mockExecuteTasksToIssues.mock.calls[callIndex]!;
  return {
    input: args[0] as TasksToIssuesCallInput,
    actionContext: args[1] as ActionContext,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('EpicPostTasks', () => {
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();

    // Default: specs directory contains a matching folder
    mockReaddirSync.mockReturnValue(['42-epic-feature']);

    // Default: executeTasksToIssues returns success
    mockExecuteTasksToIssues.mockResolvedValue(createTasksOutput());
  });

  // -------------------------------------------------------------------------
  // Post-tasks orchestration: tasks-to-issues → dispatch → summary → label
  // -------------------------------------------------------------------------
  describe('post-tasks orchestration', () => {
    it('executes all four steps in order: create issues → dispatch → summary → label', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      const result = await epicPostTasks.execute(context);

      expect(result.success).toBe(true);
      expect(result.childIssues).toEqual([101, 102, 103]);

      // Step 1: executeTasksToIssues was called
      expect(mockExecuteTasksToIssues).toHaveBeenCalledTimes(1);
      const { input, actionContext } = getTasksToIssuesCallArgs();
      expect(input).toEqual(expect.objectContaining({
        feature_dir: '/tmp/test-checkout/specs/42-epic-feature',
        epic_issue_number: 42,
        trigger_label: 'process:speckit-feature',
      }));
      expect(actionContext).toHaveProperty('workdir', '/tmp/test-checkout');

      // Step 2: Dispatch — updateIssue (assign) + addLabels (agent:dispatched) for each created issue
      expect(github.updateIssue).toHaveBeenCalledTimes(3);
      for (const num of [101, 102, 103]) {
        expect(github.updateIssue).toHaveBeenCalledWith(
          'test-owner', 'test-repo', num,
          { assignees: ['generacy-bot'] },
        );
      }

      // agent:dispatched label added to each child
      const dispatchedLabelCalls = (github.addLabels as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => {
          const labels = c[3] as string[];
          return labels.includes('agent:dispatched');
        });
      expect(dispatchedLabelCalls).toHaveLength(3);

      // Step 3: Summary comment posted on the epic
      expect(github.addIssueComment).toHaveBeenCalledTimes(1);
      const commentBody = (github.addIssueComment as ReturnType<typeof vi.fn>).mock.calls[0]![3] as string;
      expect(commentBody).toContain('<!-- epic-children-summary -->');
      expect(commentBody).toContain('#101');
      expect(commentBody).toContain('#102');
      expect(commentBody).toContain('#103');
      expect(commentBody).toContain('Implement auth module');

      // Step 4: waiting-for:children-complete label added
      expect(github.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['waiting-for:children-complete'],
      );
    });

    it('includes both created and skipped issues in childIssues array', async () => {
      mockExecuteTasksToIssues.mockResolvedValue(createTasksOutput({
        created_issues: [
          { issue_number: 101, title: 'New task', task_id: 'T001' },
        ],
        skipped_issues: [
          { issue_number: 200, title: 'Existing task', task_id: 'T002' },
        ],
        total_tasks: 2,
      }));

      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      const result = await epicPostTasks.execute(context);

      expect(result.success).toBe(true);
      expect(result.childIssues).toEqual([101, 200]);
    });

    it('only dispatches newly created issues, not skipped ones', async () => {
      mockExecuteTasksToIssues.mockResolvedValue(createTasksOutput({
        created_issues: [
          { issue_number: 101, title: 'New task', task_id: 'T001' },
        ],
        skipped_issues: [
          { issue_number: 200, title: 'Existing task', task_id: 'T002' },
        ],
        total_tasks: 2,
      }));

      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      // Only the created issue should be dispatched, not the skipped one
      expect(github.updateIssue).toHaveBeenCalledTimes(1);
      expect(github.updateIssue).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 101,
        { assignees: ['generacy-bot'] },
      );
    });

    it('skips dispatch step when no new issues were created', async () => {
      mockExecuteTasksToIssues.mockResolvedValue(createTasksOutput({
        created_issues: [],
        skipped_issues: [
          { issue_number: 200, title: 'Existing task', task_id: 'T001' },
        ],
        total_tasks: 1,
      }));

      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      const result = await epicPostTasks.execute(context);

      expect(result.success).toBe(true);
      expect(result.childIssues).toEqual([200]);
      // No dispatch calls (no new issues)
      expect(github.updateIssue).not.toHaveBeenCalled();
    });

    it('includes tasksToIssuesOutput in result', async () => {
      const tasksOutput = createTasksOutput();
      mockExecuteTasksToIssues.mockResolvedValue(tasksOutput);

      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      const result = await epicPostTasks.execute(context);

      expect(result.tasksToIssuesOutput).toEqual(tasksOutput);
    });

    it('posts summary comment with both created and existing statuses', async () => {
      mockExecuteTasksToIssues.mockResolvedValue(createTasksOutput({
        created_issues: [
          { issue_number: 101, title: 'New task', task_id: 'T001' },
        ],
        skipped_issues: [
          { issue_number: 200, title: 'Existing task', task_id: 'T002' },
        ],
        total_tasks: 2,
      }));

      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const commentBody = (github.addIssueComment as ReturnType<typeof vi.fn>).mock.calls[0]![3] as string;
      expect(commentBody).toContain('New');
      expect(commentBody).toContain('Existing');
      expect(commentBody).toContain('#101');
      expect(commentBody).toContain('#200');
    });

    it('includes failed tasks section in summary when some tasks fail', async () => {
      mockExecuteTasksToIssues.mockResolvedValue(createTasksOutput({
        created_issues: [
          { issue_number: 101, title: 'Successful task', task_id: 'T001' },
        ],
        failed_tasks: [
          { task_id: 'T002', title: 'Failed task', reason: 'GitHub API error' },
        ],
        total_tasks: 2,
      }));

      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const commentBody = (github.addIssueComment as ReturnType<typeof vi.fn>).mock.calls[0]![3] as string;
      expect(commentBody).toContain('Failed Tasks');
      expect(commentBody).toContain('T002');
      expect(commentBody).toContain('GitHub API error');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling: partial failure in child creation
  // -------------------------------------------------------------------------
  describe('error handling: partial failure', () => {
    it('returns failure when executeTasksToIssues throws', async () => {
      mockExecuteTasksToIssues.mockRejectedValue(new Error('tasks.md parse error'));

      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      const result = await epicPostTasks.execute(context);

      expect(result.success).toBe(false);
      expect(result.childIssues).toEqual([]);
      expect(result.tasksToIssuesOutput).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('tasks.md parse error') }),
        'Failed to create child issues from tasks.md',
      );
    });

    it('returns failure when all tasks fail to create issues', async () => {
      mockExecuteTasksToIssues.mockResolvedValue(createTasksOutput({
        created_issues: [],
        skipped_issues: [],
        failed_tasks: [
          { task_id: 'T001', title: 'Task 1', reason: 'API error' },
          { task_id: 'T002', title: 'Task 2', reason: 'Rate limit' },
        ],
        total_tasks: 2,
      }));

      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      const result = await epicPostTasks.execute(context);

      expect(result.success).toBe(false);
      expect(result.childIssues).toEqual([]);
      expect(result.tasksToIssuesOutput).toBeDefined();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ failedTasks: 2, totalTasks: 2 }),
        'All tasks failed to create issues — aborting post-tasks',
      );
    });

    it('continues when dispatch fails for some children', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      // First child dispatch fails, rest succeed
      github.updateIssue
        .mockRejectedValueOnce(new Error('GitHub 403'))
        .mockResolvedValue(undefined);

      const result = await epicPostTasks.execute(context);

      // Overall succeeds despite dispatch failure (non-critical)
      expect(result.success).toBe(true);
      expect(result.childIssues).toEqual([101, 102, 103]);

      // Logged warning for dispatch failure
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('GitHub 403') }),
        expect.stringContaining('Failed to dispatch'),
      );
    });

    it('continues when summary comment posting fails', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      github.addIssueComment.mockRejectedValue(new Error('Comment API error'));

      const result = await epicPostTasks.execute(context);

      // Still succeeds — summary comment is non-critical
      expect(result.success).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Comment API error') }),
        'Failed to post tasks summary comment — continuing',
      );
    });

    it('returns failure when adding waiting-for:children-complete label fails', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      // Make addLabels fail ONLY for waiting-for:children-complete
      github.addLabels.mockImplementation(async (_o: string, _r: string, _n: number, labels: string[]) => {
        if (labels.includes('waiting-for:children-complete')) {
          throw new Error('Label API error');
        }
      });

      const result = await epicPostTasks.execute(context);

      // This is a critical step — failure means the epic cannot pause
      expect(result.success).toBe(false);
      expect(result.childIssues).toEqual([101, 102, 103]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Label API error') }),
        'Failed to add waiting-for:children-complete label',
      );
    });

    it('succeeds when some tasks create issues and some fail', async () => {
      mockExecuteTasksToIssues.mockResolvedValue(createTasksOutput({
        created_issues: [
          { issue_number: 101, title: 'Successful task', task_id: 'T001' },
        ],
        skipped_issues: [],
        failed_tasks: [
          { task_id: 'T002', title: 'Failed task', reason: 'timeout' },
        ],
        total_tasks: 2,
      }));

      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      const result = await epicPostTasks.execute(context);

      // Partial success — at least some issues were created
      expect(result.success).toBe(true);
      expect(result.childIssues).toEqual([101]);
    });

    it('handles dispatch throwing an error for the entire batch', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      // All dispatch calls fail
      github.updateIssue.mockRejectedValue(new Error('Network error'));

      const result = await epicPostTasks.execute(context);

      // Dispatch failure is non-critical — still succeeds
      expect(result.success).toBe(true);
      expect(result.childIssues).toEqual([101, 102, 103]);
    });
  });

  // -------------------------------------------------------------------------
  // waiting-for:children-complete label
  // -------------------------------------------------------------------------
  describe('waiting-for:children-complete label', () => {
    it('adds waiting-for:children-complete label to the epic issue', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      expect(github.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['waiting-for:children-complete'],
      );
    });

    it('adds waiting-for:children-complete AFTER dispatch and summary steps', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      // Get call orders
      const updateIssueOrder = (github.updateIssue as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
      const addIssueCommentOrder = (github.addIssueComment as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
      const addLabelsOrder = (github.addLabels as ReturnType<typeof vi.fn>).mock.invocationCallOrder;

      // Find the waiting-for:children-complete addLabels call
      const waitingLabelCallIdx = (github.addLabels as ReturnType<typeof vi.fn>).mock.calls.findIndex(
        (c: unknown[]) => {
          const labels = c[3] as string[];
          return labels.includes('waiting-for:children-complete');
        },
      );
      const waitingLabelOrder = addLabelsOrder[waitingLabelCallIdx]!;

      // Dispatch happened before the waiting label
      const lastDispatchOrder = Math.max(...updateIssueOrder);
      expect(waitingLabelOrder).toBeGreaterThan(lastDispatchOrder);

      // Summary comment happened before the waiting label
      const commentOrder = addIssueCommentOrder[0]!;
      expect(waitingLabelOrder).toBeGreaterThan(commentOrder);
    });

    it('logs success after adding waiting-for:children-complete label', async () => {
      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      expect(logger.info).toHaveBeenCalledWith(
        { issueNumber: 42 },
        'Added waiting-for:children-complete label to epic',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Feature directory resolution
  // -------------------------------------------------------------------------
  describe('feature directory resolution', () => {
    it('resolves feature dir from specs directory matching issue number prefix', async () => {
      mockReaddirSync.mockReturnValue(['42-epic-feature', '100-other']);

      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const { input } = getTasksToIssuesCallArgs();
      expect(input.feature_dir).toBe('/tmp/test-checkout/specs/42-epic-feature');
    });

    it('falls back to issue number directory when no match found', async () => {
      mockReaddirSync.mockReturnValue(['100-other', '200-another']);

      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const { input } = getTasksToIssuesCallArgs();
      expect(input.feature_dir).toBe('/tmp/test-checkout/specs/42');
    });

    it('falls back when specs directory does not exist', async () => {
      mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const { input } = getTasksToIssuesCallArgs();
      expect(input.feature_dir).toBe('/tmp/test-checkout/specs/42');
    });
  });

  // -------------------------------------------------------------------------
  // Epic branch resolution
  // -------------------------------------------------------------------------
  describe('epic branch resolution', () => {
    it('resolves epic branch from getCurrentBranch', async () => {
      const context = createWorkerContext();
      (context.github as unknown as ReturnType<typeof createMockGithub>).getCurrentBranch.mockResolvedValue('42-my-epic');

      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const { input } = getTasksToIssuesCallArgs();
      expect(input.epic_branch).toBe('42-my-epic');
    });

    it('falls back to branch listing when getCurrentBranch fails', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      github.getCurrentBranch.mockRejectedValue(new Error('not in git'));
      github.listBranches.mockResolvedValue(['42-epic-branch', 'develop', 'main']);

      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const { input } = getTasksToIssuesCallArgs();
      expect(input.epic_branch).toBe('42-epic-branch');
    });

    it('falls back to constructed branch name as last resort', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      github.getCurrentBranch.mockRejectedValue(new Error('not in git'));
      github.listBranches.mockResolvedValue(['develop', 'main']); // No matching branch

      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const { input } = getTasksToIssuesCallArgs();
      expect(input.epic_branch).toBe('42-epic');
    });
  });

  // -------------------------------------------------------------------------
  // ActionContext construction
  // -------------------------------------------------------------------------
  describe('ActionContext construction', () => {
    it('passes checkoutPath as workdir in ActionContext', async () => {
      const context = createWorkerContext({ checkoutPath: '/custom/path' });
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const { actionContext } = getTasksToIssuesCallArgs();
      expect(actionContext.workdir).toBe('/custom/path');
    });

    it('passes abort signal through ActionContext', async () => {
      const abortController = new AbortController();
      const context = createWorkerContext({ signal: abortController.signal });
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const { actionContext } = getTasksToIssuesCallArgs();
      expect(actionContext.signal).toBe(abortController.signal);
    });

    it('provides logger adapter in ActionContext', async () => {
      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      const { actionContext } = getTasksToIssuesCallArgs();
      expect(actionContext.logger).toBeDefined();
      expect(typeof actionContext.logger.info).toBe('function');
      expect(typeof actionContext.logger.error).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // Agent account dispatch
  // -------------------------------------------------------------------------
  describe('agent account dispatch', () => {
    it('uses GENERACY_AGENT_ACCOUNT env var when set', async () => {
      const originalEnv = process.env.GENERACY_AGENT_ACCOUNT;
      process.env.GENERACY_AGENT_ACCOUNT = 'custom-bot';

      try {
        const context = createWorkerContext();
        const github = context.github as unknown as ReturnType<typeof createMockGithub>;
        const epicPostTasks = new EpicPostTasks(logger);

        await epicPostTasks.execute(context);

        expect(github.updateIssue).toHaveBeenCalledWith(
          'test-owner', 'test-repo', 101,
          { assignees: ['custom-bot'] },
        );
      } finally {
        if (originalEnv === undefined) {
          delete process.env.GENERACY_AGENT_ACCOUNT;
        } else {
          process.env.GENERACY_AGENT_ACCOUNT = originalEnv;
        }
      }
    });

    it('defaults to generacy-bot when GENERACY_AGENT_ACCOUNT is not set', async () => {
      const originalEnv = process.env.GENERACY_AGENT_ACCOUNT;
      delete process.env.GENERACY_AGENT_ACCOUNT;

      try {
        const context = createWorkerContext();
        const github = context.github as unknown as ReturnType<typeof createMockGithub>;
        const epicPostTasks = new EpicPostTasks(logger);

        await epicPostTasks.execute(context);

        expect(github.updateIssue).toHaveBeenCalledWith(
          'test-owner', 'test-repo', 101,
          { assignees: ['generacy-bot'] },
        );
      } finally {
        if (originalEnv !== undefined) {
          process.env.GENERACY_AGENT_ACCOUNT = originalEnv;
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------
  describe('logging', () => {
    it('logs starting message with issue context', async () => {
      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      expect(logger.info).toHaveBeenCalledWith(
        { owner: 'test-owner', repo: 'test-repo', issueNumber: 42 },
        'Starting epic post-tasks: creating child issues and dispatching',
      );
    });

    it('logs completion with child issue count', async () => {
      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          childIssues: [101, 102, 103],
          created: 3,
          skipped: 0,
        }),
        'Epic post-tasks complete',
      );
    });

    it('logs tasks-to-issues operation stats', async () => {
      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      expect(logger.info).toHaveBeenCalledWith(
        { created: 3, skipped: 0, failed: 0, total: 3 },
        'Tasks-to-issues operation complete',
      );
    });

    it('logs dispatch stats', async () => {
      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      expect(logger.info).toHaveBeenCalledWith(
        { dispatched: 3, failed: 0, total: 3 },
        'Child dispatch complete',
      );
    });

    it('logs individual child dispatch at debug level', async () => {
      const context = createWorkerContext();
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      expect(logger.debug).toHaveBeenCalledWith(
        { childNumber: 101 },
        'Dispatched child #101',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles zero total tasks gracefully (tasks.md is empty)', async () => {
      mockExecuteTasksToIssues.mockResolvedValue(createTasksOutput({
        created_issues: [],
        skipped_issues: [],
        failed_tasks: [],
        total_tasks: 0,
      }));

      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      const result = await epicPostTasks.execute(context);

      // With 0 total tasks, childIssues is empty but NOT a failure
      // (total_tasks is 0, so the "all failed" check doesn't trigger)
      expect(result.success).toBe(true);
      expect(result.childIssues).toEqual([]);

      // No dispatch, no summary issues to reference
      expect(github.updateIssue).not.toHaveBeenCalled();

      // waiting-for:children-complete should still be added
      expect(github.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['waiting-for:children-complete'],
      );
    });

    it('correctly handles addLabels for agent:dispatched on each child', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      await epicPostTasks.execute(context);

      for (const num of [101, 102, 103]) {
        expect(github.addLabels).toHaveBeenCalledWith(
          'test-owner', 'test-repo', num, ['agent:dispatched'],
        );
      }
    });

    it('handles dispatch warning when individual child fails', async () => {
      const context = createWorkerContext();
      const github = context.github as unknown as ReturnType<typeof createMockGithub>;
      const epicPostTasks = new EpicPostTasks(logger);

      // Second child dispatch fails
      github.updateIssue
        .mockResolvedValueOnce(undefined) // 101 succeeds
        .mockRejectedValueOnce(new Error('forbidden')) // 102 fails
        .mockResolvedValueOnce(undefined); // 103 succeeds

      await epicPostTasks.execute(context);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('forbidden'), childNumber: 102 }),
        'Failed to dispatch child #102',
      );

      expect(logger.info).toHaveBeenCalledWith(
        { dispatched: 2, failed: 1, total: 3 },
        'Child dispatch complete',
      );
    });
  });
});
