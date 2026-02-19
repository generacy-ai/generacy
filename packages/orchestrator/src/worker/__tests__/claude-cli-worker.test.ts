import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCliWorker } from '../claude-cli-worker.js';
import type { WorkerConfig } from '../config.js';
import type {
  ProcessFactory,
  ChildProcessHandle,
  Logger,
} from '../types.js';
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
};

vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(() => mockGithub),
}));

vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    ensureCheckout: vi.fn().mockResolvedValue('/tmp/test-checkout'),
  })),
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
    it('starts from clarify when continue command and waiting-for:clarification labels present', async () => {
      mockGithub.getIssue.mockResolvedValue({
        labels: [
          { name: 'completed:specify' },
          { name: 'completed:clarification' },
          { name: 'waiting-for:clarification' },
        ],
      });

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

      // First CLI spawn should be for 'clarify' (resumed phase)
      const firstSpawnArgs = (spawnFn.mock.calls[0] as [string, string[], unknown])[1] as string[];
      const promptArg = firstSpawnArgs[firstSpawnArgs.indexOf('--prompt') + 1]!;
      expect(promptArg).toContain('/speckit:clarify');
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
});
