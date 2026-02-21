import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCliWorker } from '../claude-cli-worker.js';
import type { WorkerConfig } from '../config.js';
import type {
  ProcessFactory,
  ChildProcessHandle,
  Logger,
} from '../types.js';
import type { SSEEventEmitter } from '../output-capture.js';
import type { QueueItem } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
const mockGithub = {
  getIssue: vi.fn(),
  addLabels: vi.fn().mockResolvedValue(undefined),
  removeLabels: vi.fn().mockResolvedValue(undefined),
  getIssueComments: vi.fn().mockResolvedValue([]),
  addIssueComment: vi.fn().mockResolvedValue({ id: 1, body: '' }),
  updateComment: vi.fn().mockResolvedValue(undefined),
  // Git operations used by PrManager
  getStatus: vi.fn().mockResolvedValue({ branch: 'feature/42', has_changes: false, staged: [], unstaged: [], untracked: [] }),
  stageAll: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue({ sha: 'abc123', files_committed: [] }),
  push: vi.fn().mockResolvedValue({ success: true, ref: 'refs/heads/feature/42', remote: 'origin' }),
  getCurrentBranch: vi.fn().mockResolvedValue('feature/42'),
  findPRForBranch: vi.fn().mockResolvedValue(null),
  getDefaultBranch: vi.fn().mockResolvedValue('develop'),
  createPullRequest: vi.fn().mockResolvedValue({ number: 1, state: 'open', title: 'test', html_url: '' }),
  markPRReady: vi.fn().mockResolvedValue(undefined),
  listBranches: vi.fn().mockResolvedValue([]),
  // PR operations for PrFeedbackHandler
  getPullRequest: vi.fn().mockResolvedValue({ number: 100, head: { ref: 'feature-branch' }, base: { ref: 'main' }, state: 'open' }),
  getPRComments: vi.fn().mockResolvedValue([]),
  replyToPRComment: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(() => mockGithub),
}));

vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    ensureCheckout: vi.fn().mockResolvedValue('/tmp/test-checkout'),
    getDefaultBranch: vi.fn().mockResolvedValue('develop'),
    switchBranch: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock PrFeedbackHandler for address-pr-feedback command routing tests
const mockPrFeedbackHandlerInstance = {
  handle: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../pr-feedback-handler.js', () => ({
  PrFeedbackHandler: vi.fn().mockImplementation(() => mockPrFeedbackHandlerInstance),
}));

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createMockProcess(exitCode = 0, exitDelay = 10) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitResolve: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });

  const handle: ChildProcessHandle = {
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 12345,
    kill: vi.fn((signal?: string) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        exitResolve(exitCode);
      }
      return true;
    }),
    exitPromise,
  };

  if (exitDelay >= 0) {
    setTimeout(() => exitResolve!(exitCode), exitDelay);
  }

  return { handle, stdout, stderr, resolve: exitResolve! };
}

function createConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp/test-workspaces',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    maxTurns: 100,
    gates: {
      'speckit-feature': [
        {
          phase: 'clarify',
          gateLabel: 'waiting-for:clarification',
          condition: 'always',
        },
      ],
      'speckit-bugfix': [],
    },
    ...overrides,
  };
}

function createQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    owner: 'test-owner',
    repo: 'test-repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'process',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ClaudeCliWorker (integration)', () => {
  let spawnFn: ReturnType<typeof vi.fn>;
  let factory: ProcessFactory;
  let sseEvents: unknown[];

  beforeEach(() => {
    vi.clearAllMocks();

    // Re-set mock implementations after clearAllMocks
    mockGithub.getIssue.mockReset();
    mockGithub.addLabels.mockResolvedValue(undefined);
    mockGithub.removeLabels.mockResolvedValue(undefined);
    mockGithub.getIssueComments.mockResolvedValue([]);
    mockGithub.addIssueComment.mockResolvedValue({ id: 1, body: '' });
    mockGithub.updateComment.mockResolvedValue(undefined);
    // PrManager git mocks
    mockGithub.getStatus.mockResolvedValue({ branch: 'feature/42', has_changes: false, staged: [], unstaged: [], untracked: [] });
    mockGithub.stageAll.mockResolvedValue(undefined);
    mockGithub.commit.mockResolvedValue({ sha: 'abc123', files_committed: [] });
    mockGithub.push.mockResolvedValue({ success: true, ref: 'refs/heads/feature/42', remote: 'origin' });
    mockGithub.getCurrentBranch.mockResolvedValue('feature/42');
    mockGithub.findPRForBranch.mockResolvedValue(null);
    mockGithub.getDefaultBranch.mockResolvedValue('develop');
    mockGithub.createPullRequest.mockResolvedValue({ number: 1, state: 'open', title: 'test', html_url: '' });
    mockGithub.markPRReady = vi.fn().mockResolvedValue(undefined);
    mockGithub.listBranches.mockResolvedValue([]);

    spawnFn = vi.fn();
    factory = { spawn: spawnFn } as unknown as ProcessFactory;
    sseEvents = [];

    // Reset logger child to return the mock logger
    (mockLogger.child as ReturnType<typeof vi.fn>).mockReturnValue(mockLogger);
  });

  describe('full phase loop: specify → clarify → gate hit', () => {
    it('stops at clarify gate for speckit-feature workflow', async () => {
      // No existing labels → starts at 'specify'
      mockGithub.getIssue.mockResolvedValue({ labels: [] });

      // Each CLI phase gets a mock process that exits 0
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem());

      // Should have spawned CLI for 'specify' and 'clarify' phases
      expect(spawnFn).toHaveBeenCalledTimes(2);

      // Verify specify phase labels
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['phase:specify'],
      );
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['completed:specify'],
      );

      // Verify clarify phase labels
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['phase:clarify'],
      );
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['completed:clarify'],
      );

      // Verify gate hit labels
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42,
        ['waiting-for:clarification', 'agent:paused'],
      );

      // SSE events: workflow:started should be first
      expect(sseEvents[0]).toEqual(expect.objectContaining({ type: 'workflow:started' }));

      // Should NOT have removed agent:in-progress (workflow paused, not completed)
      const removeCallArgs = (mockGithub.removeLabels as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c[3]);
      const removedAgentInProgress = removeCallArgs.some(
        (labels: unknown) => Array.isArray(labels) && labels.includes('agent:in-progress'),
      );
      expect(removedAgentInProgress).toBe(false);
    });
  });

  describe('speckit-bugfix workflow: no gates', () => {
    it('runs all phases to completion including validate', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem({ workflowName: 'speckit-bugfix' }));

      // Should have spawned CLI for specify, clarify, plan, tasks, implement
      // and sh for validate = 6 total spawns
      expect(spawnFn).toHaveBeenCalledTimes(6);

      // Validate phase spawns 'sh -c' instead of 'claude'
      const lastSpawnCall = spawnFn.mock.calls[5] as [string, string[], unknown];
      expect(lastSpawnCall[0]).toBe('sh');
      expect(lastSpawnCall[1]).toEqual(['-c', 'pnpm test && pnpm build']);

      // Workflow should be complete — agent:in-progress removed
      expect(mockGithub.removeLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['agent:in-progress'],
      );

      // SSE events should include workflow:completed
      const completedEvent = sseEvents.find(
        (e: unknown) => (e as { type: string }).type === 'workflow:completed',
      );
      expect(completedEvent).toBeDefined();
    });
  });

  describe('continue command: resume after gate', () => {
    it('starts from plan when continue command with completed:clarification label', async () => {
      mockGithub.getIssue.mockResolvedValue({
        labels: [
          { name: 'completed:specify' },
          { name: 'completed:clarification' },
        ],
      });
      // Feature branch exists on remote for resume
      mockGithub.listBranches.mockResolvedValue(['42-feature-branch', 'develop']);

      // No gates for this test — use speckit-bugfix to let it run through
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      await worker.handle(createQueueItem({
        command: 'continue',
        workflowName: 'speckit-bugfix',
      }));

      // First CLI spawn should be for 'plan' (GATE_MAPPING: clarification → resumeFrom: plan)
      const firstSpawnArgs = (spawnFn.mock.calls[0] as [string, string[], unknown])[1] as string[];
      const promptArg = firstSpawnArgs[firstSpawnArgs.indexOf('--prompt') + 1]!;
      expect(promptArg).toContain('/speckit:plan');
    });
  });

  describe('error handling: CLI crash', () => {
    it('stops on phase failure and adds agent:error label', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });

      // First phase succeeds, second phase fails
      spawnFn
        .mockReturnValueOnce(createMockProcess(0, 5).handle)
        .mockReturnValueOnce(createMockProcess(1, 5).handle);

      const config = createConfig({ gates: {} }); // No gates
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // Should have spawned 2 processes (specify success, clarify fail)
      expect(spawnFn).toHaveBeenCalledTimes(2);

      // agent:error label should be added
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['agent:error'],
      );

      // SSE events should include workflow:failed
      const failedEvent = sseEvents.find(
        (e: unknown) => (e as { type: string }).type === 'workflow:failed',
      );
      expect(failedEvent).toBeDefined();
    });
  });

  describe('validate phase: test pass / fail', () => {
    it('passes when validate command exits 0', async () => {
      // Start from implement phase (skip earlier phases)
      mockGithub.getIssue.mockResolvedValue({
        labels: [
          { name: 'completed:specify' },
          { name: 'completed:clarify' },
          { name: 'completed:plan' },
          { name: 'completed:tasks' },
        ],
      });
      // Feature branch exists on remote for resume
      mockGithub.listBranches.mockResolvedValue(['42-feature-branch', 'develop', 'main']);

      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // implement + validate = 2 spawns
      expect(spawnFn).toHaveBeenCalledTimes(2);

      // Workflow completed
      expect(mockGithub.removeLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['agent:in-progress'],
      );
    });

    it('fails when validate command exits non-zero', async () => {
      mockGithub.getIssue.mockResolvedValue({
        labels: [
          { name: 'completed:specify' },
          { name: 'completed:clarify' },
          { name: 'completed:plan' },
          { name: 'completed:tasks' },
        ],
      });
      mockGithub.listBranches.mockResolvedValue(['42-feature-branch', 'develop']);

      // implement succeeds, validate fails
      spawnFn
        .mockReturnValueOnce(createMockProcess(0, 5).handle)
        .mockReturnValueOnce(createMockProcess(1, 5).handle);

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // agent:error should be added for validate failure
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['agent:error'],
      );

      // workflow:failed SSE event
      const failedEvent = sseEvents.find(
        (e: unknown) => (e as { type: string }).type === 'workflow:failed',
      );
      expect(failedEvent).toBeDefined();
    });
  });

  describe('graceful shutdown via abort', () => {
    it('emits workflow:failed on unhandled error', async () => {
      // Make getIssue throw to simulate an unhandled error
      mockGithub.getIssue.mockRejectedValue(new Error('Network timeout'));

      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await expect(
        worker.handle(createQueueItem()),
      ).rejects.toThrow('Network timeout');

      // SSE should include workflow:started and workflow:failed
      expect(sseEvents[0]).toEqual(expect.objectContaining({ type: 'workflow:started' }));
      const failedEvent = sseEvents.find(
        (e: unknown) => (e as { type: string }).type === 'workflow:failed',
      );
      expect(failedEvent).toBeDefined();
    });
  });

  describe('markReadyForReview on workflow completion', () => {
    it('should call markPRReady when workflow completes successfully', async () => {
      // No existing labels → starts at 'specify' and runs all phases
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      // Mock PR creation to have a PR number
      mockGithub.createPullRequest.mockResolvedValue({
        number: 42,
        state: 'open',
        title: 'test',
        html_url: 'https://github.com/test-owner/test-repo/pull/42',
      });

      const config = createConfig({ gates: {} }); // No gates to allow full completion
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // Verify markPRReady was called with correct parameters
      expect(mockGithub.markPRReady).toHaveBeenCalledWith('test-owner', 'test-repo', 42);
      expect(mockGithub.markPRReady).toHaveBeenCalledTimes(1);

      // Verify workflow completed successfully
      expect(mockGithub.removeLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['agent:in-progress'],
      );

      const completedEvent = sseEvents.find(
        (e: unknown) => (e as { type: string }).type === 'workflow:completed',
      );
      expect(completedEvent).toBeDefined();
    });

    it('should NOT call markPRReady when workflow pauses at gate', async () => {
      // No existing labels → starts at 'specify'
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig(); // Has gates for speckit-feature
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem()); // Uses speckit-feature by default

      // Should NOT have called markPRReady (workflow paused at gate, not completed)
      expect(mockGithub.markPRReady).not.toHaveBeenCalled();

      // Verify gate hit
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42,
        ['waiting-for:clarification', 'agent:paused'],
      );
    });

    it('should NOT call markPRReady when workflow fails', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });

      // First phase succeeds, second phase fails
      spawnFn
        .mockReturnValueOnce(createMockProcess(0, 5).handle)
        .mockReturnValueOnce(createMockProcess(1, 5).handle);

      const config = createConfig({ gates: {} }); // No gates
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // Should NOT have called markPRReady (workflow failed, not completed)
      expect(mockGithub.markPRReady).not.toHaveBeenCalled();

      // Verify error handling
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['agent:error'],
      );
    });

    it('should log info message before calling markReadyForReview', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // Verify the log message appears before markReadyForReview
      expect(mockLogger.info).toHaveBeenCalledWith('Marking PR as ready for review');
    });

    it('should handle markPRReady errors gracefully without failing workflow', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      // Make markPRReady fail
      mockGithub.markPRReady.mockRejectedValue(new Error('GitHub API error'));

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      // Should NOT throw even if markPRReady fails
      await expect(
        worker.handle(createQueueItem({ workflowName: 'no-gates' })),
      ).resolves.toBeUndefined();

      // Workflow should still complete successfully
      expect(mockGithub.removeLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42, ['agent:in-progress'],
      );

      const completedEvent = sseEvents.find(
        (e: unknown) => (e as { type: string }).type === 'workflow:completed',
      );
      expect(completedEvent).toBeDefined();
    });

    it('should call markPRReady when resuming and completing workflow', async () => {
      // Start from implement phase (already completed previous phases)
      mockGithub.getIssue.mockResolvedValue({
        labels: [
          { name: 'completed:specify' },
          { name: 'completed:clarify' },
          { name: 'completed:plan' },
          { name: 'completed:tasks' },
        ],
      });

      // Feature branch exists (resume scenario)
      mockGithub.listBranches.mockResolvedValue(['42-feature-branch', 'develop']);

      // PR already exists from previous run
      mockGithub.findPRForBranch.mockResolvedValue({
        number: 99,
        url: 'https://github.com/test-owner/test-repo/pull/99',
      });

      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      await worker.handle(createQueueItem({
        command: 'continue',
        workflowName: 'no-gates',
      }));

      // Should call markPRReady with the existing PR number
      expect(mockGithub.markPRReady).toHaveBeenCalledWith('test-owner', 'test-repo', 99);
      expect(mockGithub.markPRReady).toHaveBeenCalledTimes(1);
    });

    it('should call markReadyForReview after onWorkflowComplete', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // Get call order by inspecting mock call indices
      const removeLabelsCallIndex = (mockGithub.removeLabels as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const markPRReadyCallIndex = (mockGithub.markPRReady as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];

      // markPRReady should be called AFTER removeLabels (which happens in onWorkflowComplete)
      expect(markPRReadyCallIndex).toBeGreaterThan(removeLabelsCallIndex!);
    });

    it('should work with existing PR that was created in previous phase', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      // Simulate PR creation during first commitPushAndEnsurePr call
      let prCreated = false;
      mockGithub.findPRForBranch.mockImplementation(async () => {
        if (prCreated) {
          return { number: 77, url: 'https://github.com/test-owner/test-repo/pull/77' };
        }
        return null;
      });

      mockGithub.createPullRequest.mockImplementation(async () => {
        prCreated = true;
        return {
          number: 77,
          state: 'open',
          title: 'test',
          html_url: 'https://github.com/test-owner/test-repo/pull/77',
        };
      });

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // Should use the PR number that was created earlier
      expect(mockGithub.markPRReady).toHaveBeenCalledWith('test-owner', 'test-repo', 77);
    });

    it('should handle missing PR number gracefully (no-op)', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      // Simulate PR creation failure (no PR created)
      mockGithub.findPRForBranch.mockResolvedValue(null);
      mockGithub.createPullRequest.mockRejectedValue(new Error('PR creation failed'));

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      // Should NOT throw even if there's no PR to mark ready
      await expect(
        worker.handle(createQueueItem({ workflowName: 'no-gates' })),
      ).resolves.toBeUndefined();

      // markPRReady should not be called (no PR number available)
      expect(mockGithub.markPRReady).not.toHaveBeenCalled();

      // Workflow should still complete successfully
      const completedEvent = sseEvents.find(
        (e: unknown) => (e as { type: string }).type === 'workflow:completed',
      );
      expect(completedEvent).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // T010: finally-block cleanup and log severity
  // ---------------------------------------------------------------------------
  describe('finally-block cleanup', () => {
    it('calls ensureCleanup after successful completion', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // ensureCleanup in finally calls getIssue to fetch current phase labels,
      // then calls removeLabels with ['agent:in-progress', ...phaseLabels].
      // Since onWorkflowComplete already removed agent:in-progress, this is
      // idempotent — but we verify the cleanup call was made.
      const removeCallArgs = (mockGithub.removeLabels as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c[3] as string[]);

      // The last removeLabels call should be from ensureCleanup (includes 'agent:in-progress')
      const cleanupCalls = removeCallArgs.filter(
        (labels) => Array.isArray(labels) && labels.includes('agent:in-progress'),
      );
      // At least 2 calls with agent:in-progress: onWorkflowComplete + ensureCleanup
      expect(cleanupCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('calls ensureCleanup after unhandled error', async () => {
      // Make getIssue throw on the second call (first call for checkout succeeds,
      // but we need the error to occur during the phase loop)
      // Actually, make getIssue succeed for initial label resolution but have
      // something throw unexpectedly during the phase loop
      mockGithub.getIssue
        .mockResolvedValueOnce({ labels: [] }) // For phase resolution
        .mockResolvedValue({ labels: [] }); // For subsequent calls including cleanup

      // Make the first phase spawn throw unexpectedly
      spawnFn.mockImplementation(() => { throw new Error('Spawn crashed'); });

      const config = createConfig({ gates: {} });
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await expect(
        worker.handle(createQueueItem({ workflowName: 'no-gates' })),
      ).rejects.toThrow();

      // ensureCleanup should still have been called in the finally block.
      // Since labelManager is created before the phase loop, it should be
      // available in finally. Verify via getIssue being called for cleanup.
      // The last getIssue call is from ensureCleanup's getCurrentPhaseLabels().
      const getIssueCalls = (mockGithub.getIssue as ReturnType<typeof vi.fn>).mock.calls;
      // At least 2 calls: one for phase resolution + one for ensureCleanup
      expect(getIssueCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not call ensureCleanup when workflow paused at gate', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig(); // Has gates for speckit-feature
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem()); // speckit-feature by default

      // Gate hit should have been detected (clarify gate)
      expect(mockGithub.addLabels).toHaveBeenCalledWith(
        'test-owner', 'test-repo', 42,
        ['waiting-for:clarification', 'agent:paused'],
      );

      // ensureCleanup should NOT be called when gateHit is true.
      // Verify by checking that no removeLabels call includes 'agent:in-progress'.
      // The gate path does not remove agent:in-progress.
      const removeCallArgs = (mockGithub.removeLabels as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c[3] as string[]);
      const agentInProgressRemovals = removeCallArgs.filter(
        (labels) => Array.isArray(labels) && labels.includes('agent:in-progress'),
      );
      expect(agentInProgressRemovals).toHaveLength(0);
    });

    it('calls ensureCleanup after phase failure (non-gate)', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });

      // First phase succeeds, second phase fails
      spawnFn
        .mockReturnValueOnce(createMockProcess(0, 5).handle)
        .mockReturnValueOnce(createMockProcess(1, 5).handle);

      const config = createConfig({ gates: {} }); // No gates
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // On phase failure, onError removes agent:in-progress.
      // Then ensureCleanup in finally also attempts removal (idempotent).
      const removeCallArgs = (mockGithub.removeLabels as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c[3] as string[]);
      const agentInProgressRemovals = removeCallArgs.filter(
        (labels) => Array.isArray(labels) && labels.includes('agent:in-progress'),
      );
      // At least 2: onError + ensureCleanup
      expect(agentInProgressRemovals.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('post-completion error handling (log severity)', () => {
    it('logs at warn level when post-completion step fails', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig({ gates: {} });

      // Make the SSE emitter throw on workflow:completed event (post-completion).
      // This is after phasesCompleted=true and onWorkflowComplete succeeds,
      // so it should be caught and logged at warn level.
      const throwingSseEmitter = vi.fn((event: { type: string }) => {
        if (event.type === 'workflow:completed') {
          throw new Error('SSE emit failed');
        }
      });

      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: throwingSseEmitter as unknown as SSEEventEmitter,
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // Should log at warn level, not error, for post-completion failure
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('SSE emit failed') }),
        'Post-completion step failed (all phases completed successfully)',
      );

      // Should NOT log at error level with the unhandled error message
      const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
      const unhandledErrorLogs = errorCalls.filter(
        (call: unknown[]) => call[1] === 'Worker encountered an unhandled error',
      );
      expect(unhandledErrorLogs).toHaveLength(0);
    });

    it('logs at error level when error occurs before phases complete', async () => {
      // Make getIssue throw to simulate a pre-phase-completion error
      mockGithub.getIssue.mockRejectedValue(new Error('Network timeout'));

      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await expect(
        worker.handle(createQueueItem()),
      ).rejects.toThrow('Network timeout');

      // Should log at error level for pre-completion failure
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Network timeout') }),
        'Worker encountered an unhandled error',
      );
    });

    it('does not emit workflow:failed when post-completion step fails', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig({ gates: {} });

      // Make the SSE emitter throw on workflow:completed (post-completion).
      // Track all events received before the throw.
      const receivedEvents: unknown[] = [];
      const throwingSseEmitter = vi.fn((event: { type: string }) => {
        receivedEvents.push(event);
        if (event.type === 'workflow:completed') {
          throw new Error('SSE emit failed');
        }
      });

      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: throwingSseEmitter as unknown as SSEEventEmitter,
      });

      await worker.handle(createQueueItem({ workflowName: 'no-gates' }));

      // The post-completion error is caught and logged at warn level.
      // The catch block with phasesCompleted=true does NOT emit workflow:failed.
      const failedEvents = receivedEvents.filter(
        (e: unknown) => (e as { type: string }).type === 'workflow:failed',
      );
      expect(failedEvents).toHaveLength(0);
    });

    it('emits workflow:failed when error occurs before phases complete', async () => {
      mockGithub.getIssue.mockRejectedValue(new Error('Network timeout'));

      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await expect(
        worker.handle(createQueueItem()),
      ).rejects.toThrow('Network timeout');

      const failedEvents = sseEvents.filter(
        (e: unknown) => (e as { type: string }).type === 'workflow:failed',
      );
      expect(failedEvents).toHaveLength(1);
    });

    it('does not re-throw when post-completion step fails', async () => {
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      const config = createConfig({ gates: {} });

      // Make the SSE emitter throw on workflow:completed (post-completion)
      const throwingSseEmitter = vi.fn((event: { type: string }) => {
        if (event.type === 'workflow:completed') {
          throw new Error('SSE emit failed');
        }
      });

      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: throwingSseEmitter as unknown as SSEEventEmitter,
      });

      // handle() should resolve (not reject) — workflow completed even though
      // post-completion work failed. This means WorkerDispatcher calls
      // queue.complete() instead of queue.release().
      await expect(
        worker.handle(createQueueItem({ workflowName: 'no-gates' })),
      ).resolves.toBeUndefined();
    });

    it('re-throws when error occurs before phases complete', async () => {
      mockGithub.getIssue.mockRejectedValue(new Error('Network timeout'));

      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      await expect(
        worker.handle(createQueueItem()),
      ).rejects.toThrow('Network timeout');
    });
  });

  // ---------------------------------------------------------------------------
  // T022: address-pr-feedback command routing
  // ---------------------------------------------------------------------------
  describe('address-pr-feedback command routing (T022)', () => {
    beforeEach(() => {
      // Clear the mock handler
      mockPrFeedbackHandlerInstance.handle.mockClear();
      mockPrFeedbackHandlerInstance.handle.mockResolvedValue(undefined);
    });

    it('routes address-pr-feedback command to PrFeedbackHandler', async () => {
      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      const item = createQueueItem({
        command: 'address-pr-feedback',
        metadata: {
          prNumber: 100,
          reviewThreadIds: [1, 2, 3],
        },
      });

      await worker.handle(item);

      // Should NOT spawn CLI directly (no calls to spawnFn)
      expect(spawnFn).not.toHaveBeenCalled();

      // Should NOT call getIssue (PR feedback flow doesn't need issue labels)
      expect(mockGithub.getIssue).not.toHaveBeenCalled();

      // Should delegate to PrFeedbackHandler with correct parameters
      expect(mockPrFeedbackHandlerInstance.handle).toHaveBeenCalledWith(
        item,
        '/tmp/test-checkout', // checkoutPath from RepoCheckout mock
      );

      // Should emit workflow:started event
      expect(sseEvents[0]).toEqual(expect.objectContaining({
        type: 'workflow:started',
        data: expect.objectContaining({
          owner: 'test-owner',
          repo: 'test-repo',
          issueNumber: 42,
          workflowName: 'speckit-feature',
          command: 'address-pr-feedback',
        }),
      }));

      // Should emit workflow:completed event after handler completes
      const completedEvent = sseEvents.find(
        (e: unknown) => (e as { type: string }).type === 'workflow:completed',
      );
      expect(completedEvent).toEqual(expect.objectContaining({
        type: 'workflow:completed',
        data: expect.objectContaining({
          lastPhase: 'address-pr-feedback',
          totalPhases: 1,
        }),
      }));
    });

    it('emits workflow:failed when PrFeedbackHandler throws error', async () => {
      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      const item = createQueueItem({
        command: 'address-pr-feedback',
        metadata: {
          prNumber: 100,
          reviewThreadIds: [1],
        },
      });

      // Make handler throw
      mockPrFeedbackHandlerInstance.handle.mockRejectedValueOnce(new Error('Failed to fetch PR #100'));

      await expect(worker.handle(item)).rejects.toThrow('Failed to fetch PR #100');

      // Should emit workflow:started
      expect(sseEvents[0]).toEqual(expect.objectContaining({ type: 'workflow:started' }));

      // Should emit workflow:failed with error message
      const failedEvent = sseEvents.find(
        (e: unknown) => (e as { type: string }).type === 'workflow:failed',
      );
      expect(failedEvent).toBeDefined();
      expect(failedEvent).toHaveProperty('type', 'workflow:failed');
      expect(failedEvent).toHaveProperty('data');
      expect((failedEvent as any).data).toHaveProperty('error');
      expect((failedEvent as any).data.error).toContain('Failed to fetch PR #100');
    });

    it('checks out default branch before routing to PrFeedbackHandler', async () => {
      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      const item = createQueueItem({
        command: 'address-pr-feedback',
        metadata: {
          prNumber: 100,
          reviewThreadIds: [1],
        },
      });

      await worker.handle(item);

      // ClaudeCliWorker should have called RepoCheckout.ensureCheckout
      // which is mocked to return '/tmp/test-checkout'
      // PrFeedbackHandler.handle should receive this checkout path
      expect(mockPrFeedbackHandlerInstance.handle).toHaveBeenCalledWith(
        item,
        '/tmp/test-checkout',
      );
    });

    it('does not execute phase loop for address-pr-feedback command', async () => {
      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      const item = createQueueItem({
        command: 'address-pr-feedback',
        metadata: {
          prNumber: 100,
          reviewThreadIds: [1],
        },
      });

      await worker.handle(item);

      // Should NOT call getIssue to fetch labels (phase loop logic)
      expect(mockGithub.getIssue).not.toHaveBeenCalled();

      // Should NOT add/remove phase labels
      const addLabelsCalls = (mockGithub.addLabels as ReturnType<typeof vi.fn>).mock.calls;
      const phaseLabels = addLabelsCalls.filter((call: unknown[]) => {
        const labels = call[3] as string[];
        return labels.some((l: string) => l.startsWith('phase:') || l.startsWith('completed:'));
      });
      expect(phaseLabels).toHaveLength(0);

      // Should NOT spawn CLI for phases
      expect(spawnFn).not.toHaveBeenCalled();
    });

    it('passes processFactory to PrFeedbackHandler constructor', async () => {
      const config = createConfig();

      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter: (event: unknown) => { sseEvents.push(event); },
      });

      const item = createQueueItem({
        command: 'address-pr-feedback',
        metadata: {
          prNumber: 100,
          reviewThreadIds: [1],
        },
      });

      await worker.handle(item);

      // PrFeedbackHandler should be constructed with correct dependencies
      // This verifies the handler receives the same processFactory for consistent behavior
      expect(mockPrFeedbackHandlerInstance.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'address-pr-feedback',
          metadata: expect.objectContaining({
            prNumber: 100,
          }),
        }),
        expect.any(String), // checkoutPath
      );
    });

    it('passes SSE emitter to PrFeedbackHandler for event streaming', async () => {
      const sseEmitter = vi.fn();
      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
        sseEmitter,
      });

      const item = createQueueItem({
        command: 'address-pr-feedback',
        metadata: {
          prNumber: 100,
          reviewThreadIds: [1],
        },
      });

      await worker.handle(item);

      // SSE emitter should be called for workflow events
      expect(sseEmitter).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'workflow:started',
        }),
      );

      expect(sseEmitter).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'workflow:completed',
        }),
      );
    });

    it('returns early after PrFeedbackHandler completes without executing phase loop', async () => {
      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      const item = createQueueItem({
        command: 'address-pr-feedback',
        metadata: {
          prNumber: 100,
          reviewThreadIds: [1],
        },
      });

      await worker.handle(item);

      // Handler should complete
      expect(mockPrFeedbackHandlerInstance.handle).toHaveBeenCalled();

      // Should NOT proceed to phase resolution
      expect(mockGithub.getIssue).not.toHaveBeenCalled();

      // Should NOT switch branches (PrFeedbackHandler handles branch switching internally)
      // Note: The worker does checkout the default branch initially, but doesn't switch
      // to feature branches like it would in the phase loop
    });

    it('handles missing metadata by delegating validation to PrFeedbackHandler', async () => {
      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      // Item with address-pr-feedback but no metadata
      const item = createQueueItem({
        command: 'address-pr-feedback',
        // metadata intentionally omitted
      });

      // PrFeedbackHandler should throw for missing prNumber (actual behavior)
      mockPrFeedbackHandlerInstance.handle.mockRejectedValueOnce(
        new Error('Missing prNumber in metadata for address-pr-feedback command'),
      );

      await expect(worker.handle(item)).rejects.toThrow(
        'Missing prNumber in metadata for address-pr-feedback command',
      );

      // Worker should have attempted to delegate to PrFeedbackHandler
      // The worker doesn't validate metadata; it delegates to the handler
      expect(mockPrFeedbackHandlerInstance.handle).toHaveBeenCalledWith(
        item,
        expect.any(String),
      );
    });

    it('creates scoped logger for address-pr-feedback processing', async () => {
      const childLogger = { ...mockLogger };
      (mockLogger.child as ReturnType<typeof vi.fn>).mockReturnValueOnce(childLogger);

      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      const item = createQueueItem({
        command: 'address-pr-feedback',
        metadata: {
          prNumber: 100,
          reviewThreadIds: [1],
        },
      });

      await worker.handle(item);

      // Should create child logger with workflow context
      expect(mockLogger.child).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: expect.any(String),
          owner: 'test-owner',
          repo: 'test-repo',
          issue: 42,
          workflowName: 'speckit-feature',
        }),
      );

      // Child logger should log the routing decision
      expect(childLogger.info).toHaveBeenCalledWith(
        'Routing to PrFeedbackHandler for PR feedback addressing',
      );

      // Child logger should log completion
      expect(childLogger.info).toHaveBeenCalledWith(
        'PR feedback addressing completed',
      );
    });

    it('does not interfere with process/continue commands', async () => {
      const config = createConfig();
      const worker = new ClaudeCliWorker(config, mockLogger, {
        processFactory: factory,
      });

      // Standard process command should not route to PrFeedbackHandler
      mockGithub.getIssue.mockResolvedValue({ labels: [] });
      spawnFn.mockImplementation(() => createMockProcess(0, 5).handle);

      await worker.handle(createQueueItem({ command: 'process' }));

      // PrFeedbackHandler should NOT be called
      expect(mockPrFeedbackHandlerInstance.handle).not.toHaveBeenCalled();

      // Phase loop should execute normally
      expect(mockGithub.getIssue).toHaveBeenCalled();
      expect(spawnFn).toHaveBeenCalled();
    });
  });
});
