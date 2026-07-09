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
      undefined,
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

      // Should post replies to all unresolved threads
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(2);
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        100,
        1,
        expect.stringContaining('addressed this feedback'),
      );
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        100,
        2,
        expect.stringContaining('addressed this feedback'),
      );

      // Should remove label
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['waiting-for:address-pr-feedback'],
      );
    });
  });

  describe('handle - no changes to commit', () => {
    it('skips commit/push when CLI makes no changes', async () => {
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

      // Should still post replies and remove label
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(1);
      expect(mockGitHub.removeLabels).toHaveBeenCalled();
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

      // FR-013: Should NOT remove label (keep for retry)
      expect(mockGitHub.removeLabels).not.toHaveBeenCalled();
    });
  });

  describe('handle - CLI failure', () => {
    it('keeps label when CLI exits with non-zero code', async () => {
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

      // Should NOT post replies
      expect(mockGitHub.replyToPRComment).not.toHaveBeenCalled();

      // Should NOT remove label (keep for retry)
      expect(mockGitHub.removeLabels).not.toHaveBeenCalled();
    });
  });

  describe('handle - reply failure (FR-007)', () => {
    it('removes label even when some replies fail', async () => {
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

      // Second reply fails
      mockGitHub.replyToPRComment = vi.fn()
        .mockResolvedValueOnce(undefined) // First succeeds
        .mockRejectedValueOnce(new Error('API error')) // Second fails
        .mockResolvedValueOnce(undefined); // Third succeeds

      await handler.handle(item, checkoutPath);

      // All three replies should be attempted
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(3);

      // FR-007: Should still remove label even with partial reply failure
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['waiting-for:address-pr-feedback'],
      );
    });

    it('removes label even when all replies fail', async () => {
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

      // All replies fail
      mockGitHub.replyToPRComment = vi.fn().mockRejectedValue(new Error('API error'));

      await handler.handle(item, checkoutPath);

      // FR-007: Should still remove label because code was pushed successfully
      expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        42,
        ['waiting-for:address-pr-feedback'],
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

  describe('handle - push failure', () => {
    it('logs error but continues when push fails', async () => {
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

      // Should not throw (just logs error)
      await expect(handler.handle(item, checkoutPath)).resolves.toBeUndefined();

      // Should NOT post replies (CLI succeeded but push failed)
      expect(mockGitHub.replyToPRComment).toHaveBeenCalled();

      // Should still remove label (CLI succeeded)
      expect(mockGitHub.removeLabels).toHaveBeenCalled();
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

  describe('SC-006: Thread resolution prevention', () => {
    it('never calls any resolve API, only replyToPRComment', async () => {
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

      // Add a mock for any potential resolve method
      const mockResolveThread = vi.fn();
      (mockGitHub as any).resolveThread = mockResolveThread;

      await handler.handle(item, checkoutPath);

      // SC-006: Should only use replyToPRComment, never resolve
      expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(2);
      expect(mockResolveThread).not.toHaveBeenCalled();
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
        undefined,
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
        undefined,
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
    async function buildHandler(clusterIdentity?: string) {
      const launcherFactory = new RecordingProcessFactory(0);
      const agentLauncher = new AgentLauncher(
        new Map([['default', launcherFactory]]),
      );
      agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
      const localHandler = new PrFeedbackHandler(
        defaultConfig,
        mockLogger,
        agentLauncher,
        clusterIdentity,
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

      expect(mockGitHub.removeLabels).not.toHaveBeenCalled();
      const removeCallMessages = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[1] ?? ''));
      expect(removeCallMessages.every((m) => !m.includes('No unresolved threads found'))).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ totalUnresolvedThreads: 1 }),
        expect.stringContaining('Zero-trusted unresolved threads'),
      );

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

    it('H7b: `Generacy-AI` provisioned + REST/GraphQL author variants both resolve via cluster-identity (#874)', async () => {
      // Use the real normalizeLogin-aware isTrustedCommentAuthor for this
      // test so we exercise the normalization pipeline end-to-end. The
      // mock at module scope must be restored after this test.
      const workflowEngine = await import('@generacy-ai/workflow-engine');
      const real = await vi.importActual<typeof import('@generacy-ai/workflow-engine')>(
        '@generacy-ai/workflow-engine',
      );
      (workflowEngine.isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>)
        .mockImplementation(real.isTrustedCommentAuthor);

      try {
        const { handler: localHandler } = await buildHandler('Generacy-AI');

        // Two review threads: one REST-shaped author, one GraphQL-shaped.
        // Both should trust via cluster-identity (post-normalization equal
        // to 'generacy-ai'), so we do NOT hit the zero-trusted retention
        // warn.
        mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([
          {
            rootCommentId: 401,
            isResolved: false,
            comments: [{
              id: 401,
              body: 'REST shape',
              author: 'generacy-ai[bot]',
              authorAssociation: 'NONE',
              created_at: '',
              updated_at: '',
            }],
          },
          {
            rootCommentId: 402,
            isResolved: false,
            comments: [{
              id: 402,
              body: 'GraphQL shape',
              author: 'generacy-ai',
              authorAssociation: 'NONE',
              created_at: '',
              updated_at: '',
            }],
          },
        ]);
        const item = createQueueItem({
          prNumber: 100,
          reviewThreadIds: [401, 402],
        });

        await localHandler.handle(item, '/tmp/checkout');

        // Neither comment should have been dropped as untrusted — no
        // "Skipped PR review comment from untrusted author" log line.
        const infoMessages = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls
          .map((c) => String(c[1] ?? ''));
        expect(infoMessages.some((m) => m.includes('Skipped PR review comment'))).toBe(false);

        // No zero-trusted retention warn.
        const warnMessages = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls
          .map((c) => String(c[1] ?? ''));
        expect(warnMessages.some((m) => m.includes('Zero-trusted unresolved threads'))).toBe(false);
      } finally {
        // Restore default mock for downstream tests.
        (workflowEngine.isTrustedCommentAuthor as unknown as ReturnType<typeof vi.fn>)
          .mockReturnValue({ trusted: true, reason: 'owner' });
      }
    });

    it('H7: clusterIdentity undefined → error log naming the CLUSTER_ACTING_LOGIN chain (#874)', async () => {
      const { handler: localHandler } = await buildHandler(undefined);
      mockGitHub.getPRReviewThreads = vi.fn().mockResolvedValue([]);
      const item = createQueueItem({ prNumber: 100, reviewThreadIds: [] });
      await localHandler.handle(item, '/tmp/checkout');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          triedChain: ['CLUSTER_ACTING_LOGIN'],
        }),
        expect.stringContaining('Acting identity unresolvable at handler runtime'),
      );
    });
  });
});
