/**
 * Integration tests for author-trust gating in the pr-feedback surface
 * (#842). Covers FR-006, SC-001, SC-003.
 */
import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PrFeedbackHandler } from '../pr-feedback-handler.js';
import type { WorkerConfig } from '../config.js';
import type { AgentLauncher, LaunchHandle } from '../../launcher/agent-launcher.js';
import type { ChildProcessHandle, Logger } from '../types.js';

// mockGitHub is populated per-test.
const mockGitHub: Record<string, ReturnType<typeof vi.fn>> = {
  getPullRequest: vi.fn(),
  getPRReviewThreads: vi.fn(),
  getStatus: vi.fn(),
  removeLabels: vi.fn(),
  replyToPRComment: vi.fn(),
};

// #861: wrap comments as ReviewThread[] (each comment becomes its own thread).
function asThreads(comments: Array<{ id: number; resolved?: boolean; [k: string]: unknown }>) {
  return comments.map(c => {
    const { resolved, ...rest } = c;
    return {
      rootCommentId: c.id,
      isResolved: resolved === true,
      comments: [{ author: 'reviewer', created_at: '', updated_at: '', ...rest }],
    };
  });
}

vi.mock('@generacy-ai/workflow-engine', async () => {
  const actual = await vi.importActual<typeof import('@generacy-ai/workflow-engine')>(
    '@generacy-ai/workflow-engine',
  );
  return {
    ...actual,
    createGitHubClient: vi.fn(() => mockGitHub),
    tryLoadCommentTrustConfig: vi.fn(() => undefined),
  };
});

vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    switchBranch: vi.fn().mockResolvedValue(undefined),
  })),
}));

function makeLogger(): Logger {
  const l: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
  } as unknown as Logger;
  return l;
}

function makeChildProcess(exitCode = 0): ChildProcessHandle {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitResolve: (code: number | null) => void = () => {};
  const exitPromise = new Promise<number | null>((r) => { exitResolve = r; });
  setTimeout(() => exitResolve(exitCode), 5);
  return {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 12345,
    kill: vi.fn(() => true),
    exitPromise,
  };
}

function makeLauncher(): AgentLauncher {
  return {
    launch: vi.fn().mockResolvedValue({
      process: makeChildProcess(0),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as unknown as LaunchHandle),
  } as unknown as AgentLauncher;
}

function makeConfig(): WorkerConfig {
  return {
    workspaceDir: '/tmp/ws',
    shutdownGracePeriodMs: 100,
    phaseTimeoutMs: 30_000,
    credentialRole: undefined,
    validateCommand: 'pnpm test',
    preValidateCommand: undefined,
  } as unknown as WorkerConfig;
}

describe('PR-feedback author-trust gating (FR-006)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub.getPullRequest.mockResolvedValue({
      number: 100,
      head: { ref: 'test-branch' },
    });
    mockGitHub.getStatus.mockResolvedValue({
      has_changes: false,
      staged: [],
      unstaged: [],
      untracked: [],
    });
    mockGitHub.removeLabels.mockResolvedValue(undefined);
    mockGitHub.replyToPRComment.mockResolvedValue({ id: 1 });
  });

  it('filters NONE-authored PR review comment out (not surfaced to agent)', async () => {
    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 501,
        body: 'evil review comment with SECRET_PAYLOAD',
        author: 'eve',
        authorAssociation: 'NONE',
        resolved: false,
        path: 'src/x.ts',
        line: 1,
      },
      {
        id: 502,
        body: 'legitimate review',
        author: 'alice',
        authorAssociation: 'MEMBER',
        resolved: false,
        path: 'src/y.ts',
        line: 2,
      },
    ]));

    const logger = makeLogger();
    const handler = new PrFeedbackHandler(makeConfig(), logger, makeLauncher(), {
      isDuplicate: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      tryMarkProcessed: vi.fn().mockResolvedValue(true),
    }, undefined);
    await handler.handle(
      {
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 42,
        workflowName: 'speckit-feature',
        command: 'address-pr-feedback',
        priority: Date.now(),
        enqueuedAt: new Date().toISOString(),
        metadata: { prNumber: 100 },
      },
      '/tmp/checkout',
    );

    // Only the trusted comment should have been replied to.
    expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(1);
    const args = mockGitHub.replyToPRComment.mock.calls[0]!;
    expect(args[3]).toBe(502);
  });

  it('emits skip-log with no body substring (SC-003)', async () => {
    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 999,
        body: 'CANARY_SUBSTRING_MUST_NOT_LEAK',
        author: 'eve',
        authorAssociation: 'NONE',
        resolved: false,
      },
    ]));

    const logger = makeLogger();
    const handler = new PrFeedbackHandler(makeConfig(), logger, makeLauncher(), {
      isDuplicate: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      tryMarkProcessed: vi.fn().mockResolvedValue(true),
    }, undefined);
    await handler.handle(
      {
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 42,
        workflowName: 'speckit-feature',
        command: 'address-pr-feedback',
        priority: Date.now(),
        enqueuedAt: new Date().toISOString(),
        metadata: { prNumber: 100 },
      },
      '/tmp/checkout',
    );

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const skipLogs = infoCalls.filter(([first]) =>
      typeof first === 'object' && first !== null && (first as Record<string, unknown>).event === 'comment-skipped',
    );
    expect(skipLogs.length).toBe(1);

    const [meta] = skipLogs[0]!;
    const m = meta as Record<string, unknown>;
    expect(m.surface).toBe('pr-feedback');
    expect(m.commentId).toBe(999);
    expect(m.author).toBe('eve');
    expect(m.authorAssociation).toBe('NONE');
    expect(m.reason).toBe('none-untrusted');
    expect(m.body).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain('CANARY_SUBSTRING_MUST_NOT_LEAK');
  });

  it('passes trusted-tier comments through untouched', async () => {
    mockGitHub.getPRReviewThreads.mockResolvedValue(asThreads([
      {
        id: 601,
        body: 'looks good, small nit',
        author: 'alice',
        authorAssociation: 'MEMBER',
        resolved: false,
      },
      {
        id: 602,
        body: 'another suggestion',
        author: 'bob',
        authorAssociation: 'COLLABORATOR',
        resolved: false,
      },
    ]));

    const logger = makeLogger();
    const handler = new PrFeedbackHandler(makeConfig(), logger, makeLauncher(), {
      isDuplicate: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      tryMarkProcessed: vi.fn().mockResolvedValue(true),
    }, undefined);
    await handler.handle(
      {
        owner: 'test-owner',
        repo: 'test-repo',
        issueNumber: 42,
        workflowName: 'speckit-feature',
        command: 'address-pr-feedback',
        priority: Date.now(),
        enqueuedAt: new Date().toISOString(),
        metadata: { prNumber: 100 },
      },
      '/tmp/checkout',
    );

    // Both trusted comments get replies.
    expect(mockGitHub.replyToPRComment).toHaveBeenCalledTimes(2);
  });
});
