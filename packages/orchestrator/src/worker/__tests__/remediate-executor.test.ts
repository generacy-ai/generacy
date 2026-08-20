// #1128 — RemediateExecutor.
//
// SC-001 / INV-1: exactly one remediationCount increment per execute(),
//   regardless of how many findings are addressed.
// INV-2: a timed-out attempt still consumes budget (the increment fires on the
//   kill path too).
// INV-3: execute() never touches `round` or `lastReviewedCommitSha`.
// INV-4 / FR-004: execute() resolves no review threads, marks nothing ready,
//   and writes no GitHub review state.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger, WorkerContext } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { RemediateExecutor } from '../remediate-executor.js';
import {
  writeReviewArtifact,
  readReviewArtifact,
  type ReviewArtifact,
} from '../review-artifact.js';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

const baseConfig = {
  workspaceDir: '/tmp/workspace',
  phaseTimeoutMs: 60_000,
  shutdownGracePeriodMs: 5_000,
  validateCommand: 'echo validate',
  gates: {},
} as WorkerConfig;

/** Child that resolves its exit after `exitDelayMs`, or on SIGTERM/SIGKILL. */
function makeProcess(exitCode = 0, exitDelayMs = 5): ChildProcessHandle {
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
    kill: vi.fn(() => {
      resolveExit(exitCode);
      return true;
    }),
    exitPromise,
  };
  if (exitDelayMs >= 0) setTimeout(() => resolveExit(exitCode), exitDelayMs);
  return handle;
}

function makeLauncher(process: ChildProcessHandle): {
  launcher: AgentLauncher;
  launch: ReturnType<typeof vi.fn>;
} {
  const launch = vi.fn(async () => ({
    process,
    outputParser: { processChunk: () => undefined, flush: () => undefined },
    metadata: { pluginId: 'claude-code', intentKind: 'remediate' },
  }));
  return { launcher: { launch } as unknown as AgentLauncher, launch };
}

function createItem(workflowName = 'speckit-feature'): QueueItem {
  return {
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    workflowName,
    command: 'remediate',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    metadata: { phase: 'remediate' },
  };
}

/** GitHub mock whose review-state methods are all spied so we can assert none fire. */
function makeGithub(): {
  github: GitHubClient;
  spies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const spies = {
    resolveReviewThread: vi.fn(),
    markPRReady: vi.fn(),
    markReadyForReview: vi.fn(),
    createReview: vi.fn(),
    review: vi.fn(),
    convertPullRequestToDraft: vi.fn(),
    getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
  };
  return { github: spies as unknown as GitHubClient, spies };
}

const WORKFLOW_ID = 'owner/repo#42';

function seedArtifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    findings: [
      { severity: 'critical', file: 'src/a.ts', title: 't1', detail: 'd1', round: 1, status: 'open' },
    ],
    verdict: 'changes-required',
    round: 3,
    lastReviewedCommitSha: 'seed-sha',
    remediationCount: 0,
    ...overrides,
  };
}

describe('RemediateExecutor (#1128)', () => {
  let checkoutPath: string;

  beforeEach(async () => {
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'remediate-exec-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  function makeContext(github: GitHubClient): WorkerContext {
    return {
      workerId: 'w1',
      jobId: 'j1',
      item: createItem(),
      startPhase: 'remediate',
      github,
      logger,
      signal: new AbortController().signal,
      checkoutPath,
      issueUrl: 'https://github.com/owner/repo/issues/42',
      description: 'test',
    } as WorkerContext;
  }

  it('SC-001/INV-1: increments remediationCount by exactly one over multiple findings', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, seedArtifact({
      findings: [
        { severity: 'critical', file: 'src/a.ts', title: 't1', detail: 'd1', round: 1, status: 'open' },
        { severity: 'major', file: 'src/b.ts', title: 't2', detail: 'd2', round: 1, status: 'open' },
        { severity: 'critical', file: 'src/c.ts', title: 't3', detail: 'd3', round: 1, status: 'open' },
      ],
      remediationCount: 0,
    }));
    const { launcher, launch } = makeLauncher(makeProcess(0));
    const { github, spies } = makeGithub();

    const executor = new RemediateExecutor({
      agentLauncher: launcher,
      config: baseConfig,
      settings: null,
      logger,
    });

    const result = await executor.execute(makeContext(github));

    expect(result.phase).toBe('remediate');
    expect(result.success).toBe(true);
    // Exactly one spawn (the remediate intent), one increment.
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0].intent.kind).toBe('remediate');
    const persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.remediationCount).toBe(1);
    // INV-4: no GitHub review-state mutation.
    for (const spy of Object.values(spies)) {
      if (spy === spies.getCurrentCommitSha) continue;
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('INV-2: a timed-out attempt still increments remediationCount', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, seedArtifact({ remediationCount: 1 }));
    // Process never exits on its own — only the timeout kill resolves it.
    const { launcher } = makeLauncher(makeProcess(143, -1));
    const { github } = makeGithub();

    const executor = new RemediateExecutor({
      agentLauncher: launcher,
      // 20ms timeout → SIGTERM fires, killing the never-exiting child.
      config: { ...baseConfig, phaseTimeoutMs: 20 } as WorkerConfig,
      settings: null,
      logger,
    });

    await executor.execute(makeContext(github));

    const persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.remediationCount).toBe(2);
  });

  it('INV-2: a spawn failure still increments remediationCount', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, seedArtifact({ remediationCount: 0 }));
    const launch = vi.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const launcher = { launch } as unknown as AgentLauncher;
    const { github } = makeGithub();

    const executor = new RemediateExecutor({
      agentLauncher: launcher,
      config: baseConfig,
      settings: null,
      logger,
    });

    const result = await executor.execute(makeContext(github));
    expect(result.success).toBe(false);
    const persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.remediationCount).toBe(1);
  });

  it('INV-3: execute() leaves round + lastReviewedCommitSha untouched', async () => {
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, seedArtifact({
      round: 7,
      lastReviewedCommitSha: 'frozen-sha',
      remediationCount: 0,
    }));
    const { launcher } = makeLauncher(makeProcess(0));
    const { github } = makeGithub();

    const executor = new RemediateExecutor({
      agentLauncher: launcher,
      config: baseConfig,
      settings: null,
      logger,
    });

    await executor.execute(makeContext(github));

    const persisted = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(persisted!.round).toBe(7);
    expect(persisted!.lastReviewedCommitSha).toBe('frozen-sha');
    expect(persisted!.remediationCount).toBe(1);
  });
});
