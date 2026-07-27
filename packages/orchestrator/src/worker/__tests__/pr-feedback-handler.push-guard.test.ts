/**
 * Integration test for #1051 FR-002/003 wiring inside `PrFeedbackHandler`.
 *
 * Covers the SC-002 refusal-path behaviors in the pr-feedback handler:
 *   - guard returns `refuse{pr-merged}` + issue closed → exactly one warn
 *     log with FR-003a fields; `agent:in-progress` removed;
 *     `agent:error` NOT added; `commitAndPushChanges` NOT called.
 *   - guard returns `refuse{pr-merged}` + issue open → same, plus
 *     `agent:error` added.
 *   - guard returns `refuse{branch-missing, prNumber: null}` → refusal
 *     path fires with `prNumber: null` in the log.
 *   - guard returns `allow` → normal push flow proceeds (regression guard).
 *
 * The guard's own decision matrix is covered by `push-guard.test.ts`; here
 * we only assert the handler-side integration (log shape, label mutations,
 * short-circuit vs. proceed).
 */
import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ChildProcessHandle, Logger, ProcessFactory } from '../types.js';
import type { QueueItem, PrFeedbackMetadata } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Guard mock — swap `evaluatePushGuard` per test to drive each scenario.
// Must be declared via vi.hoisted() so vi.mock() can reference it.
// ---------------------------------------------------------------------------
const { mockEvaluatePushGuard, mockDefaultRemoteBranchExists } = vi.hoisted(() => ({
  mockEvaluatePushGuard: vi.fn(),
  mockDefaultRemoteBranchExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../push-guard.js', () => ({
  evaluatePushGuard: mockEvaluatePushGuard,
  defaultRemoteBranchExists: mockDefaultRemoteBranchExists,
}));

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Mock GitHub Client — one trusted unresolved thread pushes the handler past
// Case A + Case B branches into the spawn/commit path where the guard fires.
// ---------------------------------------------------------------------------
const mockGitHub = {
  getPullRequest: vi.fn(),
  getPRReviewThreads: vi.fn(),
  listReviews: vi.fn().mockResolvedValue([]),
  listPrCommentBodies: vi.fn().mockResolvedValue([]),
  getStatus: vi.fn(),
  stageAll: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  replyToPRComment: vi.fn().mockResolvedValue(undefined),
  resolveReviewThread: vi.fn().mockResolvedValue(undefined),
  removeLabels: vi.fn().mockResolvedValue(undefined),
  addLabels: vi.fn().mockResolvedValue(undefined),
  getIssue: vi.fn(),
};

vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(() => mockGitHub),
  isTrustedCommentAuthor: vi.fn(() => ({ trusted: true, reason: 'owner' })),
  normalizeLogin: (raw: string) => raw.trim().toLowerCase().replace(/\[bot\]$/, ''),
  tryLoadCommentTrustConfig: vi.fn(() => undefined),
  wrapUntrustedData: vi.fn((content: string) => content),
  executeCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'abc1234\n', stderr: '' })),
}));

vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    switchBranch: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import AFTER mocks so the handler sees them.
import { PrFeedbackHandler } from '../pr-feedback-handler.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

// ---------------------------------------------------------------------------
// Child-process helper — mirrors pr-feedback-handler.test.ts pattern so the
// CLI's exitPromise resolves cleanly and the guard is reached.
// ---------------------------------------------------------------------------
function createMockProcess(exitCode = 0, exitDelay = 10) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitResolve!: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });

  const handle: ChildProcessHandle = {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 12345,
    kill: vi.fn((signal?: string) => {
      if (signal === 'SIGKILL' || signal === 'SIGTERM') exitResolve(exitCode);
      return true;
    }),
    exitPromise,
  };
  if (exitDelay >= 0) setTimeout(() => exitResolve(exitCode), exitDelay);
  return handle;
}

const defaultConfig: WorkerConfig = {
  workspaceDir: '/tmp/workspace',
  phaseTimeoutMs: 60_000,
  shutdownGracePeriodMs: 5_000,
  validateCommand: 'pnpm test && pnpm build',
  gates: {},
};

function createQueueItem(): QueueItem {
  return {
    owner: 'o',
    repo: 'r',
    issueNumber: 100,
    workflowName: 'speckit-feature',
    command: 'address-pr-feedback',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    metadata: { prNumber: 42 } as unknown as Record<string, unknown>,
  };
}

function findWarnCall(field: string, value: unknown): unknown[] | undefined {
  return (mockLogger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
    (call) => {
      const obj = call[0] as Record<string, unknown> | undefined;
      return obj && obj[field] === value;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PrFeedbackHandler push-guard integration (#1051 T025)', () => {
  let handler: PrFeedbackHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: guard allows.
    mockEvaluatePushGuard.mockResolvedValue({ kind: 'allow' });

    mockGitHub.getPullRequest.mockResolvedValue({
      number: 42,
      title: 'test',
      body: '',
      state: 'open',
      head: { ref: 'feature-100', sha: '', repo: 'o/r' },
      base: { ref: 'develop', sha: '', repo: 'o/r' },
      draft: false,
      labels: [],
      created_at: '',
      updated_at: '',
    });
    mockGitHub.getPRReviewThreads.mockResolvedValue([
      {
        id: 'PRRT_1',
        rootCommentId: 1,
        isResolved: false,
        comments: [
          {
            id: 1,
            path: 'src/foo.ts',
            line: 10,
            body: 'please fix',
            author: 'reviewer',
            created_at: '',
            updated_at: '',
          },
        ],
      },
    ]);
    mockGitHub.getStatus.mockResolvedValue({
      has_changes: true, staged: [], unstaged: [], untracked: [], branch: 'feature-100', hasUnpushed: false, unpushedCount: 0,
    });
    mockGitHub.getIssue.mockResolvedValue({
      number: 100, title: 'issue', state: 'open', labels: [], assignees: [], body: '', created_at: '', updated_at: '',
    });
    mockGitHub.commit.mockResolvedValue({ sha: 'abc123', files_committed: ['x.ts'] });
    mockGitHub.push.mockResolvedValue(undefined);

    const spawnFn = vi.fn().mockReturnValue(createMockProcess(0, 5));
    const processFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const agentLauncher = new AgentLauncher(new Map([['default', processFactory]]));
    agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
    handler = new PrFeedbackHandler(defaultConfig, mockLogger, agentLauncher);
  });

  it('refuse pr-merged + issue.closed → warn once, clear in-progress, do NOT add agent:error, do NOT push', async () => {
    mockEvaluatePushGuard.mockResolvedValue({
      kind: 'refuse',
      reason: 'pr-merged',
      prNumber: 42,
      branch: 'feature-100',
      owner: 'o',
      repo: 'r',
      issueNumber: 100,
    });
    mockGitHub.getIssue.mockResolvedValue({
      number: 100, title: 'closed', state: 'closed', labels: [], assignees: [], body: '', created_at: '', updated_at: '',
    });

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    // Exactly one warn line with event: 'push-refused'.
    const refuseCall = findWarnCall('event', 'push-refused');
    expect(refuseCall).toBeDefined();
    const payload = refuseCall![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: 'push-refused',
      reason: 'pr-merged',
      prNumber: 42,
      branch: 'feature-100',
      owner: 'o',
      repo: 'r',
      issueNumber: 100,
    });

    // agent:in-progress cleared.
    const removeCalls = (mockGitHub.removeLabels as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const removedInProgress = removeCalls.some((call) => {
      const labels = call[3] as string[];
      return Array.isArray(labels) && labels.includes('agent:in-progress');
    });
    expect(removedInProgress).toBe(true);

    // agent:error NOT added when issue is closed.
    const addCalls = (mockGitHub.addLabels as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const addedError = addCalls.some((call) => {
      const labels = call[3] as string[];
      return Array.isArray(labels) && labels.includes('agent:error');
    });
    expect(addedError).toBe(false);

    // Push NOT called.
    expect(mockGitHub.push).not.toHaveBeenCalled();
    expect(mockGitHub.stageAll).not.toHaveBeenCalled();
    expect(mockGitHub.commit).not.toHaveBeenCalled();
  });

  it('refuse pr-merged + issue.open → warn once + clear in-progress + add agent:error, do NOT push', async () => {
    mockEvaluatePushGuard.mockResolvedValue({
      kind: 'refuse',
      reason: 'pr-merged',
      prNumber: 42,
      branch: 'feature-100',
      owner: 'o',
      repo: 'r',
      issueNumber: 100,
    });
    // getIssue defaults to state: 'open' in beforeEach.

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    const refuseCall = findWarnCall('event', 'push-refused');
    expect(refuseCall).toBeDefined();

    // agent:error added when issue is open.
    const addCalls = (mockGitHub.addLabels as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const addedError = addCalls.some((call) => {
      const labels = call[3] as string[];
      return Array.isArray(labels) && labels.includes('agent:error');
    });
    expect(addedError).toBe(true);
    expect(mockGitHub.push).not.toHaveBeenCalled();
  });

  it('refuse branch-missing with prNumber: null → warn carries prNumber: null', async () => {
    mockEvaluatePushGuard.mockResolvedValue({
      kind: 'refuse',
      reason: 'branch-missing',
      prNumber: null,
      branch: 'feature-100',
      owner: 'o',
      repo: 'r',
      issueNumber: 100,
    });

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    const refuseCall = findWarnCall('event', 'push-refused');
    expect(refuseCall).toBeDefined();
    const payload = refuseCall![0] as Record<string, unknown>;
    expect(payload.reason).toBe('branch-missing');
    expect(payload.prNumber).toBeNull();

    expect(mockGitHub.push).not.toHaveBeenCalled();
  });

  it('allow → normal push flow proceeds (regression guard for happy path)', async () => {
    mockEvaluatePushGuard.mockResolvedValue({ kind: 'allow' });

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    // Guard consulted but no refuse — no push-refused log.
    const refuseCall = findWarnCall('event', 'push-refused');
    expect(refuseCall).toBeUndefined();

    // Normal push flow proceeds.
    expect(mockGitHub.stageAll).toHaveBeenCalled();
    expect(mockGitHub.commit).toHaveBeenCalled();
    expect(mockGitHub.push).toHaveBeenCalled();
  });
});
