/**
 * #902 T015 — Second-cycle regression fixture (SC-003, FR-001 load-bearing).
 *
 * The original defect: `#898`'s success path added `completed:merge-conflicts`
 * and never consumed it. On the second future conflict pause on the same
 * issue, the stale marker combined with `waiting-for:merge-conflicts` matches
 * the generic resume-pair detector, and a `continue` item is enqueued instead
 * of `resolve-merge-conflicts` — the handler is bypassed, the phase re-runs
 * into the same conflict, and the cycle spins.
 *
 * Fix demonstrated here: `completed:merge-conflicts` is CONSUMED on cycle 1
 * success. When cycle 2 fires (fresh `waiting-for:merge-conflicts` pause),
 * no stale marker exists — the merge-conflict monitor path enqueues
 * `resolve-merge-conflicts` again, the handler runs and returns re-armed
 * cleanly. Two full cycles, two handler invocations, two combined label edits.
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

function createResolveItem(phase: string = 'validate'): QueueItem {
  return {
    owner: 'owner', repo: 'repo', issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'resolve-merge-conflicts',
    priority: Date.now(), enqueuedAt: new Date().toISOString(),
    metadata: { phase },
  };
}

describe('#902 T015 second-cycle regression (SC-003, FR-001 load-bearing)', () => {
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

  it('two successive conflict pauses hit the handler each time — no stale-marker insta-resume', async () => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

    // Both cycles: base is ancestor → no-op success path. Simplest way to
    // exercise the label consumption without wiring the agent CLI twice.
    execFileMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const launchMock = vi.fn();
    const launcher = { launch: launchMock } as unknown as AgentLauncher;
    const handler = new MergeConflictHandler(config, mockLogger, launcher);

    // ---- Cycle 1: first conflict pause resolved ----
    const outcome1 = await handler.handle(createResolveItem('validate'), '/tmp/checkout');
    expect(outcome1).toEqual({ outcome: 're-armed', startPhase: 'validate' });

    // Cycle 1 success consumed `completed:merge-conflicts` (FR-001). This is
    // the load-bearing removal — without it, cycle 2 insta-resumes through
    // the generic pair path.
    const cycle1Removes = (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mock.calls;
    expect(cycle1Removes).toHaveLength(1);
    expect(cycle1Removes[0][3]).toContain('completed:merge-conflicts');
    expect(cycle1Removes[0][3]).toContain('agent:in-progress');

    // ---- Cycle 2: fresh conflict pause on the same issue ----
    // If the fix weren't in place, cycle 1's stale marker would have combined
    // with the fresh `waiting-for:merge-conflicts` to insta-resume — this
    // handler would never be called. In production, the merge-conflict
    // monitor is what enqueues `resolve-merge-conflicts`; calling handler.handle
    // again here directly simulates that monitor-triggered second-cycle
    // enqueue actually reaching the handler.
    const outcome2 = await handler.handle(createResolveItem('implement'), '/tmp/checkout');
    expect(outcome2).toEqual({ outcome: 're-armed', startPhase: 'implement' });

    // Two full cycles → two combined label edits.
    const cycle2Removes = (mockGitHub.removeLabels as ReturnType<typeof vi.fn>).mock.calls;
    expect(cycle2Removes).toHaveLength(2);
    // Second cycle removed the same four labels.
    expect(cycle2Removes[1][3]).toEqual([
      'completed:merge-conflicts',
      'waiting-for:merge-conflicts',
      'agent:in-progress',
      'agent:paused',
    ]);
    // No adds on either cycle — no resume-pair labels.
    expect(mockGitHub.addLabels).not.toHaveBeenCalled();

    // FR-006 assertion on both terminal states.
    const buildSnap = (startPhase: string) => ({
      inFlight: false,
      pendingItems: [
        { command: 'continue' as const, workflowName: 'speckit-feature', metadata: { startPhase } },
      ],
    });
    expect(assertHandlerOutcomeMatchesWorld(outcome1, [], buildSnap('validate'))).toEqual({ ok: true });
    expect(assertHandlerOutcomeMatchesWorld(outcome2, [], buildSnap('implement'))).toEqual({ ok: true });
  });
});
