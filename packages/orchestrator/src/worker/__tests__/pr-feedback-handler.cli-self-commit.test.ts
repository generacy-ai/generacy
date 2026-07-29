/**
 * #1073 regression tests: PR-feedback handler MUST NOT apply
 * `blocked:stuck-feedback-loop` to a cycle in which the fixer CLI committed
 * and pushed its own work (working tree clean, exit 0). Detected by comparing
 * branch HEAD SHA across the CLI invocation via `getHeadSha()`.
 *
 * Test cases mirror the spec's FR/SC matrix:
 *   T-SC-001 (FR-009 / SC-001): CLI-self-commit → zero blocked-label calls +
 *                               reply/resolve loop runs.
 *   T-SC-002 (FR-010 / SC-002): genuine no-diff → `blocked:stuck-feedback-loop`.
 *   T-SC-003 (SC-003):          exactly one `disposition: 'cli-self-committed'`
 *                               info line with `preFixSha` + `postFixSha`.
 *   T-SC-004 (SC-004):          historically-contradictory log pair unreachable.
 *   T-US4-B (FR-013):           head advanced + zero resolves →
 *                               `blocked:resolve-failed`.
 *   T-US4-B-inverse:            head unchanged + zero resolves →
 *                               `blocked:stuck-feedback-loop` (guard against
 *                               over-retargeting).
 *   T-Q4-caveat (FR-008a):      long-form SHAs in the CLI-self-commit payload.
 *
 * Test-double strategy per research.md § D-5: `vi.spyOn(handler as any, 'getHeadSha')`
 * to drive per-invocation SHAs, mirrors the push-guard.test.ts pattern of
 * per-scenario mock resolution.
 */
import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ChildProcessHandle, Logger, ProcessFactory } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Push-guard mock — default allow so the flow reaches the dispatcher.
// ---------------------------------------------------------------------------
const { mockEvaluatePushGuard, mockDefaultRemoteBranchExists } = vi.hoisted(() => ({
  mockEvaluatePushGuard: vi.fn(),
  mockDefaultRemoteBranchExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../push-guard.js', () => ({
  evaluatePushGuard: mockEvaluatePushGuard,
}));

// ---------------------------------------------------------------------------
// Logger with jest-style spies on info/warn/error.
// ---------------------------------------------------------------------------
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// GitHub client — one trusted unresolved thread pushes the handler past
// Case A + Case B branches into the spawn/commit path.
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
  defaultRemoteBranchExists: mockDefaultRemoteBranchExists,
}));

// Import AFTER mocks so the handler sees them.
import { PrFeedbackHandler } from '../pr-feedback-handler.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

// ---------------------------------------------------------------------------
// Child-process mock — mirror the push-guard test-file pattern.
// ---------------------------------------------------------------------------
function createMockProcess(exitCode = 0, exitDelay = 5) {
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

type Call = readonly unknown[];

function findLogCall(spy: unknown, field: string, value: unknown): Call | undefined {
  const calls = (spy as { mock: { calls: Call[] } }).mock.calls;
  return calls.find((call) => {
    const obj = call[0] as Record<string, unknown> | undefined;
    return obj !== undefined && obj !== null && obj[field] === value;
  });
}

function labelAdded(label: string): boolean {
  const calls = (mockGitHub.addLabels as unknown as { mock: { calls: Call[] } }).mock.calls;
  return calls.some((call) => {
    const labels = call[3] as string[] | undefined;
    return Array.isArray(labels) && labels.includes(label);
  });
}

describe('PrFeedbackHandler CLI-self-commit detection (#1073)', () => {
  let handler: PrFeedbackHandler;
  let getHeadShaSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
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
    // has_changes: false → commitAndPushChanges returns false.
    mockGitHub.getStatus.mockResolvedValue({
      has_changes: false,
      staged: [],
      unstaged: [],
      untracked: [],
      branch: 'feature-100',
      hasUnpushed: false,
      unpushedCount: 0,
    });
    mockGitHub.getIssue.mockResolvedValue({
      number: 100,
      title: 'issue',
      state: 'open',
      labels: [],
      assignees: [],
      body: '',
      created_at: '',
      updated_at: '',
    });

    const spawnFn = vi.fn().mockReturnValue(createMockProcess(0, 5));
    const processFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const agentLauncher = new AgentLauncher(new Map([['default', processFactory]]));
    agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
    handler = new PrFeedbackHandler(defaultConfig, mockLogger, agentLauncher);

    // Per-scenario SHAs drive `preFixSha` and `postCliSha`. Default stubs
    // return `null` so tests must opt in explicitly.
    getHeadShaSpy = vi.spyOn(
      handler as unknown as { getHeadSha: (p: string) => Promise<string | null> },
      'getHeadSha',
    );
  });

  // -------------------------------------------------------------------------
  // T-SC-001 (FR-009 / SC-001)
  // -------------------------------------------------------------------------
  it('T-SC-001: CLI-self-commit → zero blocked-label calls + reply/resolve runs', async () => {
    getHeadShaSpy
      .mockResolvedValueOnce('sha-A') // preFixSha
      .mockResolvedValueOnce('sha-B'); // postCliSha

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    expect(labelAdded('blocked:stuck-feedback-loop')).toBe(false);
    expect(labelAdded('blocked:resolve-failed')).toBe(false);
    expect(labelAdded('blocked:fixer-timeout')).toBe(false);
    expect(labelAdded('blocked:fixer-timeout-no-progress')).toBe(false);
    expect(labelAdded('blocked:fixer-timeout-repeat')).toBe(false);

    // Reply and resolve fired for the one trusted unresolved thread.
    expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(1);
    expect(mockGitHub.resolveReviewThread).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // T-SC-002 (FR-010 / SC-002)
  // -------------------------------------------------------------------------
  it('T-SC-002: genuine no-diff cycle → blocked:stuck-feedback-loop', async () => {
    getHeadShaSpy
      .mockResolvedValueOnce('sha-A') // preFixSha
      .mockResolvedValueOnce('sha-A'); // postCliSha unchanged

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    expect(labelAdded('blocked:stuck-feedback-loop')).toBe(true);
    expect(labelAdded('blocked:resolve-failed')).toBe(false);
    // Reply/resolve did NOT run — cycle went to blocked-stuck disposition.
    expect(mockGitHub.replyToPRComment).not.toHaveBeenCalled();
    expect(mockGitHub.resolveReviewThread).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // T-SC-003 (SC-003 log audit)
  // -------------------------------------------------------------------------
  it('T-SC-003: exactly one disposition:cli-self-committed info line, no no-diff warn', async () => {
    getHeadShaSpy
      .mockResolvedValueOnce('sha-A')
      .mockResolvedValueOnce('sha-B');

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    const infoCalls = (mockLogger.info as unknown as { mock: { calls: Call[] } }).mock.calls;
    const dispositionCalls = infoCalls.filter((call) => {
      const obj = call[0] as Record<string, unknown> | undefined;
      return obj?.['disposition'] === 'cli-self-committed';
    });
    expect(dispositionCalls).toHaveLength(1);

    const payload = dispositionCalls[0][0] as Record<string, unknown>;
    expect(payload['preFixSha']).toBeDefined();
    expect(payload['postFixSha']).toBeDefined();

    const warnCalls = (mockLogger.warn as unknown as { mock: { calls: Call[] } }).mock.calls;
    const noDiffWarn = warnCalls.find((call) => {
      const msg = call[1] as string | undefined;
      return typeof msg === 'string' && /no-diff/i.test(msg);
    });
    expect(noDiffWarn).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // T-SC-004 (SC-004 unreachability)
  // -------------------------------------------------------------------------
  it('T-SC-004: no-diff cycle warn MUST NOT co-occur when postCliSha !== preFixSha', async () => {
    getHeadShaSpy
      .mockResolvedValueOnce('sha-A')
      .mockResolvedValueOnce('sha-B');

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    // The "No changes to commit" info line is emitted by commitAndPushChanges
    // when getStatus reports has_changes:false — that still fires on the
    // CLI-self-commit path because the handler's OWN commit step legitimately
    // finds nothing to do.
    const infoCalls = (mockLogger.info as unknown as { mock: { calls: Call[] } }).mock.calls;
    const noChangesInfo = infoCalls.find((call) => {
      const msg = call[1] as string | undefined;
      return typeof msg === 'string' && msg.startsWith('No changes to commit');
    });
    expect(noChangesInfo).toBeDefined();

    // The load-bearing assertion: the CONTRADICTORY warn line that historically
    // followed "No changes to commit" MUST NOT co-occur.
    const warnCalls = (mockLogger.warn as unknown as { mock: { calls: Call[] } }).mock.calls;
    const noDiffCycleWarn = warnCalls.find((call) => {
      const msg = call[1] as string | undefined;
      return typeof msg === 'string' && msg.startsWith('no-diff / push-failed cycle');
    });
    expect(noDiffCycleWarn).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // T-US4-B (FR-013)
  // -------------------------------------------------------------------------
  it('T-US4-B: head advanced + zero resolves → blocked:resolve-failed (NOT stuck-feedback-loop)', async () => {
    getHeadShaSpy
      .mockResolvedValueOnce('sha-A')
      .mockResolvedValueOnce('sha-B');

    // Force reply/resolve to fail so resolveSuccesses === 0.
    mockGitHub.resolveReviewThread.mockRejectedValue(new Error('GraphQL 500'));

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    expect(labelAdded('blocked:resolve-failed')).toBe(true);
    expect(labelAdded('blocked:stuck-feedback-loop')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T-US4-B-inverse (FR-013 complement)
  // -------------------------------------------------------------------------
  it('T-US4-B-inverse: head unchanged + zero resolves → blocked:stuck-feedback-loop', async () => {
    getHeadShaSpy
      .mockResolvedValueOnce('sha-A')
      .mockResolvedValueOnce('sha-A');

    mockGitHub.resolveReviewThread.mockRejectedValue(new Error('GraphQL 500'));

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    // Head unchanged + hasChanges:false → the B1/B2/B3 branch fires first
    // (no-diff disposition), so blocked:stuck-feedback-loop lands.
    expect(labelAdded('blocked:stuck-feedback-loop')).toBe(true);
    expect(labelAdded('blocked:resolve-failed')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T-Q4-caveat (FR-008a): long-form SHAs in payload.
  // -------------------------------------------------------------------------
  it('T-Q4-caveat: CLI-self-commit info payload carries long-form preFixSha + postFixSha', async () => {
    const longPre = 'a'.repeat(40);
    const longPost = 'b'.repeat(40);
    getHeadShaSpy
      .mockResolvedValueOnce(longPre)
      .mockResolvedValueOnce(longPost);

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    const call = findLogCall(mockLogger.info, 'disposition', 'cli-self-committed');
    expect(call).toBeDefined();
    const payload = call![0] as Record<string, unknown>;
    expect(payload['preFixSha']).toBe(longPre);
    expect(payload['postFixSha']).toBe(longPost);
    expect(payload['source']).toBe('cli');
  });
});
