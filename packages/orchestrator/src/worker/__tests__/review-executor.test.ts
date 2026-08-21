// #1124 — ReviewExecutor (SC-003 / SC-004).
//
// SC-003: the review phase spawns exactly one process (the review launch
// intent). No cli-spawner validate/build path is invoked, and no GitHub review
// API is ever touched.
//
// SC-004: the persisted verdict is RECOMPUTED by the engine from the findings,
// ignoring any agent-claimed verdict in the candidate file (FR-007).
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import {
  getReviewArtifactPath,
  getReviewCandidatePath,
  readReviewArtifact,
} from '../review-artifact.js';

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

/**
 * A process that never exits on its own — it only resolves when killed, with a
 * `null` exit code (signal death). Used to drive the SIGTERM→SIGKILL timeout
 * path deterministically.
 */
function makeHangingProcess(killExitCode: number | null = null): ChildProcessHandle {
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
      if (sig === 'SIGTERM' || sig === 'SIGKILL') resolveExit(killExitCode);
      return true;
    }),
    exitPromise,
  };
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
  async function writeCandidateFile(raw: unknown): Promise<void> {
    const filePath = getReviewCandidatePath(checkoutPath, workflowId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(raw), 'utf-8');
  }

  function makeLauncher(candidate: unknown): {
    launcher: AgentLauncher;
    launch: ReturnType<typeof vi.fn>;
  } {
    // #1155: the agent writes the *candidate* path (not the engine artifact).
    return makeLauncherWith({ onLaunch: () => writeCandidateFile(candidate) });
  }

  /**
   * Flexible launcher: run an arbitrary `onLaunch` side-effect (write / skip /
   * corrupt the candidate) and return a caller-chosen child process.
   */
  function makeLauncherWith(opts: {
    onLaunch?: () => Promise<void>;
    process?: ChildProcessHandle;
  }): { launcher: AgentLauncher; launch: ReturnType<typeof vi.fn> } {
    const launch = vi.fn(async () => {
      if (opts.onLaunch) await opts.onLaunch();
      return {
        process: opts.process ?? makeProcess(0),
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
    // #1159 INV-4 / SC-003: engine-authored review findings are NOT fenced —
    // only the two external-ingestion sites (seed comment body, validate
    // output) wrap with `wrapUntrustedData`. The agent-written detail lands
    // verbatim, with no `<untrusted-data …>` wrapper.
    expect(persisted!.findings[0]!.detail).toBe('Crashes on empty input.');
    expect(persisted!.findings[0]!.detail).not.toContain('<untrusted-data');
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

  describe('#1155 phantom-clean regression (FR-006)', () => {
    it('(a) missing candidate after exit 0 → success:false, no artifact, no verdict computed', async () => {
      // Agent exits 0 but writes no candidate — no proof of review.
      const { launcher } = makeLauncherWith({});
      const getCurrentCommitSha = vi.fn().mockResolvedValue('sha');
      const github = { getCurrentCommitSha } as unknown as GitHubClient;

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(makeContext(github));

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(0);
      // Nothing persisted, and the engine never got as far as stamping a commit.
      expect(await readReviewArtifact(checkoutPath, workflowId)).toBeNull();
      expect(getCurrentCommitSha).not.toHaveBeenCalled();
    });

    it('(b) non-zero exit → success:false, exitCode:1, no artifact (even with a valid candidate)', async () => {
      // A valid candidate is present, but a non-zero exit is still a failure.
      const { launcher } = makeLauncherWith({
        onLaunch: () => writeCandidateFile({ findings: [] }),
        process: makeProcess(1),
      });
      const github = {
        getCurrentCommitSha: vi.fn().mockResolvedValue('sha'),
      } as unknown as GitHubClient;

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(makeContext(github));

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(await readReviewArtifact(checkoutPath, workflowId)).toBeNull();
    });

    it('(c) CLI timeout (SIGTERM/SIGKILL) → success:false, no artifact', async () => {
      const timeoutConfig = {
        ...baseConfig,
        phaseTimeoutMs: 50,
        shutdownGracePeriodMs: 10,
      } as WorkerConfig;
      const { launcher } = makeLauncherWith({ process: makeHangingProcess(null) });
      const github = {
        getCurrentCommitSha: vi.fn().mockResolvedValue('sha'),
      } as unknown as GitHubClient;

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: timeoutConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(makeContext(github));

      expect(result.success).toBe(false);
      expect(await readReviewArtifact(checkoutPath, workflowId)).toBeNull();
    });

    it('(d) round ≥ 2, no fresh candidate → prior artifact + remediationCount untouched, success:false', async () => {
      // Seed a prior round-1 engine artifact carrying a remediation budget.
      const prior = {
        findings: [
          {
            severity: 'critical',
            file: 'src/a.ts',
            title: 'Prior finding',
            detail: 'From round 1.',
            round: 1,
            status: 'open',
          },
        ],
        verdict: 'changes-required',
        round: 1,
        lastReviewedCommitSha: 'old',
        remediationCount: 2,
      };
      const priorPath = getReviewArtifactPath(checkoutPath, workflowId);
      await mkdir(path.dirname(priorPath), { recursive: true });
      await writeFile(priorPath, JSON.stringify(prior), 'utf-8');

      // Agent exits 0 but writes no candidate this round.
      const { launcher } = makeLauncherWith({});
      const github = {
        getCurrentCommitSha: vi.fn().mockResolvedValue('newsha'),
      } as unknown as GitHubClient;

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(makeContext(github));

      expect(result.success).toBe(false);
      // Prior artifact is left exactly as-is — round does not advance, budget intact.
      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted!.round).toBe(1);
      expect(persisted!.remediationCount).toBe(2);
      expect(persisted!.lastReviewedCommitSha).toBe('old');
    });

    it('(e) crash window: engine artifact intact + invalid candidate → artifact + budget preserved, success:false', async () => {
      const prior = {
        findings: [],
        verdict: 'clean',
        round: 3,
        lastReviewedCommitSha: 'stable',
        remediationCount: 3,
      };
      const priorPath = getReviewArtifactPath(checkoutPath, workflowId);
      await mkdir(path.dirname(priorPath), { recursive: true });
      await writeFile(priorPath, JSON.stringify(prior), 'utf-8');

      // Half-written / invalid candidate from a crashed write.
      const { launcher } = makeLauncherWith({
        onLaunch: async () => {
          const filePath = getReviewCandidatePath(checkoutPath, workflowId);
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, '{ not valid json', 'utf-8');
        },
      });
      const github = {
        getCurrentCommitSha: vi.fn().mockResolvedValue('newsha'),
      } as unknown as GitHubClient;

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(makeContext(github));

      expect(result.success).toBe(false);
      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted!.round).toBe(3);
      expect(persisted!.remediationCount).toBe(3);
      expect(persisted!.lastReviewedCommitSha).toBe('stable');
    });
  });

  describe('#1131 resolution-scoped diff window', () => {
    const execFileAsync = promisify(execFile);

    async function initRepoWithCommits(dir: string, n: number): Promise<string[]> {
      await execFileAsync('git', ['init', '-q'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: dir });
      const shas: string[] = [];
      for (let i = 0; i < n; i++) {
        await writeFile(path.join(dir, `f${i}.txt`), `content ${i}`, 'utf-8');
        await execFileAsync('git', ['add', '.'], { cwd: dir });
        await execFileAsync('git', ['commit', '-q', '-m', `c${i}`], { cwd: dir });
        const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir });
        shas.push(stdout.trim());
      }
      return shas;
    }

    function makeScopedContext(
      github: GitHubClient,
      reviewScope: { baseSha: string; headSha: string },
    ): WorkerContext {
      return { ...makeContext(github), reviewScope } as WorkerContext;
    }

    it('FR-011/SC-004: empty window (base===head) short-circuits — no spawn, no artifact, success', async () => {
      const [sha] = await initRepoWithCommits(checkoutPath, 1);
      const { launcher, launch } = makeLauncher({ findings: [] });
      const github = {
        getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
      } as unknown as GitHubClient;

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(
        makeScopedContext(github, { baseSha: sha!, headSha: sha! }),
      );

      expect(result.phase).toBe('review');
      expect(result.success).toBe(true);
      // No CLI spawn during an empty resolution window.
      expect(launch).not.toHaveBeenCalled();
      // No findings artifact — so no "empty diff = blocking finding" is emitted.
      expect(await readReviewArtifact(checkoutPath, workflowId)).toBeNull();
    });

    it('SC-002: non-empty window passes the exact baseSha..headSha range to the charter and spawns', async () => {
      const [sha0, sha1] = await initRepoWithCommits(checkoutPath, 2);
      const { launcher, launch } = makeLauncher({ findings: [] });
      const github = {
        getCurrentCommitSha: vi.fn().mockResolvedValue('newsha'),
      } as unknown as GitHubClient;

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      await executor.execute(makeScopedContext(github, { baseSha: sha0!, headSha: sha1! }));

      expect(launch).toHaveBeenCalledTimes(1);
      const prompt = launch.mock.calls[0]![0].intent.prompt as string;
      expect(prompt).toContain(`${sha0}..${sha1}`);
      expect(prompt.toLowerCase()).toContain('merge-conflict');
    });
  });
});
