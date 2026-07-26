/**
 * Integration tests for the PR-feedback body-consumption path (#1047).
 *
 * Verifies that the handler:
 *  - Fetches review submissions in addition to inline threads
 *  - Merges review bodies into the fixer prompt (FR-002)
 *  - Enforces the per-finding gate against the just-pushed commit's touched
 *    file set (FR-003)
 *  - Applies Disposition C on gate failure (label + marker comment)
 *  - Honors the acknowledgment set on resume (FR-008)
 *
 * Scenarios: SC-001, SC-002, SC-003, SC-004 (positive + complement), SC-006,
 * SC-007.
 */
import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PrFeedbackHandler } from '../worker/pr-feedback-handler.js';
import type { GitHubClient, Review } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger, ProcessFactory } from '../worker/types.js';
import type { QueueItem, PrFeedbackMetadata } from '../types/index.js';
import type { WorkerConfig } from '../worker/config.js';
import { AgentLauncher } from '../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------
function makeLogger(): Logger {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => l,
  } as unknown as Logger;
  return l;
}

// ---------------------------------------------------------------------------
// Mock GitHub Client (populated per-test in beforeEach)
// ---------------------------------------------------------------------------
const mockGitHub = {
  getPullRequest: vi.fn(),
  getPRReviewThreads: vi.fn(),
  listReviews: vi.fn(),
  listPrCommentBodies: vi.fn(),
  postPrComment: vi.fn(),
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

// Per-test override for executeCommand — driven by `commitTouchedFiles` state.
// `git rev-parse --short HEAD` → 'abc1234'.
// `git diff --name-only origin/<base>..HEAD` → touched-files-list (per-test).
let touchedFilesForNextDiff: string[] = [];

vi.mock('@generacy-ai/workflow-engine', async () => {
  const actual = await vi.importActual<typeof import('@generacy-ai/workflow-engine')>(
    '@generacy-ai/workflow-engine',
  );
  return {
    ...actual,
    createGitHubClient: vi.fn(() => mockGitHub),
    isTrustedCommentAuthor: vi.fn(() => ({ trusted: true, reason: 'owner' })),
    normalizeLogin: (raw: string) => raw.trim().toLowerCase().replace(/\[bot\]$/, ''),
    tryLoadCommentTrustConfig: vi.fn(() => undefined),
    wrapUntrustedData: vi.fn((content: string) => content),
    executeCommand: vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return { exitCode: 0, stdout: touchedFilesForNextDiff.join('\n') + '\n', stderr: '' };
      }
      // rev-parse for short-SHA fallback
      return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
    }),
  };
});

vi.mock('../worker/repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    switchBranch: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// Process helper — mirrors pr-feedback-handler.test.ts pattern
// ---------------------------------------------------------------------------
function createMockProcess(exitCode = 0, exitDelay = 5) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitResolve: (code: number | null) => void = () => {};
  const exitPromise = new Promise<number | null>((r) => { exitResolve = r; });
  const handle: ChildProcessHandle = {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 12345,
    kill: vi.fn(() => true),
    exitPromise,
  };
  setTimeout(() => exitResolve(exitCode), exitDelay);
  return { handle };
}

const defaultConfig: WorkerConfig = {
  workspaceDir: '/tmp/workspace',
  phaseTimeoutMs: 60_000,
  shutdownGracePeriodMs: 5_000,
  validateCommand: 'pnpm test',
  gates: {},
} as unknown as WorkerConfig;

function createQueueItem(): QueueItem {
  const metadata: PrFeedbackMetadata = { prNumber: 100, reviewThreadIds: [1] };
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

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 1000,
    user: { login: 'reviewer' },
    body: '',
    state: 'CHANGES_REQUESTED',
    submittedAt: '2026-07-26T10:00:00Z',
    ...overrides,
  };
}

function makeThread(id: number, resolved: boolean, path?: string, line?: number) {
  return {
    id: `PRRT_${id}`,
    rootCommentId: id,
    isResolved: resolved,
    comments: [{
      id,
      path: path ?? 'src/x.ts',
      line: line ?? 1,
      body: `thread ${id}`,
      author: 'reviewer',
      authorAssociation: 'MEMBER',
      created_at: '',
      updated_at: '',
    }],
  };
}

function makeHandler(): { handler: PrFeedbackHandler; spawnFn: ReturnType<typeof vi.fn> } {
  const spawnFn = vi.fn();
  const processFactory = { spawn: spawnFn } as unknown as ProcessFactory;
  const agentLauncher = new AgentLauncher(new Map([['default', processFactory]]));
  agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
  const handler = new PrFeedbackHandler(defaultConfig, makeLogger(), agentLauncher);
  return { handler, spawnFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PrFeedbackHandler body-flow (#1047)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    touchedFilesForNextDiff = [];
    // Baseline: PR + at least one unresolved trusted thread (so handler
    // proceeds past Case A/B), CLI succeeds, commit lands, no marker comment.
    (mockGitHub.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 100,
      head: { ref: 'feature-branch' },
      base: { ref: 'develop' },
    });
    (mockGitHub.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeThread(1, false, 'src/inline.ts', 10),
    ]);
    (mockGitHub.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockGitHub.listPrCommentBodies as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockGitHub.postPrComment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_changes: true, staged: ['src/x.ts'], unstaged: [], untracked: [],
    });
    (mockGitHub.stageAll as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.commit as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.push as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.replyToPRComment as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
    (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.resolveReviewThread as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGitHub.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 42, labels: [{ name: 'waiting-for:implementation-review' }],
    });
  });

  it('SC-001: body-only finding on file outside diff → gate uses commit files; cycle advances when fixer touches it', async () => {
    (mockGitHub.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeReview({
        id: 500,
        user: { login: 'bot' },
        body: `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Finding:** Stale contract description
**Files:** docs/plan.md`,
      }),
    ]);
    // Fixer commit touches the body-named file.
    touchedFilesForNextDiff = ['docs/plan.md'];

    const { handler, spawnFn } = makeHandler();
    spawnFn.mockReturnValue(createMockProcess(0, 5).handle);

    await handler.handle(createQueueItem(), '/tmp/checkout');

    // Cycle advances: reply+resolve happen, Disposition C label NOT added.
    expect(mockGitHub.replyToPRComment).toHaveBeenCalled();
    expect(mockGitHub.resolveReviewThread).toHaveBeenCalled();
    expect(mockGitHub.addLabels).not.toHaveBeenCalledWith(
      'test-owner', 'test-repo', 42, ['blocked:body-finding-unaddressed'],
    );
    expect(mockGitHub.postPrComment).not.toHaveBeenCalled();
  });

  it('SC-002: same finding text posted inline and as body → both surface in the prompt (parity)', async () => {
    const findingText = 'stale-contract-marker-CANARY';
    (mockGitHub.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeThread(1, false, 'docs/plan.md', 3),
    ]);
    (mockGitHub.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeReview({
        id: 500,
        user: { login: 'bot' },
        body: `${findingText}\n\n<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Files:** docs/plan.md`,
      }),
    ]);
    touchedFilesForNextDiff = ['docs/plan.md'];

    const { handler, spawnFn } = makeHandler();
    spawnFn.mockReturnValue(createMockProcess(0, 5).handle);

    await handler.handle(createQueueItem(), '/tmp/checkout');

    // Prompt was assembled with BOTH inline thread and body content — the
    // spawn's arg list includes a prompt containing both the inline body
    // "thread 1" AND the body-finding canary text.
    const spawnArgs = spawnFn.mock.calls[0]![1] as string[];
    const prompt = spawnArgs.find(a => a.includes('PR #100'))!;
    expect(prompt).toContain('thread 1');
    expect(prompt).toContain(findingText);
  });

  it('SC-003: body-only finding, fixer produces no commits → Disposition B fires (blocked-stuck-feedback-loop); NOT Disposition A', async () => {
    (mockGitHub.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeReview({
        id: 500,
        user: { login: 'bot' },
        body: `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Files:** docs/plan.md`,
      }),
    ]);
    // No commit → getStatus returns no changes → Disposition B fires.
    (mockGitHub.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_changes: false, staged: [], unstaged: [], untracked: [],
    });

    const { handler, spawnFn } = makeHandler();
    spawnFn.mockReturnValue(createMockProcess(0, 5).handle);

    await handler.handle(createQueueItem(), '/tmp/checkout');

    // Cycle did NOT advance to Disposition A: no replies/resolves posted.
    expect(mockGitHub.replyToPRComment).not.toHaveBeenCalled();
    expect(mockGitHub.resolveReviewThread).not.toHaveBeenCalled();
    // Disposition B (no-commit) fires, not Disposition C — no commit means the
    // gate never runs. Both are "blocked" but distinct labels.
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-owner', 'test-repo', 42, ['blocked:stuck-feedback-loop'],
    );
  });

  it('SC-004 (positive): body with marker + **Files:** foo.md → gate uses foo.md', async () => {
    (mockGitHub.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeReview({
        id: 500,
        user: { login: 'bot' },
        body: `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Files:** path/to/foo.md`,
      }),
    ]);
    // Fixer commits SOMETHING but not the named file.
    touchedFilesForNextDiff = ['unrelated.md'];

    const { handler, spawnFn } = makeHandler();
    spawnFn.mockReturnValue(createMockProcess(0, 5).handle);

    await handler.handle(createQueueItem(), '/tmp/checkout');

    // Gate fires because path/to/foo.md was not touched → Disposition C.
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-owner', 'test-repo', 42, ['blocked:body-finding-unaddressed'],
    );
    const postBody = (mockGitHub.postPrComment as ReturnType<typeof vi.fn>).mock.calls[0]![3] as string;
    expect(postBody).toContain('<!-- generacy-cockpit:body-findings-unaddressed -->');
    expect(postBody).toContain('review #500 finding 1');
    expect(postBody).toContain('`path/to/foo.md`');
  });

  it('SC-004 (complement): body with marker but no **Files:** line → gate does not fire, cycle advances (FR-005)', async () => {
    (mockGitHub.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeReview({
        id: 500,
        user: { login: 'bot' },
        body: `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Finding:** No Files line here, older producer or free-form.`,
      }),
    ]);
    // Touch nothing named by the body — but the body has no gating constraints.
    touchedFilesForNextDiff = ['random.ts'];

    const { handler, spawnFn } = makeHandler();
    spawnFn.mockReturnValue(createMockProcess(0, 5).handle);

    await handler.handle(createQueueItem(), '/tmp/checkout');

    // No Disposition C — gate trivially satisfied when hasFilesLine is false.
    expect(mockGitHub.addLabels).not.toHaveBeenCalledWith(
      'test-owner', 'test-repo', 42, ['blocked:body-finding-unaddressed'],
    );
    // Happy-path: replies posted, threads resolved.
    expect(mockGitHub.replyToPRComment).toHaveBeenCalled();
  });

  it('SC-006: body with two findings (files A, B), commit touches only A → Disposition C enumerates Finding 2', async () => {
    (mockGitHub.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeReview({
        id: 700,
        user: { login: 'bot' },
        body: `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Files:** A.md

### Finding 2

**Files:** B.md`,
      }),
    ]);
    touchedFilesForNextDiff = ['A.md'];

    const { handler, spawnFn } = makeHandler();
    spawnFn.mockReturnValue(createMockProcess(0, 5).handle);

    await handler.handle(createQueueItem(), '/tmp/checkout');

    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'test-owner', 'test-repo', 42, ['blocked:body-finding-unaddressed'],
    );
    const postBody = (mockGitHub.postPrComment as ReturnType<typeof vi.fn>).mock.calls[0]![3] as string;
    // Enumerates only Finding 2 (the unaddressed one).
    expect(postBody).toContain('review #700 finding 2');
    expect(postBody).not.toContain('review #700 finding 1');
    expect(postBody).toContain('`B.md`');
  });

  it('SC-007: on resume with marker comment already present, the two findings are acknowledged; no re-gate; body still reaches prompt (FR-002)', async () => {
    const priorMarker = `<!-- generacy-cockpit:body-findings-unaddressed -->

⚠️ **Body findings not yet addressed by the fixer**

### Unaddressed findings

- \`bot\` review #700 finding 1 (files: \`A.md\`)
- \`bot\` review #700 finding 2 (files: \`B.md\`)`;

    (mockGitHub.listReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeReview({
        id: 700,
        user: { login: 'bot' },
        body: `<!-- generacy-cockpit:unanchored-findings -->

### Finding 1

**Files:** A.md

### Finding 2

**Files:** B.md`,
      }),
    ]);
    // Ack comment present.
    (mockGitHub.listPrCommentBodies as ReturnType<typeof vi.fn>).mockResolvedValue([priorMarker]);
    // Fixer touches NOTHING named by the body — normally would gate, but ack
    // set excludes both findings.
    touchedFilesForNextDiff = ['unrelated.md'];

    const { handler, spawnFn } = makeHandler();
    spawnFn.mockReturnValue(createMockProcess(0, 5).handle);

    await handler.handle(createQueueItem(), '/tmp/checkout');

    // Disposition C does NOT fire (both findings acknowledged).
    expect(mockGitHub.addLabels).not.toHaveBeenCalledWith(
      'test-owner', 'test-repo', 42, ['blocked:body-finding-unaddressed'],
    );
    // Body content still reached the fixer prompt — findings gate exclusion is
    // separate from prompt inclusion.
    const spawnArgs = spawnFn.mock.calls[0]![1] as string[];
    const prompt = spawnArgs.find(a => a.includes('PR #100'))!;
    expect(prompt).toContain('review body (no file anchor)');
    // Happy path (only inline thread needed to advance) — replies posted.
    expect(mockGitHub.replyToPRComment).toHaveBeenCalled();
  });
});
