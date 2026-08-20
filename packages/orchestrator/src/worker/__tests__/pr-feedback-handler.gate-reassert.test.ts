/**
 * #941 FR-002 — unit coverage for `PrFeedbackHandler.ensureImplementationReviewGate`.
 *
 * Verified cases (from contracts/pr-feedback-gate-reassertion.md §Test surface):
 *  1. Happy path, gate present → no re-add, no `error` log.
 *  2. Happy path, gate missing → exactly one `error` log with
 *     `event: 'gate-label-missing-at-fix-exit'` + one
 *     `addLabels(..., ['waiting-for:implementation-review'])` call.
 *  3. Case B (no diff), gate missing → same log + re-add.
 *  4. Thrown-error path (`commitAndPushChanges` throws) → `finally` still runs
 *     check + re-add.
 *  5. `getIssue` throws → `warn` log, no re-add, no crash.
 *  6. `addLabels` re-add throws → `warn` log, `finally` completes without throwing.
 */
import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PrFeedbackHandler } from '../pr-feedback-handler.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger, ProcessFactory } from '../types.js';
import type { QueueItem, PrFeedbackMetadata } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Logger;

const mockGitHub = {
  getPullRequest: vi.fn(),
  getPRReviewThreads: vi.fn(),
  getStatus: vi.fn(),
  stageAll: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  replyToPRComment: vi.fn(),
  removeLabels: vi.fn(),
  addLabels: vi.fn(),
  resolveReviewThread: vi.fn(),
  getIssue: vi.fn(),
} as unknown as GitHubClient;

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

function createMockProcess(exitCode = 0, exitDelay = 10) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitResolve: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });

  const handle: ChildProcessHandle = {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 4242,
    kill: vi.fn((signal?: string) => {
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        exitResolve(exitCode);
      }
      return true;
    }),
    exitPromise,
  };

  if (exitDelay >= 0) {
    setTimeout(() => exitResolve(exitCode), exitDelay);
  }

  return { handle };
}

function createMockThread(id: number, resolved = false) {
  return {
    id: `PRRT_${id}`,
    rootCommentId: id,
    isResolved: resolved,
    comments: [
      {
        id,
        path: 'src/index.ts',
        line: 10,
        body: `Review comment ${id}`,
        author: 'reviewer',
        created_at: '',
        updated_at: '',
      },
    ],
  };
}

const defaultConfig: WorkerConfig = {
  workspaceDir: '/tmp/workspace',
  phaseTimeoutMs: 60_000,
  shutdownGracePeriodMs: 5_000,
  validateCommand: 'pnpm test && pnpm build',
  gates: {},
};

function createQueueItem(metadata?: PrFeedbackMetadata): QueueItem {
  return {
    owner: 'test-owner',
    repo: 'test-repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'address-pr-feedback',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    metadata: metadata as unknown as Record<string, unknown>,
  };
}

describe('PrFeedbackHandler.ensureImplementationReviewGate (#941 FR-002)', () => {
  let handler: PrFeedbackHandler;
  let processFactory: ProcessFactory;
  let spawnFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    spawnFn = vi.fn();
    processFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const agentLauncher = new AgentLauncher(new Map([['default', processFactory]]));
    agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
    handler = new PrFeedbackHandler(defaultConfig, mockLogger, agentLauncher);

    mockGitHub.getPullRequest = vi.fn().mockResolvedValue({
      number: 100,
      title: 'Test PR',
      body: 'Closes #42',
      head: { ref: 'feature-branch' },
      base: { ref: 'main' },
      state: 'open',
    });
    mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([]);
    mockGitHub.getStatus = vi.fn().mockResolvedValue({
      has_changes: false,
      staged: [],
      unstaged: [],
      untracked: [],
    });
    mockGitHub.stageAll = vi.fn().mockResolvedValue(undefined);
    mockGitHub.commit = vi.fn().mockResolvedValue(undefined);
    mockGitHub.push = vi.fn().mockResolvedValue(undefined);
    mockGitHub.replyToPRComment = vi.fn().mockResolvedValue(undefined);
    mockGitHub.removeLabels = vi.fn().mockResolvedValue(undefined);
    mockGitHub.addLabels = vi.fn().mockResolvedValue(undefined);
    mockGitHub.resolveReviewThread = vi.fn().mockResolvedValue(undefined);
    mockGitHub.getIssue = vi.fn().mockResolvedValue({ labels: [] });
  });

  it('Case 1: happy path with gate present — no re-add, no error log', async () => {
    const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
    const checkoutPath = '/tmp/workspace/test-owner/test-repo';

    // Simulate happy path: unresolved thread, CLI succeeds, diff exists,
    // reply + resolve succeed.
    mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([createMockThread(1, false)]);
    const { handle } = createMockProcess(0, 20);
    spawnFn.mockReturnValue(handle);
    mockGitHub.getStatus = vi.fn().mockResolvedValue({
      has_changes: true,
      staged: ['src/index.ts'],
      unstaged: [],
      untracked: [],
    });
    // Gate label IS present at exit.
    mockGitHub.getIssue = vi
      .fn()
      .mockResolvedValue({ labels: [{ name: 'waiting-for:implementation-review' }] });

    await handler.handle(item, checkoutPath);

    // No error log with the FR-002 event
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const feedbackEventErrors = errorCalls.filter(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)['event'] === 'gate-label-missing-at-fix-exit',
    );
    expect(feedbackEventErrors).toHaveLength(0);

    // No re-add of the gate label
    const addLabelsCalls = (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mock.calls;
    const gateReAdds = addLabelsCalls.filter((call) => {
      const labels = call[3] as string[];
      return Array.isArray(labels) && labels.includes('waiting-for:implementation-review');
    });
    expect(gateReAdds).toHaveLength(0);
  });

  it('Case 2: happy path with gate MISSING — exactly one error log and one re-add', async () => {
    const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
    const checkoutPath = '/tmp/workspace/test-owner/test-repo';

    mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([createMockThread(1, false)]);
    const { handle } = createMockProcess(0, 20);
    spawnFn.mockReturnValue(handle);
    mockGitHub.getStatus = vi.fn().mockResolvedValue({
      has_changes: true,
      staged: ['src/index.ts'],
      unstaged: [],
      untracked: [],
    });
    // Gate label is MISSING at exit
    mockGitHub.getIssue = vi.fn().mockResolvedValue({ labels: [] });

    await handler.handle(item, checkoutPath);

    // Exactly one error log with the event
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const gateMissingErrors = errorCalls.filter(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)['event'] === 'gate-label-missing-at-fix-exit',
    );
    expect(gateMissingErrors).toHaveLength(1);
    expect(gateMissingErrors[0]![0]).toMatchObject({
      event: 'gate-label-missing-at-fix-exit',
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 42,
      pr: 100,
    });

    // Exactly one addLabels call for the gate re-add
    const addLabelsCalls = (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mock.calls;
    const gateReAdds = addLabelsCalls.filter((call) => {
      const labels = call[3] as string[];
      return Array.isArray(labels) && labels.includes('waiting-for:implementation-review');
    });
    expect(gateReAdds).toHaveLength(1);
    expect(gateReAdds[0]).toEqual([
      'test-owner',
      'test-repo',
      42,
      ['waiting-for:implementation-review'],
    ]);
  });

  it('Case 3: Case B (no diff) + gate MISSING — same log + re-add', async () => {
    const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
    const checkoutPath = '/tmp/workspace/test-owner/test-repo';

    mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([createMockThread(1, false)]);
    const { handle } = createMockProcess(0, 20);
    spawnFn.mockReturnValue(handle);
    // No diff → Disposition B (blocked-stuck-feedback-loop)
    mockGitHub.getStatus = vi.fn().mockResolvedValue({
      has_changes: false,
      staged: [],
      unstaged: [],
      untracked: [],
    });
    mockGitHub.getIssue = vi.fn().mockResolvedValue({ labels: [] });

    await handler.handle(item, checkoutPath);

    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const gateMissingErrors = errorCalls.filter(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)['event'] === 'gate-label-missing-at-fix-exit',
    );
    expect(gateMissingErrors).toHaveLength(1);

    const addLabelsCalls = (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mock.calls;
    const gateReAdds = addLabelsCalls.filter((call) => {
      const labels = call[3] as string[];
      return Array.isArray(labels) && labels.includes('waiting-for:implementation-review');
    });
    expect(gateReAdds).toHaveLength(1);
  });

  it('Case 4: thrown-error path — finally still runs check + re-add', async () => {
    const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
    const checkoutPath = '/tmp/workspace/test-owner/test-repo';

    mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([createMockThread(1, false)]);
    const { handle } = createMockProcess(0, 20);
    spawnFn.mockReturnValue(handle);
    mockGitHub.getStatus = vi.fn().mockResolvedValue({
      has_changes: true,
      staged: ['src/index.ts'],
      unstaged: [],
      untracked: [],
    });
    // Make commitAndPushChanges throw by having push reject
    mockGitHub.push = vi.fn().mockRejectedValue(new Error('push failed'));
    mockGitHub.getIssue = vi.fn().mockResolvedValue({ labels: [] });

    // commitAndPush throw is caught within handle; but even if not, finally
    // runs. Case B branch also fires (hasChanges is false via the catch), so
    // this exercises the same path.
    await handler.handle(item, checkoutPath);

    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const gateMissingErrors = errorCalls.filter(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)['event'] === 'gate-label-missing-at-fix-exit',
    );
    expect(gateMissingErrors).toHaveLength(1);

    const addLabelsCalls = (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mock.calls;
    const gateReAdds = addLabelsCalls.filter((call) => {
      const labels = call[3] as string[];
      return Array.isArray(labels) && labels.includes('waiting-for:implementation-review');
    });
    expect(gateReAdds).toHaveLength(1);
  });

  it('Case 5: getIssue throws — warn log, no re-add, no crash', async () => {
    const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
    const checkoutPath = '/tmp/workspace/test-owner/test-repo';

    mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([createMockThread(1, false)]);
    const { handle } = createMockProcess(0, 20);
    spawnFn.mockReturnValue(handle);
    mockGitHub.getStatus = vi.fn().mockResolvedValue({
      has_changes: false,
      staged: [],
      unstaged: [],
      untracked: [],
    });
    // getIssue throws → the ensure helper must warn and swallow
    mockGitHub.getIssue = vi.fn().mockRejectedValue(new Error('getIssue failed'));

    await expect(handler.handle(item, checkoutPath)).resolves.toBeUndefined();

    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const readFailedWarns = warnCalls.filter(
      (call) =>
        typeof call[1] === 'string' &&
        (call[1] as string).includes('failed to read labels'),
    );
    expect(readFailedWarns.length).toBeGreaterThanOrEqual(1);

    // No error log emitted (we never learned the label state)
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const gateMissingErrors = errorCalls.filter(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)['event'] === 'gate-label-missing-at-fix-exit',
    );
    expect(gateMissingErrors).toHaveLength(0);

    // No re-add call
    const addLabelsCalls = (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mock.calls;
    const gateReAdds = addLabelsCalls.filter((call) => {
      const labels = call[3] as string[];
      return Array.isArray(labels) && labels.includes('waiting-for:implementation-review');
    });
    expect(gateReAdds).toHaveLength(0);
  });

  it('Case 6: addLabels re-add throws — warn log, finally completes without throwing', async () => {
    const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
    const checkoutPath = '/tmp/workspace/test-owner/test-repo';

    mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([createMockThread(1, false)]);
    const { handle } = createMockProcess(0, 20);
    spawnFn.mockReturnValue(handle);
    mockGitHub.getStatus = vi.fn().mockResolvedValue({
      has_changes: false,
      staged: [],
      unstaged: [],
      untracked: [],
    });
    mockGitHub.getIssue = vi.fn().mockResolvedValue({ labels: [] });
    // Gate is missing → we WILL try to re-add. Fail that call.
    mockGitHub.addLabels = vi.fn(async (_o, _r, _i, labels: string[]) => {
      if (labels.includes('waiting-for:implementation-review')) {
        throw new Error('addLabels re-add failed');
      }
    });

    await expect(handler.handle(item, checkoutPath)).resolves.toBeUndefined();

    // Error log for the missing gate still fires
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const gateMissingErrors = errorCalls.filter(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)['event'] === 'gate-label-missing-at-fix-exit',
    );
    expect(gateMissingErrors).toHaveLength(1);

    // Warn about the re-add failure
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const readdFailedWarns = warnCalls.filter(
      (call) =>
        typeof call[1] === 'string' &&
        (call[1] as string).includes('failed to re-add gate label'),
    );
    expect(readdFailedWarns.length).toBeGreaterThanOrEqual(1);
  });
});
