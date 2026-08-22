// #1165 Corner 2 (FR-003 / FR-004) — `blocked:stuck-feedback-loop` remains the
// bounded stop on the default (flags-OFF) PR-feedback legacy path.
//
// The review/remediate epic (#1120) replaces `blocked:stuck-feedback-loop` with
// the resumable `waiting-for:remediation-limit` pause ONLY on the engine-native
// review/remediate path. On the legacy PR-feedback path — the default when both
// epic flags are OFF — the monitor skips all `blocked:*` labels, so this label
// is still the sole bounded stop for the #883 runaway. This is a behavior PIN,
// not new behavior: it asserts `blocked:stuck-feedback-loop` is still applied by
// `PrFeedbackHandler` on the `!cliSelfCommitted && (!success || !hasChanges)`
// disposition (`pr-feedback-handler.ts:45`/`:632`), so a refactor that retires
// the label globally trips here (SC-003).
//
// See `contracts/stuck-loop-doc-reconcile.md` Test assertion.
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

// Both epic flags default OFF — this config is the legacy PR-feedback path.
const legacyFlagsOffConfig: WorkerConfig = {
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

function labelAdded(label: string): boolean {
  const calls = (mockGitHub.addLabels as unknown as { mock: { calls: Call[] } }).mock.calls;
  return calls.some((call) => {
    const labels = call[3] as string[] | undefined;
    return Array.isArray(labels) && labels.includes(label);
  });
}

describe('PrFeedbackHandler flag-OFF legacy stuck-loop bound (#1165 Corner 2)', () => {
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
    // has_changes: false → the fixer produced no diff (no-diff disposition).
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
    handler = new PrFeedbackHandler(legacyFlagsOffConfig, mockLogger, agentLauncher);

    getHeadShaSpy = vi.spyOn(
      handler as unknown as { getHeadSha: (p: string) => Promise<string | null> },
      'getHeadSha',
    );
  });

  // FR-003 / FR-004 (SC-003): the CLI produced no self-commit (HEAD unchanged)
  // and no diff — the bounded-stop disposition still applies the label.
  it('applies blocked:stuck-feedback-loop on the no-diff / no-self-commit cycle', async () => {
    getHeadShaSpy
      .mockResolvedValueOnce('sha-A') // preFixSha
      .mockResolvedValueOnce('sha-A'); // postCliSha unchanged → !cliSelfCommitted

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    expect(labelAdded('blocked:stuck-feedback-loop')).toBe(true);
  });

  // The label is a terminal stop — reply/resolve must NOT run on this
  // disposition, so the loop is genuinely bounded (does not fall through to a
  // resolve pass that could re-arm the trigger).
  it('does not run reply/resolve when the stuck-loop bound fires', async () => {
    getHeadShaSpy
      .mockResolvedValueOnce('sha-A')
      .mockResolvedValueOnce('sha-A');

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    expect(mockGitHub.replyToPRComment).not.toHaveBeenCalled();
    expect(mockGitHub.resolveReviewThread).not.toHaveBeenCalled();
  });

  // Guard against silent retirement: the label is NOT a `waiting-for:*` gate on
  // this path. Only `blocked:stuck-feedback-loop` (a `blocked:*` label the
  // monitor skips) bounds the #883 runaway here.
  it('bounds the loop with a blocked:* label, not a waiting-for:remediation-limit gate', async () => {
    getHeadShaSpy
      .mockResolvedValueOnce('sha-A')
      .mockResolvedValueOnce('sha-A');

    await handler.handle(createQueueItem(), '/tmp/workspace/o/r');

    expect(labelAdded('blocked:stuck-feedback-loop')).toBe(true);
    expect(labelAdded('waiting-for:remediation-limit')).toBe(false);
  });
});
