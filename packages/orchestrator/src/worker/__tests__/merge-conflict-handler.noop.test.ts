/**
 * #902 T014 — No-op branch fixture (SC-001).
 *
 * When `baseIsAncestor === true` at handler entry (the branch was already
 * conflict-free — operator resolved by hand), the downstream state MUST be
 * indistinguishable from the resolved-by-agent path. Same HandlerOutcome,
 * same label edit, same postComplete rearm payload.
 *
 * This is the load-bearing SC-001 regression — the sniplink#6/#7/#8 defect
 * WAS the no-op branch on a hand-resolved conflict returning without
 * re-arming.
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

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: () => false, readFileSync: () => '' };
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
  return { ...actual, createGitHubClient: vi.fn(() => mockGitHub) };
});

import { MergeConflictHandler } from '../merge-conflict-handler.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { assertHandlerOutcomeMatchesWorld } from '../handler-outcome-assertion.js';

const mockLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Logger;

function createMockProcess(exitCode = 0): ChildProcessHandle {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitResolve: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => { exitResolve = resolve; });
  const handle: ChildProcessHandle = {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 4242, kill: () => true, exitPromise,
  };
  setTimeout(() => exitResolve(exitCode), 5);
  return handle;
}

function makePR(): PullRequest {
  return {
    number: 100, title: 'Test PR', body: 'Closes #42',
    state: 'open', draft: false,
    head: { ref: 'test-branch', sha: '', repo: 'owner/repo' },
    base: { ref: 'main', sha: '', repo: 'owner/repo' },
    labels: [], created_at: '', updated_at: '',
  } as PullRequest;
}

const config: WorkerConfig = {
  workspaceDir: '/tmp/workspace', phaseTimeoutMs: 60_000, shutdownGracePeriodMs: 5_000,
  validateCommand: 'echo validate', gates: {},
} as WorkerConfig;

function createItem(phase: string = 'validate'): QueueItem {
  return {
    owner: 'owner', repo: 'repo', issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'resolve-merge-conflicts',
    priority: Date.now(), enqueuedAt: new Date().toISOString(),
    metadata: { phase },
  };
}

describe('#902 T014 no-op branch (baseIsAncestor === true)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    (mockGitHub.addLabels as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
    (mockGitHub.getIssue as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({
      labels: [{ name: 'agent:paused' }, { name: 'agent:in-progress' }],
      assignees: [],
    });
  });

  it('SC-001: no-op merge produces identical downstream state to resolved-by-agent path', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      // Base IS ancestor of HEAD — no-op success path.
      if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const launchMock = vi.fn();
    const launcher = { launch: launchMock } as unknown as AgentLauncher;
    const handler = new MergeConflictHandler(config, mockLogger, launcher);
    const outcome = await handler.handle(createItem('validate'), '/tmp/checkout');

    // The agent CLI is NEVER spawned on the no-op branch.
    expect(launchMock).not.toHaveBeenCalled();

    // Handler returns the same re-armed shape.
    expect(outcome).toEqual({ outcome: 're-armed', startPhase: 'validate' });

    // Same combined label edit — FR-007.
    expect(mockGitHub.addLabels).not.toHaveBeenCalled();
    expect(mockGitHub.removeLabels).toHaveBeenCalledTimes(1);
    expect(mockGitHub.removeLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      [
        'completed:merge-conflicts',
        'waiting-for:merge-conflicts',
        'agent:in-progress',
        'agent:paused',
      ],
    );

    // FR-006 assertion helper on terminal state.
    const queueSnapshot = {
      inFlight: false,
      pendingItems: [
        { command: 'continue' as const, workflowName: 'speckit-feature', metadata: { startPhase: 'validate' } },
      ],
    };
    expect(assertHandlerOutcomeMatchesWorld(outcome, [], queueSnapshot)).toEqual({ ok: true });
  });

  it('FR-004 fail-loud on no-op path when metadata.phase is missing', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc1234\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const launcher = { launch: vi.fn() } as unknown as AgentLauncher;
    const handler = new MergeConflictHandler(config, mockLogger, launcher);
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
    expect(mockGitHub.addLabels).toHaveBeenCalledWith(
      'owner', 'repo', 42,
      ['blocked:stuck-merge-conflicts'],
    );
    expect(mockGitHub.removeLabels).not.toHaveBeenCalled();
  });
});
