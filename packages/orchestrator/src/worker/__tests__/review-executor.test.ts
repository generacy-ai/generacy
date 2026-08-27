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
   * Canonical `GitHubClient` fake for the convergence path (#1161). The executor
   * always resolves a review delta (`resolvePrBaseRef` → `computeReviewDelta`)
   * before spawning, which needs `getDefaultBranch`, `commitExistsInCheckout`,
   * and `getFilesChangedBetween` in addition to `getCurrentCommitSha`. Defaults
   * drive the round-1 full-diff fallback (no last-reviewed SHA resolves) with an
   * empty changed-file set; override per test as needed.
   */
  function makeGithub(overrides: Record<string, unknown> = {}): GitHubClient {
    return {
      getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      commitExistsInCheckout: vi.fn().mockResolvedValue(false),
      getFilesChangedBetween: vi.fn().mockResolvedValue([]),
      ...overrides,
    } as unknown as GitHubClient;
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

  it('FR-007: the spawn log payload includes the resolved route', async () => {
    const { launcher, launch } = makeLauncher({ verdict: 'clean', findings: [] });
    const github = makeGithub();

    const executor = new ReviewExecutor({
      agentLauncher: launcher,
      config: baseConfig,
      settings: null,
      logger,
    });

    await executor.execute(makeContext(github));

    const spawnLog = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === 'Spawning Claude CLI for review phase',
    );
    expect(spawnLog).toBeDefined();
    // No configured model → subscription route; the field is present verbatim.
    expect(spawnLog![0]).toMatchObject({ route: 'subscription' });
    // Launch options are unchanged (no route threaded into the launcher).
    expect(launch.mock.calls[0]![0]).not.toHaveProperty('route');
  });

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
    const github = makeGithub({ getCurrentCommitSha, review: ghReview });

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
    // #1161: the convergence path reads HEAD twice — once for the delta window
    // (full-diff fallback head) and once to stamp `lastReviewedCommitSha`.
    expect(ghReview).not.toHaveBeenCalled();
    expect(getCurrentCommitSha).toHaveBeenCalledTimes(2);

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
    const github = makeGithub({
      getCurrentCommitSha: vi.fn().mockResolvedValue('cafef00d'),
    });

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
    const github = makeGithub({
      getCurrentCommitSha: vi.fn().mockResolvedValue('newsha'),
    });

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
      const github = makeGithub({ getCurrentCommitSha });

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(makeContext(github));

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(0);
      // Nothing persisted. #1161: the delta reads HEAD once, but the stamp write
      // never runs — so exactly one call proves nothing was persisted.
      expect(await readReviewArtifact(checkoutPath, workflowId)).toBeNull();
      expect(getCurrentCommitSha).toHaveBeenCalledTimes(1);
    });

    it('(b) non-zero exit → success:false, exitCode:1, no artifact (even with a valid candidate)', async () => {
      // A valid candidate is present, but a non-zero exit is still a failure.
      const { launcher } = makeLauncherWith({
        onLaunch: () => writeCandidateFile({ findings: [] }),
        process: makeProcess(1),
      });
      const github = makeGithub({ getCurrentCommitSha: vi.fn().mockResolvedValue('sha') });

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
      const github = makeGithub({ getCurrentCommitSha: vi.fn().mockResolvedValue('sha') });

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
      const github = makeGithub({ getCurrentCommitSha: vi.fn().mockResolvedValue('newsha') });

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
      const github = makeGithub({ getCurrentCommitSha: vi.fn().mockResolvedValue('newsha') });

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

  describe('#1161 convergence anti-vanish (SC-005 / US1 AC2 / AC3 / FR-007)', () => {
    /**
     * Seed a prior round-1 engine artifact (ids are backfilled deterministically
     * on read, so they may be omitted here).
     */
    async function seedPrior(prior: unknown): Promise<void> {
      const priorPath = getReviewArtifactPath(checkoutPath, workflowId);
      await mkdir(path.dirname(priorPath), { recursive: true });
      await writeFile(priorPath, JSON.stringify(prior), 'utf-8');
    }

    it('carries a round-1 open finding forward as open (verdict stays changes-required) when the round-2 candidate omits it, never reopens a resolved finding, and scopes the delta to lastReviewedCommitSha', async () => {
      await seedPrior({
        findings: [
          {
            severity: 'critical',
            file: 'src/a.ts',
            title: 'Prior open finding',
            detail: 'Raised in round 1, unaddressed.',
            round: 1,
            status: 'open',
          },
          {
            severity: 'critical',
            file: 'src/a.ts',
            title: 'Prior resolved finding',
            detail: 'Already resolved in round 1.',
            round: 1,
            status: 'resolved',
          },
        ],
        verdict: 'changes-required',
        round: 1,
        lastReviewedCommitSha: 'r1sha',
        remediationCount: 0,
      });

      // Round-2 candidate reports NOTHING — the agent silently omits the prior
      // open finding and does not confirm the resolved one.
      const { launcher } = makeLauncher({ findings: [] });

      const getFilesChangedBetween = vi.fn().mockResolvedValue(['src/b.ts']);
      const getCurrentCommitSha = vi.fn().mockResolvedValue('r2head');
      const commitExistsInCheckout = vi.fn().mockResolvedValue(true);
      const github = makeGithub({
        getCurrentCommitSha,
        commitExistsInCheckout,
        getFilesChangedBetween,
      });

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(makeContext(github));
      expect(result.success).toBe(true);

      // AC2 / FR-007: the round-2 delta is scoped to the last-reviewed base, not
      // a full re-diff from the PR base.
      expect(commitExistsInCheckout).toHaveBeenCalledWith('r1sha');
      expect(getFilesChangedBetween).toHaveBeenCalledWith('r1sha', 'r2head');

      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted).not.toBeNull();
      expect(persisted!.round).toBe(2);

      const open = persisted!.findings.find((f) => f.title === 'Prior open finding');
      const resolved = persisted!.findings.find((f) => f.title === 'Prior resolved finding');

      // SC-005 anti-vanish: the omitted round-1 finding is neither dropped nor
      // flipped — it stays open.
      expect(open).toBeDefined();
      expect(open!.status).toBe('open');

      // AC3 monotonic: the resolved finding is never reopened.
      expect(resolved).toBeDefined();
      expect(resolved!.status).toBe('resolved');

      // Verdict is recomputed from the merged set and stays changes-required
      // because the open critical finding survived the merge.
      expect(persisted!.verdict).toBe('changes-required');
      expect(persisted!.lastReviewedCommitSha).toBe('r2head');
    });

    it('transitions a prior open finding to resolved ONLY when its file is in the delta AND the candidate confirms it (evidence-based), yielding a clean verdict', async () => {
      await seedPrior({
        findings: [
          {
            severity: 'critical',
            file: 'src/a.ts',
            title: 'Prior open finding',
            detail: 'Raised in round 1.',
            round: 1,
            status: 'open',
          },
        ],
        verdict: 'changes-required',
        round: 1,
        lastReviewedCommitSha: 'r1sha',
        remediationCount: 0,
      });

      // Round-2 candidate confirms the SAME finding (matching file+title ⇒
      // matching deterministic id) as resolved.
      const { launcher } = makeLauncher({
        findings: [
          {
            severity: 'critical',
            file: 'src/a.ts',
            title: 'Prior open finding',
            detail: 'Now fixed by the delta.',
            status: 'resolved',
          },
        ],
      });

      const github = makeGithub({
        getCurrentCommitSha: vi.fn().mockResolvedValue('r2head'),
        commitExistsInCheckout: vi.fn().mockResolvedValue(true),
        // The finding's file IS in the delta window (evidence the delta touched it).
        getFilesChangedBetween: vi.fn().mockResolvedValue(['src/a.ts']),
      });

      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      await executor.execute(makeContext(github));

      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      const finding = persisted!.findings.find((f) => f.title === 'Prior open finding');
      expect(finding!.status).toBe('resolved');
      expect(persisted!.verdict).toBe('clean');
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
      const github = makeGithub({ getCurrentCommitSha: vi.fn().mockResolvedValue('newsha') });

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

    // -----------------------------------------------------------------------
    // Scope consumption: the scope is applied exactly once per `headSha`, even
    // when a prior artifact exists (the real path: conflicts surface at validate
    // entry, AFTER round 1 persisted the sidecar). Subsequent rounds fall back
    // to the `lastReviewedCommitSha`..HEAD delta (#1164 cap-burn fix preserved).
    // -----------------------------------------------------------------------
    async function seedPriorArtifact(prior: unknown): Promise<void> {
      const priorPath = getReviewArtifactPath(checkoutPath, workflowId);
      await mkdir(path.dirname(priorPath), { recursive: true });
      await writeFile(priorPath, JSON.stringify(prior), 'utf-8');
    }

    function makeScopedContextWithPaths(
      github: GitHubClient,
      reviewScope: { baseSha: string; headSha: string; conflictedPaths?: string[] },
    ): WorkerContext {
      return { ...makeContext(github), reviewScope } as WorkerContext;
    }

    it('applies the scope on a round with a PRIOR artifact: scoped + verification charter, allowlisted delta, consumption persisted, lastReviewedCommitSha = merge HEAD', async () => {
      const [sha0, sha1] = await initRepoWithCommits(checkoutPath, 2);
      await seedPriorArtifact({
        findings: [
          {
            severity: 'critical',
            file: 'src/a.ts',
            title: 'Prior open finding',
            detail: 'Raised in round 1.',
            round: 1,
            status: 'open',
          },
        ],
        verdict: 'changes-required',
        round: 1,
        lastReviewedCommitSha: 'r1sha',
        remediationCount: 1,
      });
      // The reviewer confirms the prior finding within the conflicted path.
      const { launcher, launch } = makeLauncher({
        findings: [
          {
            severity: 'critical',
            file: 'src/a.ts',
            title: 'Prior open finding',
            detail: 'Resolved by the conflict resolution.',
            status: 'resolved',
          },
        ],
      });
      // Raw parent-1 diff of the merge commit: brings upstream-only files too.
      const getFilesChangedBetween = vi
        .fn()
        .mockResolvedValue(['upstream/only.ts', 'src/a.ts', 'f1.txt']);
      const github = makeGithub({
        getCurrentCommitSha: vi.fn().mockResolvedValue('mergehead'),
        commitExistsInCheckout: vi.fn().mockResolvedValue(true),
        getFilesChangedBetween,
      });
      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(
        makeScopedContextWithPaths(github, {
          baseSha: sha0!,
          headSha: sha1!,
          conflictedPaths: ['src/a.ts'],
        }),
      );
      expect(result.success).toBe(true);

      // The delta was the resolution window (not lastReviewedCommitSha..HEAD).
      expect(getFilesChangedBetween).toHaveBeenCalledWith(sha0, sha1);
      expect(getFilesChangedBetween).not.toHaveBeenCalledWith('r1sha', 'mergehead');

      // Charter is BOTH scoped (conflicted paths, ignore upstream) AND a
      // verification pass carrying the still-open prior finding.
      expect(launch).toHaveBeenCalledTimes(1);
      const prompt = launch.mock.calls[0]![0].intent.prompt as string;
      expect(prompt).toContain('Conflicted paths:');
      expect(prompt).toContain('- src/a.ts');
      expect(prompt).not.toContain('- upstream/only.ts');
      expect(prompt).toContain('Prior open finding');
      expect(prompt).toContain('## Confirming an addressed finding');

      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted!.round).toBe(2);
      expect(persisted!.consumedReviewScopeHeadSha).toBe(sha1);
      // Next round's delta base is the merge HEAD — never re-spans the upstream merge.
      expect(persisted!.lastReviewedCommitSha).toBe('mergehead');
      expect(persisted!.remediationCount).toBe(1);
      expect(persisted!.findings[0]!.status).toBe('resolved');
      expect(persisted!.verdict).toBe('clean');
    });

    it('does NOT re-apply a consumed scope: the next round is a plain delta verification pass', async () => {
      const [sha0, sha1] = await initRepoWithCommits(checkoutPath, 2);
      await seedPriorArtifact({
        findings: [],
        verdict: 'clean',
        round: 2,
        lastReviewedCommitSha: 'mergehead',
        remediationCount: 0,
        consumedReviewScopeHeadSha: sha1,
      });
      const { launcher, launch } = makeLauncher({ findings: [] });
      const getFilesChangedBetween = vi.fn().mockResolvedValue(['src/b.ts']);
      const github = makeGithub({
        getCurrentCommitSha: vi.fn().mockResolvedValue('r3head'),
        commitExistsInCheckout: vi.fn().mockResolvedValue(true),
        getFilesChangedBetween,
      });
      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      await executor.execute(
        makeScopedContextWithPaths(github, {
          baseSha: sha0!,
          headSha: sha1!,
          conflictedPaths: ['src/a.ts'],
        }),
      );

      // Delta spans the remediation commits (lastReviewed..HEAD), not the scope.
      expect(getFilesChangedBetween).toHaveBeenCalledWith('mergehead', 'r3head');
      expect(getFilesChangedBetween).not.toHaveBeenCalledWith(sha0, sha1);
      const prompt = launch.mock.calls[0]![0].intent.prompt as string;
      expect(prompt).not.toContain('Conflicted paths:');
      expect(prompt).not.toContain(`${sha0}..${sha1}`);
      expect(prompt).toContain('- src/b.ts');

      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted!.round).toBe(3);
      expect(persisted!.consumedReviewScopeHeadSha).toBe(sha1);
    });

    it('applies a NEW scope (different headSha) even though an older one was consumed', async () => {
      const [, sha1, sha2] = await initRepoWithCommits(checkoutPath, 3);
      await seedPriorArtifact({
        findings: [],
        verdict: 'clean',
        round: 2,
        lastReviewedCommitSha: sha1,
        remediationCount: 0,
        consumedReviewScopeHeadSha: sha1,
      });
      const { launcher, launch } = makeLauncher({ findings: [] });
      const getFilesChangedBetween = vi.fn().mockResolvedValue(['f2.txt']);
      const github = makeGithub({
        getCurrentCommitSha: vi.fn().mockResolvedValue(sha2),
        commitExistsInCheckout: vi.fn().mockResolvedValue(true),
        getFilesChangedBetween,
      });
      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      await executor.execute(makeScopedContextWithPaths(github, { baseSha: sha1!, headSha: sha2! }));

      expect(getFilesChangedBetween).toHaveBeenCalledWith(sha1, sha2);
      const prompt = launch.mock.calls[0]![0].intent.prompt as string;
      expect(prompt).toContain(`${sha1}..${sha2}`);
      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted!.consumedReviewScopeHeadSha).toBe(sha2);
    });

    it('empty window WITH a prior artifact does not short-circuit — runs the delta verification pass and records consumption', async () => {
      const [sha] = await initRepoWithCommits(checkoutPath, 1);
      await seedPriorArtifact({
        findings: [
          {
            severity: 'critical',
            file: 'src/a.ts',
            title: 'Prior open finding',
            detail: 'Raised in round 1.',
            round: 1,
            status: 'open',
          },
        ],
        verdict: 'changes-required',
        round: 1,
        lastReviewedCommitSha: 'r1sha',
        remediationCount: 0,
      });
      const { launcher, launch } = makeLauncher({ findings: [] });
      const getFilesChangedBetween = vi.fn().mockResolvedValue(['src/b.ts']);
      const github = makeGithub({
        getCurrentCommitSha: vi.fn().mockResolvedValue('r2head'),
        commitExistsInCheckout: vi.fn().mockResolvedValue(true),
        getFilesChangedBetween,
      });
      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      const result = await executor.execute(
        makeScopedContextWithPaths(github, { baseSha: sha!, headSha: sha! }),
      );
      expect(result.success).toBe(true);
      // A short-circuit here would leave the changes-required prior untouched
      // and re-trigger remediate every round; instead the real pass runs.
      expect(launch).toHaveBeenCalledTimes(1);
      expect(getFilesChangedBetween).toHaveBeenCalledWith('r1sha', 'r2head');
      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted!.round).toBe(2);
      expect(persisted!.consumedReviewScopeHeadSha).toBe(sha);
      // Anti-vanish still holds: the omitted finding stays open.
      expect(persisted!.findings[0]!.status).toBe('open');
    });
  });

  describe('synthetic findings resolve on re-emission (validate-origin / body-only external)', () => {
    async function seedPriorArtifact(prior: unknown): Promise<void> {
      const priorPath = getReviewArtifactPath(checkoutPath, workflowId);
      await mkdir(path.dirname(priorPath), { recursive: true });
      await writeFile(priorPath, JSON.stringify(prior), 'utf-8');
    }

    it('a re-emitted synthetic:validate finding resolves although its "file" (the command) is never in the delta', async () => {
      const command = 'pnpm test && pnpm build';
      await seedPriorArtifact({
        findings: [
          {
            severity: 'critical',
            file: command,
            title: 'validate phase failed',
            detail: 'FAIL src/foo.test.ts',
            round: 2,
            status: 'open',
            synthetic: 'validate',
          },
        ],
        verdict: 'changes-required',
        round: 2,
        lastReviewedCommitSha: 'failsha',
        remediationCount: 1,
      });
      const { launcher, launch } = makeLauncher({
        findings: [
          {
            severity: 'critical',
            file: command,
            title: 'validate phase failed',
            detail: 'The remediation fixed the failing test.',
            status: 'resolved',
          },
        ],
      });
      const github = makeGithub({
        getCurrentCommitSha: vi.fn().mockResolvedValue('fixsha'),
        commitExistsInCheckout: vi.fn().mockResolvedValue(true),
        getFilesChangedBetween: vi.fn().mockResolvedValue(['src/foo.ts']),
      });
      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      await executor.execute(makeContext(github));

      // The charter surfaced the synthetic finding with its tag + instructions.
      const prompt = launch.mock.calls[0]![0].intent.prompt as string;
      expect(prompt).toContain('[synthetic: validate]');
      expect(prompt).toContain('validate phase failed');

      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted!.round).toBe(3);
      expect(persisted!.findings).toHaveLength(1);
      expect(persisted!.findings[0]!.status).toBe('resolved');
      expect(persisted!.findings[0]!.synthetic).toBe('validate');
      expect(persisted!.verdict).toBe('clean');
      expect(persisted!.remediationCount).toBe(1);
    });

    it('an omitted synthetic finding is still carried forward open (anti-vanish)', async () => {
      await seedPriorArtifact({
        findings: [
          {
            severity: 'critical',
            file: '(pr-review)',
            title: 'External feedback from octocat',
            detail: 'Do X',
            round: 1,
            status: 'open',
            synthetic: 'external-body',
          },
        ],
        verdict: 'changes-required',
        round: 1,
        lastReviewedCommitSha: 'seedsha',
        remediationCount: 0,
      });
      const { launcher } = makeLauncher({ findings: [] });
      const github = makeGithub({
        getCurrentCommitSha: vi.fn().mockResolvedValue('r2head'),
        commitExistsInCheckout: vi.fn().mockResolvedValue(true),
        getFilesChangedBetween: vi.fn().mockResolvedValue(['src/x.ts']),
      });
      const executor = new ReviewExecutor({
        agentLauncher: launcher,
        config: baseConfig,
        settings: null,
        logger,
      });

      await executor.execute(makeContext(github));

      const persisted = await readReviewArtifact(checkoutPath, workflowId);
      expect(persisted!.findings[0]!.status).toBe('open');
      expect(persisted!.verdict).toBe('changes-required');
    });
  });
});
