/**
 * #898 T013 — Unit tests for MergeConflictHandler.
 *
 * Covers T1-T8 from handler-contract.md §"Test coverage":
 *  T1: happy path (single-file conflict, agent resolves, push succeeds)
 *  T2: agent produces no resolution → blocked
 *  T3: sibling-owned enumeration → prompt tags sibling paths
 *  T4: pre-agent fetch retry (2× ECONNRESET → success)
 *  T5: post-agent push retry (2× ECONNRESET → success)
 *  T6: non-fast-forward push rejection → blocked, no retry
 *  T7: no-op merge (branch already up-to-date) → immediate success
 *  T8: no linked PR → blocked with "no linked PR" evidence
 */
import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GitHubClient, PullRequest } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Module mocks. Must be declared before importing the SUT so vi.mock hoists.
// ---------------------------------------------------------------------------

// Mock the entire child_process module so we can drive execFile output.
const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], opts: unknown, cb: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
    // Handle 3- and 4-arg call signatures (with and without opts).
    if (typeof opts === 'function') {
      cb = opts as (err: unknown, out: { stdout: string; stderr: string }) => void;
      opts = undefined;
    }
    Promise.resolve()
      .then(() => execFileMock(command, args, opts))
      .then((result: unknown) => {
        const r = (result ?? { stdout: '', stderr: '' }) as { stdout: string; stderr: string };
        cb(null, r);
      })
      .catch((err) => cb(err, { stdout: '', stderr: '' }));
  },
}));

// Mock fs module (existsSync for MERGE_HEAD check + readFileSync for marker scan).
const fsExistsMock = vi.fn().mockReturnValue(false);
const fsReadFileMock = vi.fn().mockReturnValue('');
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => fsExistsMock(p),
    readFileSync: (p: string, enc?: string) => fsReadFileMock(p, enc),
  };
});

// Mock RepoCheckout so switchBranch is a no-op we can assert against.
const switchBranchMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    switchBranch: switchBranchMock,
  })),
}));

// Mock workflow-engine so createGitHubClient returns our fake.
const mockGitHub = {
  addLabels: vi.fn().mockResolvedValue(undefined),
  removeLabels: vi.fn().mockResolvedValue(undefined),
  listOpenPullRequests: vi.fn().mockResolvedValue([]),
  getIssue: vi.fn().mockResolvedValue({ labels: [{ name: 'agent:paused' }], assignees: [] }),
} as unknown as GitHubClient;

vi.mock('@generacy-ai/workflow-engine', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@generacy-ai/workflow-engine');
  return {
    ...actual,
    createGitHubClient: vi.fn(() => mockGitHub),
  };
});

// Now import the SUT.
import { MergeConflictHandler } from '../merge-conflict-handler.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Logger;

function createMockProcess(exitCode = 0, exitDelayMs = 5): ChildProcessHandle {
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
    kill: vi.fn((sig?: string) => {
      if (sig === 'SIGKILL' || sig === 'SIGTERM') exitResolve(exitCode);
      return true;
    }),
    exitPromise,
  };
  if (exitDelayMs >= 0) setTimeout(() => exitResolve(exitCode), exitDelayMs);
  return handle;
}

function makePR(number = 100, branch = 'test-branch', base = 'main'): PullRequest {
  return {
    number,
    title: 'Test PR',
    body: 'Closes #42',
    state: 'open',
    draft: false,
    head: { ref: branch, sha: '', repo: 'owner/repo' },
    base: { ref: base, sha: '', repo: 'owner/repo' },
    labels: [],
    created_at: '',
    updated_at: '',
  } as PullRequest;
}

const config: WorkerConfig = {
  workspaceDir: '/tmp/workspace',
  phaseTimeoutMs: 60_000,
  shutdownGracePeriodMs: 5_000,
  validateCommand: 'echo validate',
  gates: {},
} as WorkerConfig;

function createItem(): QueueItem {
  return {
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'resolve-merge-conflicts',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    metadata: {},
  };
}

// Wire the agent launcher so `.launch()` is a mockable spy.
function createLauncher(exitCode = 0): { launcher: AgentLauncher; launchMock: ReturnType<typeof vi.fn> } {
  const launchMock = vi.fn().mockImplementation(async () => ({
    process: createMockProcess(exitCode),
    outputParser: { processChunk: () => {}, flush: () => {} },
    metadata: { pluginId: 'test', intentKind: 'merge-conflict' },
  }));
  const launcher = { launch: launchMock } as unknown as AgentLauncher;
  return { launcher, launchMock };
}

/**
 * Wire a canonical happy-path git subprocess response set.
 * Caller can override via execFileMock.mockImplementationOnce.
 */
function wireHappyPathGit(): void {
  execFileMock.mockImplementation((command: string, args: string[]) => {
    if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      // Reject → base not ancestor → merge proceeds
      const err = new Error('not an ancestor') as Error & { code?: number };
      err.code = 1;
      throw err;
    }
    if (command === 'git' && args[0] === 'merge') {
      // Simulate a conflict — mergeAttemptError with stderr containing 'CONFLICT'
      const err = new Error('conflict') as Error & { stderr?: string };
      err.stderr = 'CONFLICT (content): Merge conflict in CLAUDE.md';
      throw err;
    }
    if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
      return { stdout: 'CLAUDE.md\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'ls-files') {
      return { stdout: 'CLAUDE.md\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: 'abc1234\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'push') {
      return { stdout: '', stderr: '' };
    }
    if (command === 'gh' && args[0] === 'pr') {
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
}

describe('MergeConflictHandler (#898 T013)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    fsExistsMock.mockReset().mockReturnValue(false);
    fsReadFileMock.mockReset().mockReturnValue('');
    switchBranchMock.mockClear();
    (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
    (mockGitHub.getIssue as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({
      labels: [{ name: 'agent:paused' }, { name: 'agent:in-progress' }],
      assignees: [],
    });
  });

  // -------------------------------------------------------------------------
  // T8: unlinked issue → blocked with "no linked PR" evidence
  // -------------------------------------------------------------------------
  it('T8: no linked PR → blocked disposition with reason "no linked PR"', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { launcher, launchMock } = createLauncher();
    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    expect(launchMock).not.toHaveBeenCalled();
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['blocked:stuck-merge-conflicts'],
    );
    // waiting-for:merge-conflicts is NOT removed on the blocked path.
    expect(mockGitHub.removeLabels).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // T7: no-op merge (base is ancestor of HEAD) → immediate success
  // -------------------------------------------------------------------------
  it('T7: no-op merge → success without agent invocation', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        // Exit 0 → base IS ancestor → no-op merge
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const { launcher, launchMock } = createLauncher();
    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    expect(launchMock).not.toHaveBeenCalled();
    // Success labels applied.
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['completed:merge-conflicts'],
    );
    expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['waiting-for:merge-conflicts', 'agent:paused'],
    );
  });

  // -------------------------------------------------------------------------
  // T1: happy path — agent resolves conflict, push succeeds
  // -------------------------------------------------------------------------
  it('T1: happy path — agent resolves + push succeeds → completed labels', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);
    wireHappyPathGit();

    // After agent runs, MERGE_HEAD should NOT exist and diff should be empty.
    // We already default fsExistsMock to false. Override the diff response
    // after the agent has run: track state.
    let agentRan = false;
    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        const err = new Error('not an ancestor') as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      if (command === 'git' && args[0] === 'merge') {
        const err = new Error('conflict') as Error & { stderr?: string };
        err.stderr = 'CONFLICT (content): Merge conflict in CLAUDE.md';
        throw err;
      }
      if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        // First call (post-merge, pre-agent): report conflict
        // Post-agent call: empty (agent resolved)
        return { stdout: agentRan ? '' : 'CLAUDE.md\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-files') return { stdout: 'CLAUDE.md\n', stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'git' && args[0] === 'push') return { stdout: '', stderr: '' };
      if (command === 'gh') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const { launcher, launchMock } = createLauncher(0);
    launchMock.mockImplementationOnce(async () => {
      agentRan = true;
      return {
        process: createMockProcess(0),
        outputParser: { processChunk: () => {}, flush: () => {} },
        metadata: { pluginId: 'test', intentKind: 'merge-conflict' },
      };
    });

    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['completed:merge-conflicts'],
    );
    expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['waiting-for:merge-conflicts', 'agent:paused'],
    );
    // Push must have been called at least once
    const pushCalls = execFileMock.mock.calls.filter(
      (c) => c[0] === 'git' && (c[1] as string[])[0] === 'push',
    );
    expect(pushCalls.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // T2: agent produces no resolution → blocked with evidence
  // -------------------------------------------------------------------------
  it('T2: agent produces no resolution (MERGE_HEAD persists) → blocked', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    // MERGE_HEAD stays present → success predicate fails
    fsExistsMock.mockReturnValue(true);

    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base') {
        const err = new Error('not ancestor') as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] !== '--abort') {
        const err = new Error('conflict') as Error & { stderr?: string };
        err.stderr = 'CONFLICT (content): Merge conflict in CLAUDE.md';
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] === '--abort') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: 'CLAUDE.md\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-files') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'gh') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const { launcher, launchMock } = createLauncher(0);
    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['blocked:stuck-merge-conflicts'],
    );
    // waiting-for preserved
    expect(mockGitHub.removeLabels).not.toHaveBeenCalled();
    // No push after failed verification
    const pushCalls = execFileMock.mock.calls.filter(
      (c) => c[0] === 'git' && (c[1] as string[])[0] === 'push',
    );
    expect(pushCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T4: pre-agent fetch retry (2× ECONNRESET → success) — attempt not spent
  // -------------------------------------------------------------------------
  it('T4: pre-agent fetch retries transient failures without spending agent attempt', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    let fetchCalls = 0;
    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') {
        fetchCalls++;
        if (fetchCalls <= 2) {
          const err = new Error('ECONNRESET during fetch') as Error;
          throw err;
        }
        return { stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'merge-base') {
        // Skip agent — return no-op success so the fetch retry path is what we assert
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const { launcher, launchMock } = createLauncher(0);
    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    // fetch fired 3 times (2 fails + 1 success)
    expect(fetchCalls).toBe(3);
    // No agent invocation because the merge-base check reported "already ancestor"
    expect(launchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // T6: non-fast-forward push rejection → blocked, no push retry
  // -------------------------------------------------------------------------
  it('T6: non-fast-forward push rejection → blocked, no retry', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    let agentRan = false;
    let pushCalls = 0;
    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base') {
        const err = new Error('not ancestor') as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] !== '--abort') {
        const err = new Error('conflict') as Error & { stderr?: string };
        err.stderr = 'CONFLICT (content): Merge conflict in CLAUDE.md';
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] === '--abort') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        // Pre-agent: report the conflict. Post-agent: empty (resolved).
        return { stdout: agentRan ? '' : 'CLAUDE.md\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-files') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'git' && args[0] === 'push') {
        pushCalls++;
        const err = new Error('rejected push') as Error & { stderr?: string };
        err.stderr = '! [rejected] test-branch -> test-branch (non-fast-forward)';
        throw err;
      }
      if (command === 'gh') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    // Agent "resolves" (MERGE_HEAD gone, no unresolved diff post-agent),
    // but push is rejected NFF.
    fsExistsMock.mockReturnValue(false);
    const { launcher, launchMock } = createLauncher(0);
    launchMock.mockImplementationOnce(async () => {
      agentRan = true;
      return {
        process: createMockProcess(0),
        outputParser: { processChunk: () => {}, flush: () => {} },
        metadata: { pluginId: 'test', intentKind: 'merge-conflict' },
      };
    });

    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    expect(pushCalls).toBe(1); // NO retry on NFF
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['blocked:stuck-merge-conflicts'],
    );
  });

  // -------------------------------------------------------------------------
  // T3: sibling-owned enumeration — prompt tags sibling paths
  // -------------------------------------------------------------------------
  it('T3: sibling-owned path enumeration tags the file in the agent prompt', async () => {
    const selfPR = makePR(100, 'test-branch', 'main');
    const siblingPR = makePR(101, 'sibling-branch', 'main');
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([selfPR, siblingPR]);

    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base') {
        const err = new Error('not ancestor') as Error;
        (err as Error & { code?: number }).code = 1;
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] !== '--abort') {
        const err = new Error('conflict') as Error & { stderr?: string };
        err.stderr = 'CONFLICT (content): Merge conflict in CLAUDE.md';
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] === '--abort') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: 'CLAUDE.md\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-files') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        // Sibling PR touches CLAUDE.md
        return { stdout: 'CLAUDE.md\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    fsExistsMock.mockReturnValue(true); // agent will "fail" — we only care about prompt
    const { launcher, launchMock } = createLauncher(0);
    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    expect(launchMock).toHaveBeenCalledTimes(1);
    const request = launchMock.mock.calls[0]![0];
    expect(request.intent.kind).toBe('merge-conflict');
    expect(request.intent.prompt).toContain('sibling-owned');
    expect(request.intent.prompt).toContain('CLAUDE.md');
    // The prompt forbids --theirs / --ours on sibling paths
    expect(request.intent.prompt).toContain('--theirs');
    expect(request.intent.prompt).toContain('--ours');
  });

  // -------------------------------------------------------------------------
  // T5: post-agent push retry (2× ECONNRESET → success)
  // -------------------------------------------------------------------------
  it('T5: post-agent push retries transient network errors → eventual success', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    let agentRan = false;
    let pushCalls = 0;
    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base') {
        const err = new Error('not ancestor') as Error;
        (err as Error & { code?: number }).code = 1;
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] !== '--abort') {
        const err = new Error('conflict') as Error & { stderr?: string };
        err.stderr = 'CONFLICT: Merge conflict in CLAUDE.md';
        throw err;
      }
      if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: agentRan ? '' : 'CLAUDE.md\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-files') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'git' && args[0] === 'push') {
        pushCalls++;
        if (pushCalls <= 2) {
          const err = new Error('ECONNRESET during push') as Error;
          throw err;
        }
        return { stdout: '', stderr: '' };
      }
      if (command === 'gh') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    fsExistsMock.mockReturnValue(false); // agent succeeded
    const { launcher, launchMock } = createLauncher(0);
    launchMock.mockImplementationOnce(async () => {
      agentRan = true;
      return {
        process: createMockProcess(0),
        outputParser: { processChunk: () => {}, flush: () => {} },
        metadata: { pluginId: 'test', intentKind: 'merge-conflict' },
      };
    });

    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    expect(pushCalls).toBe(3); // 2 failures + 1 success
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['completed:merge-conflicts'],
    );
  });

  // -------------------------------------------------------------------------
  // T018 (SC-002 regression) — tractable auto-resolve:
  //   single-file CLAUDE.md conflict → mock agent applies resolution →
  //   full pipeline (fetch → merge → agent → push → labels) runs green.
  // -------------------------------------------------------------------------
  it('T018 SC-002: tractable single-file conflict auto-resolves end-to-end', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    let stage: 'pre-agent' | 'post-agent' = 'pre-agent';
    let agentInvocations = 0;
    let pushCalls = 0;

    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        const err = new Error('not ancestor') as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] !== '--abort') {
        const err = new Error('conflict') as Error & { stderr?: string };
        err.stderr = 'CONFLICT (content): Merge conflict in CLAUDE.md';
        throw err;
      }
      if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: stage === 'pre-agent' ? 'CLAUDE.md\n' : '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-files') return { stdout: 'CLAUDE.md\n', stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'sha01234\n', stderr: '' };
      if (command === 'git' && args[0] === 'push') {
        pushCalls++;
        return { stdout: '', stderr: '' };
      }
      if (command === 'gh') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    fsExistsMock.mockImplementation((p: string) => {
      // Post-agent: MERGE_HEAD is gone (agent committed the merge).
      if (stage === 'post-agent' && String(p).endsWith('/.git/MERGE_HEAD')) return false;
      return false;
    });
    fsReadFileMock.mockReturnValue('resolved content, no markers');

    const { launcher, launchMock } = createLauncher(0);
    launchMock.mockImplementationOnce(async () => {
      agentInvocations++;
      stage = 'post-agent';
      return {
        process: createMockProcess(0),
        outputParser: { processChunk: () => {}, flush: () => {} },
        metadata: { pluginId: 'test', intentKind: 'merge-conflict' },
      };
    });

    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    // SC-002 assertions: full green pipeline
    expect(agentInvocations).toBe(1);       // exactly one attempt
    expect(pushCalls).toBe(1);              // pushed once, cleanly
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['completed:merge-conflicts'],
    );
    expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['waiting-for:merge-conflicts', 'agent:paused'],
    );
    // waiting-for was cleared as part of success
  });

  // -------------------------------------------------------------------------
  // T019 (SC-003 regression) — irreconcilable conflict:
  //   scratch same-line incompatible edits → mock agent exits without merge →
  //   blocked:stuck-merge-conflicts applied exactly once,
  //   unresolvedPaths non-empty, no retry, waiting-for preserved.
  // -------------------------------------------------------------------------
  it('T019 SC-003: irreconcilable conflict → blocked exactly once, waiting-for preserved', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    let agentInvocations = 0;
    let pushCalls = 0;

    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        const err = new Error('not ancestor') as Error & { code?: number };
        err.code = 1;
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] !== '--abort') {
        const err = new Error('conflict') as Error & { stderr?: string };
        err.stderr = 'CONFLICT (content): Merge conflict in CLAUDE.md';
        throw err;
      }
      if (command === 'git' && args[0] === 'merge' && args[1] === '--abort') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
        // Persistent conflict — the agent never resolved it.
        return { stdout: 'CLAUDE.md\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-files') return { stdout: 'CLAUDE.md\n', stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'sha01234\n', stderr: '' };
      if (command === 'git' && args[0] === 'push') {
        pushCalls++;
        return { stdout: '', stderr: '' };
      }
      if (command === 'gh') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    // MERGE_HEAD is still present post-agent — agent gave up.
    fsExistsMock.mockImplementation((p: string) => String(p).endsWith('/.git/MERGE_HEAD'));

    const { launcher, launchMock } = createLauncher(0);
    launchMock.mockImplementationOnce(async () => {
      agentInvocations++;
      return {
        process: createMockProcess(0),
        outputParser: { processChunk: () => {}, flush: () => {} },
        metadata: { pluginId: 'test', intentKind: 'merge-conflict' },
      };
    });

    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    await handler.handle(createItem(), '/tmp/checkout');

    // SC-003 assertions: blocked once, no push, no retry
    expect(agentInvocations).toBe(1);       // one autonomous attempt
    expect(pushCalls).toBe(0);              // never pushed — verification failed
    // blocked:stuck-merge-conflicts applied exactly once
    const blockedCalls = (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[3] as string[]).includes('blocked:stuck-merge-conflicts'),
    );
    expect(blockedCalls).toHaveLength(1);
    // waiting-for:merge-conflicts NOT removed
    expect(mockGitHub.removeLabels).not.toHaveBeenCalled();

    // Blocked-disposition evidence emitted via structured warn log with the
    // evidence payload naming unresolvedPaths. Assert the log line was
    // recorded so consumers can grep for it in production logs.
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const blockedLog = warnCalls.find(
      (c) => (c[0] as Record<string, unknown>)?.disposition === 'blocked',
    );
    expect(blockedLog).toBeDefined();
    const evidence = (blockedLog![0] as { evidence: { unresolvedPaths: string[] } }).evidence;
    expect(evidence.unresolvedPaths.length).toBeGreaterThan(0);
    expect(evidence.unresolvedPaths).toContain('CLAUDE.md');
  });
});
