import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrFeedbackHandler } from '../pr-feedback-handler.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type {
  ProcessFactory,
  ChildProcessHandle,
  Logger,
} from '../types.js';
import type { QueueItem, PrFeedbackMetadata } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';
import { RecordingProcessFactory } from '../../test-utils/recording-process-factory.js';

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
// Mock GitHub Client
// ---------------------------------------------------------------------------
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
} as unknown as GitHubClient;

// ---------------------------------------------------------------------------
// Mock createGitHubClient
// ---------------------------------------------------------------------------
vi.mock('@generacy-ai/workflow-engine', () => ({
  createGitHubClient: vi.fn(() => mockGitHub),
  // Author-trust helpers (#842). Default stubs pass every comment through
  // as trusted so existing test fixtures (comments without authorAssociation)
  // still exercise the trusted-path behaviors these tests were written for.
  isTrustedCommentAuthor: vi.fn(() => ({ trusted: true, reason: 'owner' })),
  // #874: normalizeLogin is used by the handler's FR-005 skip-warn context
  // extension. Match the real implementation exactly.
  normalizeLogin: (raw: string) => raw.trim().toLowerCase().replace(/\[bot\]$/, ''),
  tryLoadCommentTrustConfig: vi.fn(() => undefined),
  wrapUntrustedData: vi.fn((content: string) => content),
  // #883: handler calls `executeCommand('git', ['rev-parse', '--short', 'HEAD'], ...)`
  // for the short-SHA reply interpolation. Default returns a stable value.
  executeCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'abc1234\n', stderr: '' })),
}));

// ---------------------------------------------------------------------------
// Mock RepoCheckout
// ---------------------------------------------------------------------------
vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    switchBranch: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// Mock Process Helper
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
    pid: 12345,
    kill: vi.fn((signal?: string) => {
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        exitResolve(exitCode);
      }
      return true;
    }),
    exitPromise,
  };

  // Auto-exit after delay (negative means manual control)
  if (exitDelay >= 0) {
    setTimeout(() => exitResolve(exitCode), exitDelay);
  }

  return { handle, stdout, stderr, resolve: exitResolve! };
}

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------
const defaultConfig: WorkerConfig = {
  workspaceDir: '/tmp/workspace',
  phaseTimeoutMs: 60_000,
  shutdownGracePeriodMs: 5_000,
  validateCommand: 'pnpm test && pnpm build',
  gates: {},
};

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------
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

function createMockPR(branchName = 'feature-branch') {
  return {
    number: 100,
    title: 'Test PR',
    body: 'Closes #42',
    head: { ref: branchName },
    base: { ref: 'main' },
    state: 'open',
  };
}

// Returns a ReviewThread wrapping a single root Comment. The `resolved` flag
// becomes `isResolved` on the thread (#861 semantics). Call sites that
// previously did `.mockResolvedValue([createMockComment(1, false), ...])` now
// yield a `ReviewThread[]` — matches the shape `getPRReviewThreads` returns.
function createMockComment(id: number, resolved = false, path?: string, line?: number) {
  return {
    id: `PRRT_${id}`,
    rootCommentId: id,
    isResolved: resolved,
    comments: [
      {
        id,
        path: path || 'src/index.ts',
        line: line || 10,
        body: `Review comment ${id}`,
        author: 'reviewer',
        created_at: '',
        updated_at: '',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PrFeedbackHandler', () => {
  let handler: PrFeedbackHandler;
  let processFactory: ProcessFactory;
  let spawnFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    spawnFn = vi.fn();
    processFactory = { spawn: spawnFn } as unknown as ProcessFactory;
    const agentLauncher = new AgentLauncher(new Map([['default', processFactory]]));
    agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
    handler = new PrFeedbackHandler(
      defaultConfig,
      mockLogger,
      agentLauncher,
    );

    // Default mock implementations
    mockGitHub.getPullRequest = vi.fn().mockResolvedValue(createMockPR());
    mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([]);
    mockGitHub.getStatus = vi.fn().mockResolvedValue({ has_changes: false, staged: [], unstaged: [], untracked: [] });
    mockGitHub.stageAll = vi.fn().mockResolvedValue(undefined);
    mockGitHub.commit = vi.fn().mockResolvedValue(undefined);
    mockGitHub.push = vi.fn().mockResolvedValue(undefined);
    mockGitHub.replyToPRComment = vi.fn().mockResolvedValue(undefined);
    mockGitHub.removeLabels = vi.fn().mockResolvedValue(undefined);
    mockGitHub.addLabels = vi.fn().mockResolvedValue(undefined);
    mockGitHub.resolveReviewThread = vi.fn().mockResolvedValue(undefined);
  });

  describe('handle - missing metadata', () => {
    it('throws error when prNumber is missing from metadata', async () => {
      const item = createQueueItem();
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      await expect(handler.handle(item, checkoutPath)).rejects.toThrow(
        'Missing prNumber in metadata for address-pr-feedback command',
      );
    });
  });

  describe('handle - PR fetch failure', () => {
    it('throws error when getPullRequest fails', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1, 2] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPullRequest = vi.fn().mockRejectedValue(new Error('PR not found'));

      await expect(handler.handle(item, checkoutPath)).rejects.toThrow(
        'Failed to fetch PR #100',
      );
    });
  });

  describe('handle - no unresolved threads', () => {
    it('removes label and exits early when no unresolved comments exist', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1, 2] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      // All comments are resolved
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, true),
        createMockComment(2, true),
      ]);

      await handler.handle(item, checkoutPath);

      // Should not spawn CLI
      expect(spawnFn).not.toHaveBeenCalled();

      // Should remove label
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['waiting-for:address-pr-feedback'],
      );
    });
  });

  describe('handle - successful flow', () => {
    it('processes unresolved comments, commits changes, posts replies, and removes label', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1, 2] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      // Unresolved comments
      const unresolvedComments = [
        createMockComment(1, false, 'src/index.ts', 15),
        createMockComment(2, false, 'src/util.ts', 20),
      ];

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        ...unresolvedComments,
        createMockComment(3, true), // resolved, should be filtered out
      ]);

      // CLI succeeds
      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      // Has changes to commit
      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      await handler.handle(item, checkoutPath);

      // Should spawn CLI with correct prompt
      expect(spawnFn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '-p',
          '--output-format', 'stream-json',
          '--dangerously-skip-permissions',
          '--verbose',
          expect.stringContaining('PR #100'),
        ]),
        expect.objectContaining({
          cwd: checkoutPath,
        }),
      );

      // Should stage, commit, and push
      expect(mockGitHub.stageAll).toHaveBeenCalled();
      expect(mockGitHub.commit).toHaveBeenCalledWith(
        expect.stringContaining('Address PR #100 review feedback'),
      );
      expect(mockGitHub.push).toHaveBeenCalledWith('origin', 'feature-branch');

      // Should post replies to all unresolved threads with #883 body shape
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(2);
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        100,
        1,
        expect.stringContaining('Addressed in abc1234'),
      );
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        100,
        2,
        expect.stringContaining('Addressed in abc1234'),
      );

      // #883: should resolve every thread
      expect(mockGitHub.resolveReviewThread).toHaveBeenCalledTimes(2);
      expect(mockGitHub.resolveReviewThread).toHaveBeenCalledWith('PRRT_1');
      expect(mockGitHub.resolveReviewThread).toHaveBeenCalledWith('PRRT_2');

      // #926 FR-006: happy-path coalesces `waiting-for:*` and `agent:in-progress`
      // into a single removeLabels call.
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['waiting-for:address-pr-feedback', 'agent:in-progress'],
      );

      // Should NOT add blocked label on the happy path
      expect(mockGitHub.addLabels).not.toHaveBeenCalled();
    });
  });

  describe('handle - no changes to commit (#883 Disposition B)', () => {
    it('adds blocked:stuck-feedback-loop, keeps waiting-for label, no replies', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      // No changes
      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: false,
        staged: [],
        unstaged: [],
        untracked: [],
      });

      await handler.handle(item, checkoutPath);

      // Should not stage, commit, or push
      expect(mockGitHub.stageAll).not.toHaveBeenCalled();
      expect(mockGitHub.commit).not.toHaveBeenCalled();
      expect(mockGitHub.push).not.toHaveBeenCalled();

      // #883: NO replies, NO resolves, NO waiting-for removal
      expect(mockGitHub.replyToPRComment).not.toHaveBeenCalled();
      expect(mockGitHub.resolveReviewThread).not.toHaveBeenCalled();
      // #926 SC-004: waiting-for is retained on the blocked-stuck path, but
      // the `finally` clear removes `agent:in-progress` on every terminal
      // exit — so `removeLabels` IS called (with just the in-progress label).
      expect(mockGitHub.removeLabels).not.toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        expect.arrayContaining(['waiting-for:address-pr-feedback']),
      );
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['agent:in-progress'],
      );

      // #883: blocked:stuck-feedback-loop is added
      expect(mockGitHub.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['blocked:stuck-feedback-loop'],
      );
    });
  });

  describe('handle - CLI timeout (FR-013)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps label when CLI times out, even if partial changes are pushed', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      // Create process that doesn't exit on SIGTERM
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
          if (signal === 'SIGKILL') {
            exitResolve!(1);
          }
          return true;
        }),
        exitPromise,
      };

      spawnFn.mockReturnValue(handle);

      // Has partial changes
      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      const handlePromise = handler.handle(item, checkoutPath);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(60_000);

      // Should send SIGTERM
      expect(handle.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past grace period
      await vi.advanceTimersByTimeAsync(5_000);

      // Should send SIGKILL
      expect(handle.kill).toHaveBeenCalledWith('SIGKILL');

      await handlePromise;

      // FR-013: Should push partial changes
      expect(mockGitHub.push).toHaveBeenCalled();

      // FR-013: Should NOT post replies (CLI didn't complete)
      expect(mockGitHub.replyToPRComment).not.toHaveBeenCalled();

      // FR-013: Should NOT remove waiting-for label (keep for retry).
      // #926 SC-004: `finally` clear still runs for `agent:in-progress`.
      expect(mockGitHub.removeLabels).not.toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        expect.arrayContaining(['waiting-for:address-pr-feedback']),
      );
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['agent:in-progress'],
      );

      // #883: timeout → Disposition B → blocked label added
      expect(mockGitHub.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['blocked:stuck-feedback-loop'],
      );
    });
  });

  describe('handle - CLI failure (#883 Disposition B)', () => {
    it('adds blocked label, keeps waiting-for label, no replies, no resolves', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      // CLI fails
      const { handle } = createMockProcess(1, 50);
      spawnFn.mockReturnValue(handle);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: false,
        staged: [],
        unstaged: [],
        untracked: [],
      });

      await handler.handle(item, checkoutPath);

      // Should NOT post replies, resolves.
      expect(mockGitHub.replyToPRComment).not.toHaveBeenCalled();
      expect(mockGitHub.resolveReviewThread).not.toHaveBeenCalled();
      // #926 SC-004: waiting-for retained on blocked-stuck; `finally` clears
      // `agent:in-progress`.
      expect(mockGitHub.removeLabels).not.toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        expect.arrayContaining(['waiting-for:address-pr-feedback']),
      );
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['agent:in-progress'],
      );

      // #883: blocked:stuck-feedback-loop is added
      expect(mockGitHub.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['blocked:stuck-feedback-loop'],
      );
    });
  });

  describe('handle - partial resolve failure (#883 FR-010)', () => {
    it('removes waiting-for label when some resolves succeed and warns on failures', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1, 2, 3] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
        createMockComment(2, false),
        createMockComment(3, false),
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      // Middle thread's resolve fails, other two succeed → R = 2 ≥ 1 → success
      mockGitHub.resolveReviewThread = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('resolve failed transient'))
        .mockResolvedValueOnce(undefined);

      await handler.handle(item, checkoutPath);

      // All three replies + resolves attempted
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(3);
      expect(mockGitHub.resolveReviewThread).toHaveBeenCalledTimes(3);

      // One FR-010 warn for the persistently-failed thread
      const warnMessages = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[1] ?? ''));
      expect(
        warnMessages.some((m) => m.includes('resolveReviewThread persistently failed after retries')),
      ).toBe(true);

      // Should remove waiting-for:address-pr-feedback + agent:in-progress
      // (strict decrease met, happy-path coalesced clear — #926 FR-006).
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['waiting-for:address-pr-feedback', 'agent:in-progress'],
      );

      // Should NOT add blocked (R ≥ 1)
      expect(mockGitHub.addLabels).not.toHaveBeenCalled();
    });

    it('zero-resolve cycle (all fail) → Disposition B, no label removal', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      // All resolves fail → R = 0 → FR-006 tail
      mockGitHub.resolveReviewThread = vi.fn().mockRejectedValue(new Error('API error'));

      await handler.handle(item, checkoutPath);

      // Reply and resolve still attempted
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(1);
      expect(mockGitHub.resolveReviewThread).toHaveBeenCalledTimes(1);

      // #926 SC-004: waiting-for retained on FR-006 tail; `finally` clears
      // `agent:in-progress`.
      expect(mockGitHub.removeLabels).not.toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        expect.arrayContaining(['waiting-for:address-pr-feedback']),
      );
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['agent:in-progress'],
      );

      // Should add blocked:stuck-feedback-loop
      expect(mockGitHub.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['blocked:stuck-feedback-loop'],
      );
    });
  });

  describe('handle - label removal failure', () => {
    it('logs warning but does not throw when label removal fails', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      // Label removal fails
      mockGitHub.removeLabels = vi.fn().mockRejectedValue(new Error('API error'));

      // Should not throw
      await expect(handler.handle(item, checkoutPath)).resolves.toBeUndefined();

      // Should still attempt to remove label
      expect(mockGitHub.removeLabels).toHaveBeenCalled();
    });
  });

  describe('handle - push failure (#883 Disposition B)', () => {
    it('adds blocked label when push fails (hasChanges stays false)', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      // Push fails
      mockGitHub.push = vi.fn().mockRejectedValue(new Error('Push rejected'));

      // Should not throw (caught by inner try/catch)
      await expect(handler.handle(item, checkoutPath)).resolves.toBeUndefined();

      // Should NOT post replies or resolves (push failure → Disposition B)
      expect(mockGitHub.replyToPRComment).not.toHaveBeenCalled();
      expect(mockGitHub.resolveReviewThread).not.toHaveBeenCalled();

      // #926 SC-004: waiting-for retained on push-failure blocked-stuck;
      // `finally` clears `agent:in-progress`.
      expect(mockGitHub.removeLabels).not.toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        expect.arrayContaining(['waiting-for:address-pr-feedback']),
      );
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['agent:in-progress'],
      );

      // Should add blocked label
      expect(mockGitHub.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['blocked:stuck-feedback-loop'],
      );
    });
  });

  describe('buildFeedbackPrompt', () => {
    it('formats comments with file paths and line numbers', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1, 2] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      const comments = [
        createMockComment(1, false, 'src/index.ts', 15),
        createMockComment(2, false, 'src/util.ts', 20),
      ];

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue(comments);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      await handler.handle(item, checkoutPath);

      // Check the prompt passed to CLI
      expect(spawnFn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          expect.stringContaining('src/index.ts:15'),
        ]),
        expect.any(Object),
      );

      expect(spawnFn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          expect.stringContaining('src/util.ts:20'),
        ]),
        expect.any(Object),
      );
    });

    it('includes reviewer username in prompt', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      const thread = createMockComment(1, false);
      thread.comments[0]!.author = 'alice';
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([thread]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      await handler.handle(item, checkoutPath);

      expect(spawnFn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          expect.stringContaining('**alice**'),
        ]),
        expect.any(Object),
      );
    });

    it('includes instruction to not resolve threads (SC-006)', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      await handler.handle(item, checkoutPath);

      // SC-006: Prompt should tell Claude NOT to resolve threads
      expect(spawnFn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          expect.stringContaining('Do NOT resolve any review threads'),
        ]),
        expect.any(Object),
      );
    });
  });

  describe('commit message format', () => {
    it('includes PR number, issue number, and co-author', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      await handler.handle(item, checkoutPath);

      expect(mockGitHub.commit).toHaveBeenCalledWith(
        expect.stringContaining('Address PR #100 review feedback'),
      );
      expect(mockGitHub.commit).toHaveBeenCalledWith(
        expect.stringContaining('issue #42'),
      );
      expect(mockGitHub.commit).toHaveBeenCalledWith(
        expect.stringContaining('Co-Authored-By: Claude Sonnet 4.5'),
      );
    });
  });

  describe('#883: Thread resolution via resolveReviewThread', () => {
    it('resolves each trusted-unresolved thread exactly once after a successful cycle', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1, 2] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
        createMockComment(2, false),
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      await handler.handle(item, checkoutPath);

      // #883: exactly one reply and one resolve per thread
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(2);
      expect(mockGitHub.resolveReviewThread).toHaveBeenCalledTimes(2);
      expect(mockGitHub.resolveReviewThread).toHaveBeenCalledWith('PRRT_1');
      expect(mockGitHub.resolveReviewThread).toHaveBeenCalledWith('PRRT_2');
    });

    it('#883 SC-004: reply granularity — thread with root + 2 replies gets exactly one new reply', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      // Single thread with 3 comments (root + 2 replies); handler should
      // reply to the root once, not once per comment.
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        {
          id: 'PRRT_multi',
          rootCommentId: 100,
          isResolved: false,
          comments: [
            { id: 100, body: 'root', author: 'reviewer', created_at: '', updated_at: '' },
            { id: 101, body: 'reply-1', author: 'reviewer', created_at: '', updated_at: '', in_reply_to_id: 100 },
            { id: 102, body: 'reply-2', author: 'reviewer', created_at: '', updated_at: '', in_reply_to_id: 100 },
          ],
        },
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      await handler.handle(item, checkoutPath);

      // Exactly one reply targeting the root comment
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(1);
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        100,
        100, // rootCommentId
        expect.any(String),
      );
    });
  });

  describe('structured logging', () => {
    it('logs with structured context throughout processing', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true,
        staged: ['src/index.ts'],
        unstaged: [],
        untracked: [],
      });

      await handler.handle(item, checkoutPath);

      // Should log with structured context (prNumber, issueNumber, owner, repo)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 100,
          issueNumber: 42,
          owner: 'test-owner',
          repo: 'test-repo',
        }),
        expect.any(String),
      );
    });
  });

  describe('AgentLauncher path (T007)', () => {
    it('calls agentLauncher.launch() with correct PrFeedbackIntent and uses handle.process', async () => {
      const recordingFactory = new RecordingProcessFactory(0);
      const agentLauncher = new AgentLauncher(
        new Map([['default', recordingFactory]]),
      );
      agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());

      const launcherHandler = new PrFeedbackHandler(
        defaultConfig,
        mockLogger,
        agentLauncher,
      );

      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);

      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: false,
        staged: [],
        unstaged: [],
        untracked: [],
      });

      await launcherHandler.handle(item, checkoutPath);

      // AgentLauncher should have spawned via the recording factory
      expect(recordingFactory.calls).toHaveLength(1);
      const call = recordingFactory.calls[0];
      expect(call.command).toBe('claude');
      expect(call.args).toContain('-p');
      expect(call.args).toContain('--output-format');
      expect(call.args).toContain('stream-json');
      expect(call.args).toContain('--dangerously-skip-permissions');
      expect(call.args).toContain('--verbose');
      expect(call.cwd).toBe(checkoutPath);

      // The prompt should contain the PR number
      const promptArg = call.args[call.args.length - 1];
      expect(promptArg).toContain('PR #100');

      // The direct processFactory should NOT have been called
      expect(spawnFn).not.toHaveBeenCalled();
    });
  });

  describe('Snapshot test: spawn-arg composition (T008)', () => {
    it('launcher path produces correct spawn records', async () => {
      const launcherFactory = new RecordingProcessFactory(0);
      const agentLauncher = new AgentLauncher(
        new Map([['default', launcherFactory]]),
      );
      agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());

      const launcherHandler = new PrFeedbackHandler(
        defaultConfig,
        mockLogger,
        agentLauncher,
      );

      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      const checkoutPath = '/tmp/workspace/test-owner/test-repo';

      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);
      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: false,
        staged: [],
        unstaged: [],
        untracked: [],
      });

      await launcherHandler.handle(item, checkoutPath);

      expect(launcherFactory.calls).toHaveLength(1);

      // Snapshot command/args/cwd for regression detection (env excluded —
      // AgentLauncher's 3-layer merge includes process.env which varies between runs)
      const snapshotRecords = launcherFactory.calls.map(({ command, args, cwd }) => ({
        command,
        args,
        cwd,
      }));
      expect(snapshotRecords).toMatchSnapshot();
    });
  });

  // ==========================================================================
  // #869 → #879: handler terminal-path behavior (dedupe-clear removed;
  // in-flight queue state is self-clearing by construction). These tests
  // preserve non-dedupe behavior on each terminal path.
  // ==========================================================================
  describe('terminal-path behavior', () => {
    async function buildHandler() {
      const launcherFactory = new RecordingProcessFactory(0);
      const agentLauncher = new AgentLauncher(
        new Map([['default', launcherFactory]]),
      );
      agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
      const localHandler = new PrFeedbackHandler(
        defaultConfig,
        mockLogger,
        agentLauncher,
      );
      return { handler: localHandler };
    }

    it('H1: no unresolved threads → label removed + "No unresolved threads found" log', async () => {
      const { handler: localHandler } = await buildHandler();
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([]);
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [] });
      await localHandler.handle(item, '/tmp/checkout');

      expect(mockGitHub.removeLabels).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining('No unresolved threads found'),
      );
    });

    it('H2: zero-trusted → label NOT removed + no "No unresolved threads found" log', async () => {
      const { isTrustedCommentAuthor } = await import('@generacy-ai/workflow-engine');
      (isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>)
        .mockReturnValue({ trusted: false, reason: 'none-untrusted' });

      const { handler: localHandler } = await buildHandler();
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      await localHandler.handle(item, '/tmp/checkout');

      // #926 SC-004: waiting-for retained on Case B (FR-002); `finally`
      // clears `agent:in-progress` on every terminal exit.
      expect(mockGitHub.removeLabels).not.toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        expect.arrayContaining(['waiting-for:address-pr-feedback']),
      );
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['agent:in-progress'],
      );
      const removeCallMessages = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[1] ?? ''));
      expect(removeCallMessages.every((m) => !m.includes('No unresolved threads found'))).toBe(true);
      // #878 evidence shape: no top-level clusterIdentity /
      // normalizedClusterIdentity; per-skip carries viewerDidAuthor.
      const warnCall = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => typeof c[1] === 'string' && c[1].includes('Zero-trusted unresolved threads'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0]).toEqual(expect.objectContaining({ totalUnresolvedThreads: 1 }));
      expect(warnCall![0]).not.toHaveProperty('clusterIdentity');
      expect(warnCall![0]).not.toHaveProperty('normalizedClusterIdentity');
      expect(warnCall![0].untrustedSkips[0]).toEqual(
        expect.objectContaining({ viewerDidAuthor: null }),
      );
      expect(warnCall![0].untrustedSkips[0]).not.toHaveProperty('normalizedAuthor');

      // Restore mock for later tests.
      (isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>)
        .mockReturnValue({ trusted: true, reason: 'owner' });
    });

    it('H5: getPRReviewThreads throws → re-throws', async () => {
      const { handler: localHandler } = await buildHandler();
      mockGitHub.getPRReviewThreads = vi.fn().mockRejectedValue(new Error('gh api boom'));
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });

      await expect(localHandler.handle(item, '/tmp/checkout')).rejects.toThrow(/review threads/);
    });

    it('H7c: self-authored via viewerDidAuthor:true → trusted, no zero-trusted warn (#878)', async () => {
      // Use the real trust predicate to exercise the viewerDidAuthor path
      // end-to-end. Restore the module mock in finally.
      const workflowEngine = await import('@generacy-ai/workflow-engine');
      const real = await vi.importActual<typeof import('@generacy-ai/workflow-engine')>(
        '@generacy-ai/workflow-engine',
      );
      (workflowEngine.isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>)
        .mockImplementation(real.isTrustedCommentAuthor);

      try {
        const { handler: localHandler } = await buildHandler();

        mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
          {
            rootCommentId: 401,
            isResolved: false,
            comments: [{
              id: 401,
              body: 'cluster self-authored',
              author: 'generacy-ai',
              authorAssociation: 'NONE',
              viewerDidAuthor: true,
              created_at: '',
              updated_at: '',
            }],
          },
        ]);
        const item = createQueueItem({
          prNumber: 100,
          reviewThreadIds: [401],
        });

        await localHandler.handle(item, '/tmp/checkout');

        const infoMessages = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls
          .map((c) => String(c[1] ?? ''));
        expect(infoMessages.some((m) => m.includes('Skipped PR review comment'))).toBe(false);

        const warnMessages = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls
          .map((c) => String(c[1] ?? ''));
        expect(warnMessages.some((m) => m.includes('Zero-trusted unresolved threads'))).toBe(false);
      } finally {
        (workflowEngine.isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>)
          .mockReturnValue({ trusted: true, reason: 'owner' });
      }
    });

  });

  // ==========================================================================
  // #926 SC-004: structural clear of `agent:in-progress` on every terminal
  // return. Four scenarios, one per exit path — each asserts the post-return
  // label set. Fifth assertion pins the FR-006 coalescing on the happy path.
  // ==========================================================================
  describe('#926 SC-004: agent:in-progress cleared on every terminal return', () => {
    /**
     * Returns the label-name arrays that would remain "removed" after the
     * handler exits — i.e., the union of every `removeLabels` argument-array
     * observed on the mock. Used to assert both what WAS and WASN'T cleared.
     */
    function collectRemovedLabels(): string[] {
      const calls = (mockGitHub.removeLabels as unknown as ReturnType<typeof vi.fn>).mock.calls;
      return calls.flatMap((c) => c[3] as string[]);
    }

    it('happy path: coalesced single call clears both labels, `agent:in-progress` absent (SC-004 line 1, FR-006)', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);
      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);
      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true, staged: ['src/index.ts'], unstaged: [], untracked: [],
      });

      await handler.handle(item, '/tmp/workspace/test-owner/test-repo');

      // FR-006 coalescing: happy path invokes `removeLabels` with BOTH labels
      // in a single call. `finally` no-ops (both already absent).
      const happyPathCalls = (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => Array.isArray(c[3]) && (c[3] as string[]).includes('waiting-for:address-pr-feedback'),
      );
      expect(happyPathCalls).toHaveLength(1);
      expect(happyPathCalls[0]?.[3]).toEqual([
        'waiting-for:address-pr-feedback',
        'agent:in-progress',
      ]);

      // Terminal state: both labels have been removed.
      const removed = collectRemovedLabels();
      expect(removed).toContain('waiting-for:address-pr-feedback');
      expect(removed).toContain('agent:in-progress');
    });

    it('Case A (no unresolved threads): `agent:in-progress` absent, waiting-for removed (SC-004 line 2)', async () => {
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [] });
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([]);

      await handler.handle(item, '/tmp/workspace/test-owner/test-repo');

      const removed = collectRemovedLabels();
      // Case A calls `removeFeedbackLabel` explicitly, then `finally` clears
      // `agent:in-progress` — both labels end up removed via distinct calls.
      expect(removed).toContain('waiting-for:address-pr-feedback');
      expect(removed).toContain('agent:in-progress');
    });

    it('Case B (all comments untrusted): `agent:in-progress` absent, waiting-for retained by design (SC-004 line 3, FR-002)', async () => {
      const { isTrustedCommentAuthor } = await import('@generacy-ai/workflow-engine');
      (isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>)
        .mockReturnValue({ trusted: false, reason: 'none-untrusted' });

      try {
        const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
        mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
          createMockComment(1, false),
        ]);

        await handler.handle(item, '/tmp/workspace/test-owner/test-repo');

        const removed = collectRemovedLabels();
        // FR-002: `waiting-for:address-pr-feedback` MUST be retained on this
        // exit path (Case B). Only `agent:in-progress` is cleared.
        expect(removed).not.toContain('waiting-for:address-pr-feedback');
        expect(removed).toContain('agent:in-progress');
      } finally {
        (isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>)
          .mockReturnValue({ trusted: true, reason: 'owner' });
      }
    });

    it('blocked-stuck (CLI failed or no-diff): `agent:in-progress` absent, blocked + waiting-for retained (SC-004 line 4, both dispositions)', async () => {
      // Disposition B via CLI failure (no-diff path).
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);
      const { handle } = createMockProcess(1, 50); // CLI exits non-zero
      spawnFn.mockReturnValue(handle);
      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: false, staged: [], unstaged: [], untracked: [],
      });

      await handler.handle(item, '/tmp/workspace/test-owner/test-repo');

      const removed = collectRemovedLabels();
      expect(removed).not.toContain('waiting-for:address-pr-feedback');
      expect(removed).toContain('agent:in-progress');
      // `blocked:stuck-feedback-loop` was added, not removed — assert the add.
      expect(mockGitHub.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['blocked:stuck-feedback-loop'],
      );
    });

    it('blocked-stuck via zero-resolve tail (FR-006 tail at ~line 337): same post-state as CLI-failure disposition', async () => {
      // Second blocked-stuck exit path — commit landed but every resolve
      // failed. Same SC-004 assertion as the previous test but via the
      // ~line 337 return, not the ~line 302 return.
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
        createMockComment(1, false),
      ]);
      const { handle } = createMockProcess(0, 50);
      spawnFn.mockReturnValue(handle);
      mockGitHub.getStatus = vi.fn().mockResolvedValue({
        has_changes: true, staged: ['src/index.ts'], unstaged: [], untracked: [],
      });
      mockGitHub.resolveReviewThread = vi.fn().mockRejectedValue(new Error('API error'));

      await handler.handle(item, '/tmp/workspace/test-owner/test-repo');

      const removed = collectRemovedLabels();
      expect(removed).not.toContain('waiting-for:address-pr-feedback');
      expect(removed).toContain('agent:in-progress');
      expect(mockGitHub.addLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['blocked:stuck-feedback-loop'],
      );
    });

    it('thrown-error path: `finally` still clears `agent:in-progress` even when the try block throws', async () => {
      // Not one of the four documented terminal returns, but the `try/finally`
      // structural clear must also cover the thrown-error path — that is the
      // whole point of using `finally` (SC-004 invariant: no terminal path
      // leaves the label pinned).
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [1] });
      mockGitHub.getPullRequest = vi.fn().mockRejectedValue(new Error('boom'));

      await expect(
        handler.handle(item, '/tmp/workspace/test-owner/test-repo'),
      ).rejects.toThrow(/Failed to fetch PR/);

      const removed = collectRemovedLabels();
      expect(removed).toContain('agent:in-progress');
    });
  });
});
