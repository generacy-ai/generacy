// #1124 — ReviewExecutor (SC-003 / SC-004).
//
// SC-003: the review phase spawns exactly one process (the review launch
// intent). No cli-spawner validate/build path is invoked, and no GitHub review
// API is ever touched.
//
// SC-004: the persisted verdict is RECOMPUTED by the engine from the findings,
// ignoring any agent-claimed verdict in the candidate file (FR-007).
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { ChildProcessHandle, Logger, WorkerContext } from '../types.js';
import type { QueueItem } from '../../types/index.js';
import type { WorkerConfig } from '../config.js';
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ReviewExecutor } from '../review-executor.js';
import { getReviewArtifactPath, readReviewArtifact } from '../review-artifact.js';

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

function createItem(workflowName = 'speckit-feature'): QueueItem {
  return {
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    workflowName,
    command: 'review',
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    metadata: { phase: 'review' },
  };
}

describe('ReviewExecutor — engine recomputes the verdict (#1124)', () => {
  let checkoutPath: string;
  const workflowId = 'owner/repo#42';

  beforeEach(async () => {
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'review-exec-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  function makeContext(github: GitHubClient): WorkerContext {
    return {
      workerId: 'w1',
      jobId: 'j1',
      item: createItem(),
      startPhase: 'review',
      github,
      logger,
      signal: new AbortController().signal,
      checkoutPath,
      issueUrl: 'https://github.com/owner/repo/issues/42',
      description: 'test',
    } as WorkerContext;
  }

  /**
   * Fake launcher whose `launch()` writes the agent *candidate* sidecar (with a
   * deliberately-wrong `verdict: 'clean'` alongside a critical open finding),
   * then resolves the child. `readCandidateFindings` runs after `exitPromise`,
   * so the file must exist by the time the process exits.
   */
  function makeLauncher(candidate: unknown): {
    launcher: AgentLauncher;
    launch: ReturnType<typeof vi.fn>;
  } {
    const launch = vi.fn(async () => {
      const filePath = getReviewArtifactPath(checkoutPath, workflowId);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(candidate), 'utf-8');
      return {
        process: makeProcess(0),
        outputParser: { processChunk: () => undefined, flush: () => undefined },
        metadata: { pluginId: 'claude-code', intentKind: 'review' },
      };
    });
    return { launcher: { launch } as unknown as AgentLauncher, launch };
  }

  const baseConfig = {
    workspaceDir: '/tmp/workspace',
    phaseTimeoutMs: 60_000,
    shutdownGracePeriodMs: 5_000,
    validateCommand: 'echo validate',
    gates: {},
  } as WorkerConfig;

  it('SC-004: persisted verdict = changes-required from a critical open finding, ignoring the candidate verdict:clean', async () => {
    const candidate = {
      verdict: 'clean', // agent-claimed — MUST be ignored (FR-007)
      round: 99, // agent-claimed — MUST be ignored
      findings: [
        {
          severity: 'critical',
          file: 'src/a.ts',
          title: 'Null deref',
          detail: 'Crashes on empty input.',
        },
      ],
    };
    const { launcher, launch } = makeLauncher(candidate);

    const getCurrentCommitSha = vi.fn().mockResolvedValue('deadbeef');
    const ghReview = vi.fn();
    const github = { getCurrentCommitSha, review: ghReview } as unknown as GitHubClient;

    const executor = new ReviewExecutor({
      agentLauncher: launcher,
      config: baseConfig,
      settings: null,
      logger,
    });

    const result = await executor.execute(makeContext(github));

    expect(result.phase).toBe('review');
    expect(result.success).toBe(true);

    // SC-003: exactly one spawn, and it is the `review` intent.
    expect(launch).toHaveBeenCalledTimes(1);
    const req = launch.mock.calls[0]![0];
    expect(req.intent.kind).toBe('review');

    // SC-003: no GitHub review API was touched — only getCurrentCommitSha.
    expect(ghReview).not.toHaveBeenCalled();
    expect(getCurrentCommitSha).toHaveBeenCalledTimes(1);

    // SC-004: engine recomputed the verdict from findings, ignoring the claim.
    const persisted = await readReviewArtifact(checkoutPath, workflowId);
    expect(persisted).not.toBeNull();
    expect(persisted!.verdict).toBe('changes-required');
    expect(persisted!.round).toBe(1); // authoritative round, not the claimed 99
    expect(persisted!.lastReviewedCommitSha).toBe('deadbeef');
    expect(persisted!.findings).toHaveLength(1);
    expect(persisted!.findings[0]!.status).toBe('open'); // defaulted by engine
    expect(persisted!.findings[0]!.round).toBe(1); // stamped by engine
  });

  it('SC-004: only-minor findings recompute to clean under the default critical threshold, ignoring verdict:changes-required', async () => {
    const candidate = {
      verdict: 'changes-required', // agent-claimed — ignored
      findings: [
        {
          severity: 'minor',
          file: 'src/b.ts',
          title: 'Style nit',
          detail: 'Prefer const.',
        },
      ],
    };
    const { launcher } = makeLauncher(candidate);
    const github = {
      getCurrentCommitSha: vi.fn().mockResolvedValue('cafef00d'),
    } as unknown as GitHubClient;

    const executor = new ReviewExecutor({
      agentLauncher: launcher,
      config: baseConfig,
      settings: null,
      logger,
    });

    await executor.execute(makeContext(github));

    const persisted = await readReviewArtifact(checkoutPath, workflowId);
    expect(persisted!.verdict).toBe('clean');
  });

  it('increments the round from a prior engine-written artifact', async () => {
    // Seed a prior round-1 engine artifact.
    const prior = {
      findings: [],
      verdict: 'clean',
      round: 1,
      lastReviewedCommitSha: 'old',
    };
    const priorPath = getReviewArtifactPath(checkoutPath, workflowId);
    await mkdir(path.dirname(priorPath), { recursive: true });
    await writeFile(priorPath, JSON.stringify(prior), 'utf-8');

    const candidate = { findings: [] };
    const { launcher } = makeLauncher(candidate);
    const github = {
      getCurrentCommitSha: vi.fn().mockResolvedValue('newsha'),
    } as unknown as GitHubClient;

    const executor = new ReviewExecutor({
      agentLauncher: launcher,
      config: baseConfig,
      settings: null,
      logger,
    });

    await executor.execute(makeContext(github));

    const persisted = await readReviewArtifact(checkoutPath, workflowId);
    expect(persisted!.round).toBe(2);
    expect(persisted!.verdict).toBe('clean');
  });
});
