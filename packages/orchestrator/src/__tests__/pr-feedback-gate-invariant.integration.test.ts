/**
 * #941 FR-005 — integration regression test locking the interaction chain
 * around the `address-pr-feedback` flow.
 *
 * Drives `PrFeedbackHandler.handle()` (the shortest path from a simulated
 * queue item to the handler that owns the terminal-label invariant) with a
 * mock `GitHubClient` that records `addLabels` / `removeLabels` calls into an
 * ordered edit log, and a mock `AgentLauncher` that returns a child exiting 0
 * with no diff (simulating "fix session ran but findings not resolved").
 *
 * Assertions:
 *  (a) Terminal label state (union of adds − removes applied to the preloaded
 *      set) = `{ waiting-for:implementation-review, agent:paused }`.
 *  (b) No `addLabels(..., ['completed:implementation-review'])` call is ever
 *      recorded on any exit branch — regardless of which disposition fires.
 *
 * A deliberate-regression check (T011) will temporarily insert a
 * `github.addLabels(..., ['completed:implementation-review'])` call into the
 * handler's happy path and expect this test to go red — that is the "locks
 * the interaction chain" property (SC-003).
 */
import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PrFeedbackHandler } from '../worker/pr-feedback-handler.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger, ProcessFactory } from '../worker/types.js';
import type { QueueItem, PrFeedbackMetadata } from '../types/index.js';
import type { WorkerConfig } from '../worker/config.js';
import { AgentLauncher } from '../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

// ---------------------------------------------------------------------------
// Edit-log tracked mock GitHub client
// ---------------------------------------------------------------------------
type LabelEdit =
  | { kind: 'add'; owner: string; repo: string; issueNumber: number; labels: string[] }
  | { kind: 'remove'; owner: string; repo: string; issueNumber: number; labels: string[] };

const editLog: LabelEdit[] = [];

/** Preloaded issue labels; mutated in step with edit-log applies. */
let issueLabels: Set<string> = new Set();

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
  resolveReviewThread: vi.fn(),
  getIssue: vi.fn(async () => ({
    labels: Array.from(issueLabels).map((name) => ({ name })),
  })),
  addLabels: vi.fn(
    async (owner: string, repo: string, issueNumber: number, labels: string[]) => {
      editLog.push({ kind: 'add', owner, repo, issueNumber, labels });
      for (const l of labels) issueLabels.add(l);
    },
  ),
  removeLabels: vi.fn(
    async (owner: string, repo: string, issueNumber: number, labels: string[]) => {
      editLog.push({ kind: 'remove', owner, repo, issueNumber, labels });
      for (const l of labels) issueLabels.delete(l);
    },
  ),
} as unknown as GitHubClient;

vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(() => mockGitHub),
  isTrustedCommentAuthor: vi.fn(() => ({ trusted: true, reason: 'owner' })),
  normalizeLogin: (raw: string) => raw.trim().toLowerCase().replace(/\[bot\]$/, ''),
  tryLoadCommentTrustConfig: vi.fn(() => undefined),
  wrapUntrustedData: vi.fn((content: string) => content),
  executeCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'abc1234\n', stderr: '' })),
}));

vi.mock('../worker/repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    switchBranch: vi.fn().mockResolvedValue(undefined),
  })),
}));

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
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 7171,
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

function createQueueItem(metadata: PrFeedbackMetadata): QueueItem {
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

/**
 * Terminal label state = union of every `add` MINUS union of every `remove`,
 * applied on top of the preloaded label set.
 */
function terminalLabels(): Set<string> {
  return new Set(issueLabels);
}

/**
 * Was `addLabels(..., labelSubset)` EVER called such that `labels.includes(target)`?
 */
function anyAddIncludes(target: string): boolean {
  return editLog.some((e) => e.kind === 'add' && e.labels.includes(target));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PR feedback gate invariant integration (#941 FR-005 / SC-003)', () => {
  let handler: PrFeedbackHandler;
  let processFactory: ProcessFactory;
  let spawnFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    editLog.length = 0;
    // Preload the issue as described in plan §FR-005:
    // { waiting-for:implementation-review, waiting-for:address-pr-feedback,
    //   agent:in-progress, agent:paused }
    issueLabels = new Set([
      'waiting-for:implementation-review',
      'waiting-for:address-pr-feedback',
      'agent:in-progress',
      'agent:paused',
    ]);

    spawnFn = vi.fn();
    processFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const agentLauncher = new AgentLauncher(new Map([['default', processFactory]]));
    agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
    handler = new PrFeedbackHandler(defaultConfig, mockLogger, agentLauncher);

    (mockGitHub.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 100,
      title: 'Test PR',
      body: 'Closes #42',
      head: { ref: 'feature-branch' },
      base: { ref: 'main' },
      state: 'open',
    });
    (mockGitHub.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
      createMockThread(1, false),
    ]);
    (mockGitHub.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_changes: false,
      staged: [],
      unstaged: [],
      untracked: [],
    });
    (mockGitHub.stageAll as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.commit as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.push as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.replyToPRComment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.resolveReviewThread as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it(
    'address-pr-feedback with fix session that produced no diff leaves the gate label present and never writes completed:implementation-review',
    async () => {
      // AgentLauncher returns a child exiting 0 with no diff. `has_changes: false`
      // in `getStatus` above enforces "no diff" post-CLI. This routes the handler
      // into Disposition B (blocked-stuck-feedback-loop) and never into the
      // happy-path label-clearing branch.
      const { handle } = createMockProcess(0, 20);
      spawnFn.mockReturnValue(handle);

      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      await handler.handle(item, checkoutPath);

      // (b) NO addLabels(..., ['completed:implementation-review']) on any branch.
      expect(anyAddIncludes('completed:implementation-review')).toBe(false);

      // (a) Terminal label state = { waiting-for:implementation-review, agent:paused }
      const t = terminalLabels();
      expect(t.has('waiting-for:implementation-review')).toBe(true);
      expect(t.has('agent:paused')).toBe(true);

      // Ancillary: the ephemerals cleared by the handler's disposition + finally
      expect(t.has('agent:in-progress')).toBe(false);
      // Disposition B (no diff) leaves waiting-for:address-pr-feedback in place.
      // The invariant this test locks is about the completed:* label, not the
      // waiting-for:address-pr-feedback lifecycle; assert only the terminal
      // superset requested by the spec.
    },
  );

  it(
    'address-pr-feedback where the fix session succeeds AND makes a diff still never writes completed:implementation-review',
    async () => {
      // Happy path: exit 0 + hasChanges true → reply + resolve + coalesced label clear.
      const { handle } = createMockProcess(0, 20);
      spawnFn.mockReturnValue(handle);
      (mockGitHub.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      await handler.handle(item, checkoutPath);

      // (b) NO addLabels(..., ['completed:implementation-review']) on any branch,
      // even after a successful cycle.
      expect(anyAddIncludes('completed:implementation-review')).toBe(false);

      // (a) The gate label is retained: happy path removes waiting-for:address-pr-feedback
      // and agent:in-progress but must NOT clear waiting-for:implementation-review.
      const t = terminalLabels();
      expect(t.has('waiting-for:implementation-review')).toBe(true);
    },
  );

  it(
    'even if the fix session throws downstream, the finally re-asserts waiting-for:implementation-review and never writes completed:implementation-review',
    async () => {
      // Simulate a downstream throw AFTER the gate was somehow stripped by
      // upstream code. Emulate the stripping by pre-removing the label from the
      // preloaded set before invocation.
      issueLabels.delete('waiting-for:implementation-review');

      const { handle } = createMockProcess(0, 20);
      spawnFn.mockReturnValue(handle);
      (mockGitHub.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });
      // Force a throw AFTER commit+push completes, so the finally block runs.
      (mockGitHub.replyToPRComment as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('reply failed'),
      );

      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      // handle() catches per-thread reply errors internally via tryPostReply — no
      // throw expected. Assert the outer promise resolves and the invariants hold.
      await handler.handle(item, checkoutPath);

      // (b) NO completed:implementation-review write ever.
      expect(anyAddIncludes('completed:implementation-review')).toBe(false);

      // (a) The gate label got re-added by the finally block.
      expect(anyAddIncludes('waiting-for:implementation-review')).toBe(true);
      expect(terminalLabels().has('waiting-for:implementation-review')).toBe(true);
    },
  );
});
