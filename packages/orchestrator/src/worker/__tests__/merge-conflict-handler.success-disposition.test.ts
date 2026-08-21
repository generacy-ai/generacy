/**
 * #1164 T011 (FR-007) — success-disposition label batch.
 *
 * Defect 4a: with `ciMergeGateEnabled=true` and `reviewPhaseEnabled=false`, a
 * post-approval conflict resolution re-arms `continue`; the #1133 terminal
 * short-circuit reads `completed:validate` + `completed:implementation-review`
 * fresh from the issue and marks the PR ready WITHOUT running `validate` on the
 * post-merge tree.
 *
 * This test pins the fix: `applySuccessDisposition`'s single combined
 * `removeLabels` batch must clear those two stale completion markers so the
 * short-circuit cannot fire on the changed tree — and must NOT clear the
 * ownership (`agent:*`) labels, which now move to the dispatcher `afterEnqueue`
 * closure (FR-008).
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
  } as unknown as QueueItem;
}

/** Wire a conflict the agent resolves; `git diff --diff-filter=U` yields CLAUDE.md. */
function wireResolvedConflict(): AgentLauncher {
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

  return {
    launch: vi.fn().mockImplementation(async () => {
      agentRan = true;
      return {
        process: createMockProcess(0),
        outputParser: { processChunk: () => {}, flush: () => {} },
        metadata: { pluginId: 'test', intentKind: 'merge-conflict' },
      };
    }),
  } as unknown as AgentLauncher;
}

describe('#1164 merge-conflict success disposition — label batch (FR-007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    fsExistsMock.mockReset().mockReturnValue(false);
    fsReadFileMock.mockReset().mockReturnValue('');
    switchBranchMock.mockClear();
    (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([makePR()]);
  });

  it('clears the stale post-merge completion markers in one combined removeLabels call', async () => {
    const launcher = wireResolvedConflict();
    const handler = new MergeConflictHandler(config, mockLogger, launcher);

    await handler.handle(createItem('validate'), '/tmp/checkout');

    const removeCalls = (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mock.calls;
    expect(removeCalls).toHaveLength(1);
    const [, , , labels] = removeCalls[0] as [string, string, number, string[]];
    expect(labels).toContain('completed:validate');
    expect(labels).toContain('completed:implementation-review');
  });

  it('does NOT clear the ownership labels — those move to the dispatcher afterEnqueue closure (FR-008)', async () => {
    const launcher = wireResolvedConflict();
    const handler = new MergeConflictHandler(config, mockLogger, launcher);

    await handler.handle(createItem('validate'), '/tmp/checkout');

    const removeCalls = (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mock.calls;
    const allRemoved = removeCalls.flatMap((c) => (c as [string, string, number, string[]])[3]);
    expect(allRemoved).not.toContain('agent:in-progress');
    expect(allRemoved).not.toContain('agent:paused');
  });

  it('emits exactly the four-label gate+completion batch and nothing else', async () => {
    const launcher = wireResolvedConflict();
    const handler = new MergeConflictHandler(config, mockLogger, launcher);

    await handler.handle(createItem('validate'), '/tmp/checkout');

    const removeCalls = (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mock.calls;
    expect(removeCalls[0]).toEqual([
      'owner', 'repo', 42,
      [
        'completed:merge-conflicts',
        'waiting-for:merge-conflicts',
        'completed:validate',
        'completed:implementation-review',
      ],
    ]);
  });
});
