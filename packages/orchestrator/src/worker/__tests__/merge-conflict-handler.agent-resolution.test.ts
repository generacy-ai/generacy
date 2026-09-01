/**
 * #1095 — MergeConflictHandler model + effort threading (SC-003, FR-008).
 *
 * Focused sibling to `merge-conflict-handler.test.ts`: verifies that
 * `spawnAgentForConflict` calls `resolveAgentForPhase(config, workflowName, 'implement')`
 * and threads the resolved `{ provider, model, effort }` onto the outbound
 * `MergeConflictIntent` and `LaunchRequest.provider`.
 *
 * Includes a `workflowName === 'unknown'` case per FR-008 — the resolver must
 * degrade cleanly through `agents.default` tiers when there is no
 * `workflow:*`/`process:*` label.
 */
import { EventEmitter } from 'node:events';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GitHubClient, PullRequest } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';

// child_process — happy-path merge that produces one conflicted file.
const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    opts: unknown,
    cb: (err: unknown, out: { stdout: string; stderr: string }) => void,
  ) => {
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
  return {
    ...actual,
    existsSync: () => false,
    readFileSync: () => '',
  };
});

const switchBranchMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../repo-checkout.js', () => ({
  RepoCheckout: vi.fn().mockImplementation(() => ({
    switchBranch: switchBranchMock,
  })),
}));

const mockGitHub = {
  addLabels: vi.fn().mockResolvedValue(undefined),
  removeLabels: vi.fn().mockResolvedValue(undefined),
  listOpenPullRequests: vi.fn(),
  getIssue: vi.fn().mockResolvedValue({ labels: [{ name: 'agent:paused' }], assignees: [] }),
} as unknown as GitHubClient;

vi.mock('@generacy-ai/workflow-engine', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@generacy-ai/workflow-engine');
  return {
    ...actual,
    createGitHubClient: vi.fn(() => mockGitHub),
  };
});

// PrLinker — the handler asks the linker to reconcile candidate PRs to
// `issueNumber`. Return a stable `ok` link for the first candidate.
vi.mock('../pr-linker.js', () => ({
  PrLinker: vi.fn().mockImplementation(() => ({
    linkPrToIssue: vi.fn(async (_g: unknown, _o: string, _r: string, input: { number: number }) => ({
      kind: 'ok',
      link: { issueNumber: 42, prNumber: input.number },
    })),
  })),
}));

import { MergeConflictHandler } from '../merge-conflict-handler.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

function makeProcess(exitCode = 0): ChildProcessHandle {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let resolveExit: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  const handle: ChildProcessHandle = {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 4242,
    kill: vi.fn((sig?: string) => {
      if (sig === 'SIGTERM' || sig === 'SIGKILL') resolveExit(exitCode);
      return true;
    }),
    exitPromise,
  };
  setTimeout(() => resolveExit(exitCode), 5);
  return handle;
}

function makePR(): PullRequest {
  return {
    number: 100,
    title: 'Test PR',
    body: 'Closes #42',
    state: 'open',
    draft: false,
    head: { ref: 'test-branch', sha: '', repo: 'owner/repo' },
    base: { ref: 'main', sha: '', repo: 'owner/repo' },
    labels: [],
    created_at: '',
    updated_at: '',
  } as PullRequest;
}

function wireGit(): void {
  // Sequence: fetch → is-ancestor (false) → merge (conflict) → diff (conflict paths) →
  // sibling enum (skipped via github mock) → diff --diff-filter=U → git rev-parse.
  execFileMock.mockImplementation((command: string, args: string[]) => {
    if (command === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      const err = new Error('not ancestor') as Error & { code?: number };
      err.code = 1;
      throw err;
    }
    if (command === 'git' && args[0] === 'merge') {
      // conflict on first attempt
      const err = new Error('conflict') as Error & { stderr?: string };
      err.stderr = 'CONFLICT (content): Merge conflict in a.ts';
      throw err;
    }
    if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
      return { stdout: 'a.ts\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'ls-files') return { stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc123', stderr: '' };
    if (command === 'git' && args[0] === 'push') return { stdout: '', stderr: '' };
    return { stdout: '', stderr: '' };
  });
}

function createItem(workflowName = 'speckit-feature'): QueueItem {
  return {
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    workflowName,
    command: 'resolve-merge-conflicts',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    metadata: { phase: 'validate' },
  };
}

function makeLauncher(exitCode = 0): { launcher: AgentLauncher; launch: ReturnType<typeof vi.fn> } {
  const launch = vi.fn(async () => ({
    process: makeProcess(exitCode),
    outputParser: { processChunk: () => undefined, flush: () => undefined },
    metadata: { pluginId: 'claude-code', intentKind: 'merge-conflict' },
  }));
  return { launcher: { launch } as unknown as AgentLauncher, launch };
}

describe('MergeConflictHandler — SC-003 model + effort threading (#1095)', () => {
  beforeEach(() => {
    (mockGitHub.listOpenPullRequests as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValue([makePR()]);
    switchBranchMock.mockReset().mockResolvedValue(undefined);
    execFileMock.mockReset();
    wireGit();
  });

  it('with agents.workflows.speckit-feature.phases.implement = { model, effort }, intent + LaunchRequest carry both', async () => {
    const config: WorkerConfig = {
      workspaceDir: '/tmp/workspace',
      phaseTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5_000,
      validateCommand: 'echo validate',
      gates: {},
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              implement: { model: 'opus-4-7', effort: 'high' },
            },
          },
        },
      },
    } as WorkerConfig;

    const { launcher, launch } = makeLauncher(0);
    const handler = new MergeConflictHandler(config, logger, launcher);

    // Handler may report `blocked` because our verifyMergeResolved mock leaves
    // MERGE_HEAD absent (existsSync mocked to false) — that's fine for the SC-003
    // assertion, which is only about the outbound launch args.
    await handler.handle(createItem(), '/tmp/checkout').catch(() => undefined);

    expect(launch).toHaveBeenCalledTimes(1);
    const req = launch.mock.calls[0]![0];
    expect(req.intent.kind).toBe('merge-conflict');
    expect(req.intent.model).toBe('opus-4-7');
    expect(req.intent.effort).toBe('high');
    expect(req.intent.provider).toBe('claude-code');
    expect(req.provider).toBe('claude-code');
  });

  it('with NO agents block, intent has no model and no effort (SC-004 baseline)', async () => {
    const config: WorkerConfig = {
      workspaceDir: '/tmp/workspace',
      phaseTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5_000,
      validateCommand: 'echo validate',
      gates: {},
    } as WorkerConfig;

    const { launcher, launch } = makeLauncher(0);
    const handler = new MergeConflictHandler(config, logger, launcher);
    await handler.handle(createItem(), '/tmp/checkout').catch(() => undefined);

    const req = launch.mock.calls[0]![0];
    expect(req.intent.model).toBeUndefined();
    expect(req.intent.effort).toBeUndefined();
  });

  it('FR-007: emits a pre-launch log line carrying the resolved route', async () => {
    const config: WorkerConfig = {
      workspaceDir: '/tmp/workspace',
      phaseTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5_000,
      validateCommand: 'echo validate',
      gates: {},
    } as WorkerConfig;

    const { launcher, launch } = makeLauncher(0);
    const handler = new MergeConflictHandler(config, logger, launcher);
    await handler.handle(createItem(), '/tmp/checkout').catch(() => undefined);

    const spawnLog = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === 'MergeConflictHandler: spawning agent CLI for conflict resolution',
    );
    expect(spawnLog).toBeDefined();
    // No configured model → subscription route; the field is present verbatim.
    expect(spawnLog![0]).toMatchObject({ route: 'subscription' });
    // Launch options are unchanged (no route threaded into the launcher).
    expect(launch.mock.calls[0]![0]).not.toHaveProperty('route');
  });

  it('FR-008: workflowName "unknown" degrades cleanly — picks up agents.default when set', async () => {
    const config: WorkerConfig = {
      workspaceDir: '/tmp/workspace',
      phaseTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5_000,
      validateCommand: 'echo validate',
      gates: {},
      agents: {
        default: { model: 'sonnet-4-6', effort: 'medium' },
      },
    } as WorkerConfig;

    const { launcher, launch } = makeLauncher(0);
    const handler = new MergeConflictHandler(config, logger, launcher);
    await handler.handle(createItem('unknown'), '/tmp/checkout').catch(() => undefined);

    const req = launch.mock.calls[0]![0];
    expect(req.intent.model).toBe('sonnet-4-6');
    expect(req.intent.effort).toBe('medium');
  });
});
