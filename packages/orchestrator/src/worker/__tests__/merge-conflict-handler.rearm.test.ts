/**
 * #902 T013 — End-to-end re-arm fixture.
 *
 * Drives: pause → handler success (agent-resolved) → worker builds
 * postComplete rearm payload → dispatcher enqueues the `continue` item
 * with the correct startPhase. Asserts observable state at each layer
 * (SC-002), not merely inferred from handler exit code.
 */
import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GitHubClient, PullRequest } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], opts: unknown, cb: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
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

const switchBranchMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({ switchBranch: switchBranchMock })),
}));

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

import { MergeConflictHandler } from '../merge-conflict-handler.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { assertHandlerOutcomeMatchesWorld } from '../handler-outcome-assertion.js';

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
  const exitPromise = new Promise<number | null>((resolve) => { exitResolve = resolve; });
  const handle: ChildProcessHandle = {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 4242,
    kill: () => true,
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

function createItem(phase: string): QueueItem {
  return {
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'resolve-merge-conflicts',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    metadata: { phase },
  };
}

describe('#902 T013 end-to-end re-arm', () => {
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

  it('agent-resolved success returns re-armed with metadata.phase; label edit is a single combined `removeLabels` (FR-007)', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    let agentRan = false;
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
        return { stdout: agentRan ? '' : 'CLAUDE.md\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-files') return { stdout: 'CLAUDE.md\n', stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'git' && args[0] === 'push') return { stdout: '', stderr: '' };
      if (command === 'gh') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const launchMock = vi.fn().mockImplementation(async () => {
      agentRan = true;
      return {
        process: createMockProcess(0),
        outputParser: { processChunk: () => {}, flush: () => {} },
        metadata: { pluginId: 'test', intentKind: 'merge-conflict' },
      };
    });
    const launcher = { launch: launchMock } as unknown as AgentLauncher;
    const handler = new MergeConflictHandler(config, mockLogger, launcher);

    const outcome = await handler.handle(createItem('validate'), '/tmp/checkout');

    expect(outcome).toEqual({ outcome: 're-armed', startPhase: 'validate' });

    // FR-007: single combined `removeLabels` invocation with all four labels.
    // `github.removeLabels` under the hood dispatches one `gh issue edit`
    // with multiple `--remove-label` flags — the atomic single round-trip.
    const removeCalls = (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mock.calls;
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toEqual([
      'owner', 'repo', 42,
      [
        'completed:merge-conflicts',
        'waiting-for:merge-conflicts',
        'agent:in-progress',
        'agent:paused',
      ],
    ]);
    expect(mockGitHub.addLabels).not.toHaveBeenCalled();

    // FR-006: the world matches the returned outcome. Post-cleanup labels
    // are empty; queue has the rearm item.
    const queueSnapshot = {
      inFlight: false,
      pendingItems: [
        { command: 'continue' as const, workflowName: 'speckit-feature', metadata: { startPhase: 'validate' } },
      ],
    };
    expect(assertHandlerOutcomeMatchesWorld(outcome, [], queueSnapshot)).toEqual({ ok: true });
  });

  it('every non-validate phase re-arms with the same startPhase carried in metadata', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        // No-op path — base IS ancestor
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    for (const phase of ['specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'] as const) {
      const launcher = { launch: vi.fn() } as unknown as AgentLauncher;
      const handler = new MergeConflictHandler(config, mockLogger, launcher);
      const outcome = await handler.handle(createItem(phase), '/tmp/checkout');
      expect(outcome).toEqual({ outcome: 're-armed', startPhase: phase });
    }
  });

  it('fail-loud (FR-004): missing metadata.phase at would-be re-armed return produces failed with pause-context evidence', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      // Base IS ancestor → the no-op success path would trigger re-armed.
      if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc1234\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const launcher = { launch: vi.fn() } as unknown as AgentLauncher;
    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    // Item without phase in metadata → should fail-loud.
    const item: QueueItem = {
      owner: 'owner', repo: 'repo', issueNumber: 42,
      workflowName: 'speckit-feature',
      command: 'resolve-merge-conflicts',
      priority: Date.now(), enqueuedAt: new Date().toISOString(),
      metadata: {},
    };
    const outcome = await handler.handle(item, '/tmp/checkout');

    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome === 'failed') {
      expect(outcome.evidence.reason).toBe('pause-context missing: phase');
    }
    // blocked:stuck-merge-conflicts applied — never re-derived from labels.
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['blocked:stuck-merge-conflicts'],
    );
    // No success-path removals.
    expect(mockGitHub.removeLabels).not.toHaveBeenCalled();

    // FR-006: assertion helper accepts failed with blocked:* on the issue.
    const labelsAfter = ['waiting-for:merge-conflicts', 'agent:paused', 'blocked:stuck-merge-conflicts'];
    expect(
      assertHandlerOutcomeMatchesWorld(outcome, labelsAfter, { inFlight: false, pendingItems: [] }),
    ).toEqual({ ok: true });
  });
});
