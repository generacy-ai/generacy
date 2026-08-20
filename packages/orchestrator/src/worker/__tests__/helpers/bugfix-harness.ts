/**
 * #1135 phase-4 integration harness — shared scaffolding for the speckit-bugfix
 * end-to-end scenarios (T008–T012).
 *
 * This harness composes the already-merged P4 product code (#1133 CI merge
 * readiness + #1134 targeted validate / diff classification / fail-then-pass)
 * against `PhaseLoop.executeLoop`. It ships NO product behavior (#1135 FR-010):
 * every scenario consumes real production seams and mocks/injects only the
 * external boundaries (GitHub, the CLI spawner, and — for the fail-then-pass
 * regression proof — the git/pnpm `execFile` spawns + fs overlay, so the REAL
 * `runFailThenPass` regression logic still runs against a controllable seam).
 *
 * Design notes (confirmed bind points):
 *   - `checkoutPath` defaults to the checked-in `bugfix-monorepo` fixture so
 *     `existsSync(pnpm-workspace.yaml)` → `isWorkspace: true` inside
 *     `resolveTargetedValidate` (phase-loop.ts).
 *   - `context.item.workflowName` is `speckit-bugfix` so the targeted-validate
 *     and fail-then-pass branches are reachable (phase-loop.ts:690).
 *   - `config.validateCommand` stays at the built-in DEFAULT so the classifier
 *     is allowed to NARROW it (only the built-in default is rewritten). The
 *     bugfix profile knobs (`profile`, `blockingSeverity`, `failThenPass`) live
 *     in `deps.settings.workflows['speckit-bugfix']`, resolved through the
 *     existing `resolveWorkflowOverrides` precedence — no new resolver.
 *   - `prManager.getPrNumber()` returns `undefined` so `resolveBaseRef` falls
 *     back to `getDefaultBranch()` → `origin/develop` (base `develop`), which is
 *     the ref the targeted `--filter "...[origin/develop]"` form encodes.
 *
 * The `node:child_process` / `node:fs/promises` boundaries are mocked in each
 * TEST file (hoisting), delegating to the shared `failThenPass` validate-seam
 * controller exported here. See the T010 controller comment for the wiring.
 */

import { vi } from 'vitest';
import { PhaseLoop } from '../../phase-loop.js';
import type { PhaseLoopDeps } from '../../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../../types.js';
import { getPhaseSequence } from '../../types.js';
import { DEFAULT_VALIDATE_COMMAND, type WorkerConfig } from '../../config.js';
import { ReviewPoster, matchEngineAuthoredReviewMarker } from '../../review-poster.js';
import type { FindingsArtifact, ReviewVerdict } from '../../review-findings-artifact.js';
import type { CiRun } from '@generacy-ai/workflow-engine';
import type { GitHubClient, CreateReviewInput, Review } from '@generacy-ai/workflow-engine';
import type { OrchestratorSettings } from '@generacy-ai/config';
import {
  FIXTURE_ROOT,
  loadFixtureGraph,
  affectedSet,
  fullWorkspaceCount,
  type FixtureGraph,
} from './bugfix-fixture-graph.js';

// Re-export the fixture-graph surface so scenario files import from one place.
export {
  FIXTURE_ROOT,
  loadFixtureGraph,
  affectedSet,
  fullWorkspaceCount,
  matchEngineAuthoredReviewMarker,
  DEFAULT_VALIDATE_COMMAND,
  PhaseLoop,
  getPhaseSequence,
};
export type { FixtureGraph, PhaseLoopDeps, WorkerContext, WorkerConfig, WorkflowPhase };
export type { FindingsArtifact, ReviewVerdict, CiRun, CreateReviewInput, Review, GitHubClient };

export const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

export function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 100, output: [] };
}

// ---------------------------------------------------------------------------
// T009 — instrumented suite-execution ledger.
//
// #1134 spawns exactly ONE compound validate command via
// `cliSpawner.runValidatePhase(checkoutPath, effectiveCommand, signal)` — there
// is no per-suite seam. The harness therefore derives the per-suite execution
// count by EXPANDING the captured effective command against the fixture graph:
// a targeted `--filter "...[origin/<base>]"` build+test resolves to the affected
// closure; a docs-only form runs builds but ZERO tests; a full-fallback runs the
// whole workspace. Base-ref runs are contributed by the fail-then-pass mock.
// ---------------------------------------------------------------------------

export interface SuiteRun {
  /** Package short name (core/a/b/util/docs) or test-file path. */
  suite: string;
  kind: 'test' | 'build';
  ref: 'branch' | 'base';
  /**
   * Pass/fail verdict for fail-then-pass regression runs (base + branch). Left
   * undefined for the count-only targeted-validate expansion, which measures
   * suite-execution count, not verdicts.
   */
  outcome?: 'pass' | 'fail';
}

export class SuiteLedger {
  readonly runs: SuiteRun[] = [];

  record(run: SuiteRun | SuiteRun[]): void {
    if (Array.isArray(run)) this.runs.push(...run);
    else this.runs.push(run);
  }

  get total(): number {
    return this.runs.length;
  }

  testRuns(ref?: SuiteRun['ref']): SuiteRun[] {
    return this.runs.filter((r) => r.kind === 'test' && (ref === undefined || r.ref === ref));
  }

  buildRuns(ref?: SuiteRun['ref']): SuiteRun[] {
    return this.runs.filter((r) => r.kind === 'build' && (ref === undefined || r.ref === ref));
  }

  byRef(ref: SuiteRun['ref']): SuiteRun[] {
    return this.runs.filter((r) => r.ref === ref);
  }

  /** Distinct suite names that ran tests on the branch (per-suite breakdown). */
  testedSuites(ref: SuiteRun['ref'] = 'branch'): string[] {
    return [...new Set(this.testRuns(ref).map((r) => r.suite))].sort();
  }
}

/** Map a changed repo-relative file to its fixture package short name, if any. */
export function changedPackages(files: string[]): string[] {
  const pkgs = new Set<string>();
  for (const file of files) {
    const m = /^packages\/([^/]+)\//.exec(file);
    if (m) pkgs.add(m[1]!);
  }
  return [...pkgs].sort();
}

/**
 * Expand a captured branch-side effective validate command into the concrete
 * per-suite executions it represents, using the fixture graph. This is the pure
 * counting primitive the count-audit scenarios (T017 / SC-006) assert against.
 */
export function expandBranchValidate(
  command: string,
  graph: FixtureGraph,
  changedFiles: string[],
): SuiteRun[] {
  const affected = affectedSet(graph, changedPackages(changedFiles));
  const full = [...graph.packages].sort();

  // Full-fallback: the built-in default runs verbatim across the whole workspace.
  if (command === DEFAULT_VALIDATE_COMMAND) {
    return full.flatMap((suite) => [
      { suite, kind: 'build' as const, ref: 'branch' as const },
      { suite, kind: 'test' as const, ref: 'branch' as const },
    ]);
  }

  // test-only: `pnpm vitest run <files...>` — one test run per changed test file.
  if (command.startsWith('pnpm vitest run ')) {
    const files = command.slice('pnpm vitest run '.length).trim().split(/\s+/);
    return files.map((suite) => ({ suite, kind: 'test' as const, ref: 'branch' as const }));
  }

  const hasBuild = /pnpm --filter \S+ build/.test(command);
  const hasTest = /pnpm --filter \S+ test/.test(command);

  const runs: SuiteRun[] = [];
  for (const suite of affected) {
    if (hasBuild) runs.push({ suite, kind: 'build', ref: 'branch' });
    if (hasTest) runs.push({ suite, kind: 'test', ref: 'branch' });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// T010 — fail-then-pass VALIDATE-SEAM controller (clarifications Q3=A).
//
// The real `runFailThenPass` (#1134) runs a git worktree + pnpm install + vitest.
// Rather than stub the whole function with a canned outcome — which would prove
// only issuance and outcome-routing, never the base-fail/branch-pass regression
// semantics — the scenarios exercise the REAL logic and mock only its external
// boundary: the `execFile` spawns and the fs overlay.
//
// The vitest run is the "validate seam": it is keyed on (command, ref) where
// `ref` is derived from the spawn cwd (`base` = the detached worktree captured
// from `git worktree add`; `branch` = anything else, i.e. the branch checkout),
// and it returns the injected pass/fail for that ref. Seeding fail@base +
// pass@branch drives the real logic to `{ kind: 'pass' }`; seeding pass@base
// drives it to `{ kind: 'fail', reason: 'base-passed' }` — a genuine regression
// proof, not a stubbed verdict. If the product code regressed to accept a test
// that PASSES on the base ref, the pass@base scenario would complete and fail.
//
// Each TEST file installs the two mocks (hoisted, imports are hoist-safe in
// vi.mock factories) delegating to THIS controller:
//
//   vi.mock('node:child_process', async (orig) => ({
//     ...(await orig()),
//     execFile: (...a) => failThenPass.execFile(...a),
//   }));
//   vi.mock('node:fs/promises', async (orig) => ({
//     ...(await orig()),
//     mkdtemp: failThenPass.mkdtemp,
//     mkdir: failThenPass.mkdir,
//     copyFile: failThenPass.copyFile,
//   }));
//
// The scenario sets `failThenPass.outcomes` (per-ref verdicts) before running.
// ---------------------------------------------------------------------------

export interface FailThenPassSeamOutcomes {
  base: 'pass' | 'fail';
  branch: 'pass' | 'fail';
}

export interface CapturedVitestRun {
  ref: 'base' | 'branch';
  files: string[];
  outcome: 'pass' | 'fail';
}

type ExecFileCallback = (err: unknown, res?: { stdout: string; stderr: string }) => void;

export const failThenPass = {
  /**
   * Injected per-ref verdicts for the validate seam. Default is the passing
   * regression shape: the changed test FAILS on the base ref (reproduces the
   * bug) and PASSES on the branch (the fix resolves it).
   */
  outcomes: { base: 'fail', branch: 'pass' } as FailThenPassSeamOutcomes,
  /** When set, base+branch regression runs are recorded here with their verdict. */
  ledger: undefined as SuiteLedger | undefined,
  /** Every vitest run the seam served, in call order (issuance assertions). */
  vitestRuns: [] as CapturedVitestRun[],
  /** Detached-worktree path captured from `git worktree add`; identifies base runs. */
  worktreePath: undefined as string | undefined,

  /**
   * `execFile` handler installed by `vi.mock('node:child_process')`. Routes the
   * git worktree add/remove + pnpm install to benign success, and dispatches the
   * `pnpm vitest run <files>` spawn through the (command, ref)-keyed seam.
   */
  execFile(cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown): void {
    const opts = (typeof optsOrCb === 'function' ? {} : optsOrCb) as { cwd?: string };
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ExecFileCallback;

    // git worktree add --detach <worktreePath> <baseRef>
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      failThenPass.worktreePath = args[3];
      return cb(null, { stdout: '', stderr: '' });
    }
    // git worktree remove --force <worktreePath>
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
      return cb(null, { stdout: '', stderr: '' });
    }
    // pnpm install ... (base env preparation)
    if (cmd === 'pnpm' && args[0] === 'install') {
      return cb(null, { stdout: 'installed', stderr: '' });
    }
    // pnpm vitest run <files...> — THE VALIDATE SEAM, keyed on (command, ref).
    if (cmd === 'pnpm' && args[0] === 'vitest' && args[1] === 'run') {
      const files = args.slice(2);
      const ref: 'base' | 'branch' =
        opts.cwd !== undefined && opts.cwd === failThenPass.worktreePath ? 'base' : 'branch';
      const outcome = failThenPass.outcomes[ref];
      failThenPass.vitestRuns.push({ ref, files, outcome });
      if (failThenPass.ledger) {
        for (const file of files) {
          failThenPass.ledger.record({ suite: file, kind: 'test', ref, outcome });
        }
      }
      if (outcome === 'pass') {
        return cb(null, { stdout: `${ref} green`, stderr: '' });
      }
      const err = new Error('vitest failed') as Error & { stdout?: string; stderr?: string };
      err.stdout = `${ref} red`;
      err.stderr = '';
      return cb(err);
    }
    // Anything else: benign success.
    return cb(null, { stdout: '', stderr: '' });
  },

  // fs/promises overrides so the overlay + temp-dir setup never touch the disk.
  mkdtemp: (prefix: string): Promise<string> => Promise.resolve(`${prefix}XXXX`),
  mkdir: (): Promise<undefined> => Promise.resolve(undefined),
  copyFile: (): Promise<undefined> => Promise.resolve(undefined),

  /** Base-ref vitest runs the seam served (with verdicts). */
  baseRuns(): CapturedVitestRun[] {
    return failThenPass.vitestRuns.filter((r) => r.ref === 'base');
  },
  /** Branch vitest runs the seam served (with verdicts). */
  branchRuns(): CapturedVitestRun[] {
    return failThenPass.vitestRuns.filter((r) => r.ref === 'branch');
  },

  reset(): void {
    failThenPass.outcomes = { base: 'fail', branch: 'pass' };
    failThenPass.ledger = undefined;
    failThenPass.vitestRuns = [];
    failThenPass.worktreePath = undefined;
  },
};

// ---------------------------------------------------------------------------
// T011 — CI-status injection.
//
// The post-validate CI merge gate reads `context.github.getCiRunsForSha` through
// `waitForCiGreen`. `success` runs → `green`; `skipped`/`neutral` are dropped by
// `aggregateCiVerdict` so an all-skipped set → `pending` → (with a 0 timeout) a
// `waiting-for:ci` pause, and the `implementation-review` gate is never raised.
// ---------------------------------------------------------------------------

export function ciRun(conclusion: CiRun['conclusion'], status = 'completed'): CiRun {
  return { status, conclusion };
}

/** Convenience CI shapes for the scenarios. */
export const CI = {
  green: (): CiRun[] => [ciRun('success')],
  skippedOnly: (): CiRun[] => [ciRun('skipped')],
  neutralOnly: (): CiRun[] => [ciRun('neutral')],
  skippedAndNeutral: (): CiRun[] => [ciRun('skipped'), ciRun('neutral')],
  failing: (): CiRun[] => [ciRun('failure'), ciRun('success')],
};

/**
 * The relocated post-validate final gate (#1133). `createConfig`'s plain-object
 * cast bypasses the Zod `.transform` that installs the default gates, so
 * scenarios that exercise the gate must override `gateChecker.checkGates` to
 * return this. The `on-ci-green` condition activates only when the CI verdict
 * resolved to `green`.
 */
export function onCiGreenGate(): Array<{
  phase: WorkflowPhase;
  gateLabel: string;
  condition: string;
}> {
  return [
    { phase: 'validate', gateLabel: 'waiting-for:implementation-review', condition: 'on-ci-green' },
  ];
}

// ---------------------------------------------------------------------------
// Deps / context / config / settings builders.
// ---------------------------------------------------------------------------

/**
 * Capturing GitHubClient spy for the real ReviewPoster (mirrors the P2 template).
 * The review posting path is exercised end-to-end so the bugfix review→validate
 * transition is real, not stubbed.
 */
export function createPosterGithub(): GitHubClient {
  return {
    listReviews: vi.fn(async () => [] as Review[]),
    listPullRequestFiles: vi.fn(async () => []),
    getPRReviewThreads: vi.fn(async () => []),
    resolveReviewThread: vi.fn(async () => undefined),
    createReview: vi.fn(
      async (): Promise<Review> => ({
        id: 1,
        user: { login: 'generacy[bot]' },
        body: '',
        state: 'COMMENTED',
        submittedAt: new Date().toISOString(),
      }),
    ),
  } as unknown as GitHubClient;
}

export interface BugfixDepsOptions {
  /** GitHubClient handed to the ReviewPoster. Defaults to a fresh spy. */
  posterGithub?: GitHubClient;
  /**
   * Verdict returned by `readFindingsArtifact` keyed by review round. Round 1
   * defaults to `clean`; supply a per-round map to steer remediate cycles.
   */
  verdictByRound?: (round: number) => FindingsArtifact;
  /** Explicit gate list for `gateChecker.checkGates`. Defaults to `[]`. */
  gates?: ReturnType<typeof onCiGreenGate>;
  /** Ledger the validate stub records the branch-side effective command into. */
  ledger?: SuiteLedger;
  /** Fixture graph + changed files needed to expand the captured command. */
  graph?: FixtureGraph;
  changedFiles?: string[];
  /** Bugfix profile settings (profile / blockingSeverity / failThenPass). */
  settings?: OrchestratorSettings;
}

export interface BugfixDeps extends PhaseLoopDeps {
  /** Effective validate commands captured, in call order. */
  validateCommands: string[];
}

export function createBugfixDeps(options: BugfixDepsOptions = {}): BugfixDeps {
  const posterGithub = options.posterGithub ?? createPosterGithub();
  const validateCommands: string[] = [];

  const runValidatePhase = vi.fn(
    async (_checkoutPath: string, command: string): Promise<PhaseResult> => {
      validateCommands.push(command);
      if (options.ledger && options.graph && options.changedFiles) {
        options.ledger.record(
          expandBranchValidate(command, options.graph, options.changedFiles),
        );
      }
      return makeSuccessResult('validate');
    },
  );

  // Round-steered verdict for the review phase (US1 clean happy path by default).
  let lastVerdict: ReviewVerdict | null = null;
  const verdictByRound =
    options.verdictByRound ??
    ((): FindingsArtifact => ({
      verdict: 'clean',
      findings: [{ marker: 'f-adv-1', text: 'nit', severity: 'advisory' }],
    }));

  const deps: BugfixDeps = {
    validateCommands,
    settings: options.settings,
    // External boundary: the real `performBaseMerge` shells out to `git merge`
    // against `checkoutPath` (the checked-in fixture inside the real repo). Inject
    // a no-op success so no real base-merge runs at the implement/validate 2b/3a hooks.
    baseMergeRunner: (async () => ({ ok: true, baseRef: 'origin/develop' })) as any,
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      onGateHit: vi.fn().mockResolvedValue(undefined),
    } as any,
    stageCommentManager: {
      updateStageComment: vi.fn().mockResolvedValue(undefined),
      postFailureAlert: vi.fn().mockResolvedValue(undefined),
    } as any,
    gateChecker: {
      // Faithful to the real GateChecker.checkGates: return only gates whose
      // `phase` matches the phase being evaluated (prevents the validate-scoped
      // on-ci-green gate from being evaluated at the review phase).
      checkGates: vi.fn((phase: WorkflowPhase) =>
        (options.gates ?? []).filter((g) => g.phase === phase),
      ),
    } as any,
    cliSpawner: {
      spawnPhase: vi
        .fn()
        .mockImplementation(async (phase: WorkflowPhase) => makeSuccessResult(phase)),
      runValidatePhase,
      runPreValidateInstall: vi.fn().mockResolvedValue(makeSuccessResult('validate')),
    } as any,
    outputCapture: {
      processChunk: vi.fn(),
      flush: vi.fn(),
      getOutput: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as any,
    prManager: {
      commitPushAndEnsurePr: vi.fn().mockResolvedValue({ prUrl: null, hasChanges: true }),
      getPrNumber: vi.fn().mockReturnValue(undefined),
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
    reviewPoster: new ReviewPoster({
      github: posterGithub,
      owner: 'test',
      repo: 'repo',
      prNumber: 42,
      logger: mockLogger,
    }),
    readFindingsArtifact: vi.fn(async (_ctx: WorkerContext, round: number) => {
      const artifact = verdictByRound(round);
      lastVerdict = artifact.verdict;
      return artifact;
    }),
    remediateTrigger: () => lastVerdict === 'changes-required',
  };

  return deps;
}

export interface BugfixContextOptions {
  /** Files the branch diff reports against `origin/develop`. */
  changedFiles?: string[];
  /** CI runs `getCiRunsForSha` returns. */
  ciRuns?: CiRun[];
  /** Issue labels `getIssue` returns (gate completion check). */
  issueLabels?: string[];
  startPhase?: WorkflowPhase;
  /**
   * Branch name. Defaults to `undefined` so the loop-entry push guard
   * (`if (context.branch)`) is skipped — the guard would otherwise call
   * `findPRForBranchAnyState` (absent from the stub) and a real `git ls-remote`
   * against the fixture. Branch value is functionally irrelevant to the P4 seams
   * (CI path uses `?? ''`, phase-start-ref uses `?? 'no-branch'`).
   */
  branch?: string;
}

export function createBugfixContext(options: BugfixContextOptions = {}): WorkerContext {
  const changedFiles = options.changedFiles ?? ['packages/core/src/x.ts'];
  const ciRuns = options.ciRuns ?? CI.green();
  const issueLabels = options.issueLabels ?? [];

  return {
    workerId: 'test-worker',
    jobId: 'test-job-1135',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 1135,
      workflowName: 'speckit-bugfix',
    } as any,
    startPhase: options.startPhase ?? 'validate',
    branch: options.branch,
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(changedFiles),
      getFilesChangedBetween: vi.fn().mockResolvedValue(changedFiles),
      getCiRunsForSha: vi.fn().mockResolvedValue({ runs: ciRuns, source: 'check-runs' }),
      getIssue: vi.fn().mockResolvedValue({ labels: issueLabels }),
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: FIXTURE_ROOT,
    issueUrl: 'https://github.com/test/repo/issues/1135',
    description: 'test',
  };
}

/**
 * Bugfix-profile config. Keeps `validateCommand` at the built-in DEFAULT so the
 * classifier is permitted to narrow it. `reviewPhaseEnabled` on by default so the
 * review phase is in the effective sequence; CI merge gate toggled per scenario.
 */
export function createBugfixConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: DEFAULT_VALIDATE_COMMAND,
    preValidateCommand: '',
    gates: {},
    maxImplementRetries: 2,
    reviewPhaseEnabled: true,
    ciMergeGateEnabled: false,
    ciWaitTimeoutMs: 0,
    ...overrides,
  } as WorkerConfig;
}

/**
 * Bugfix-profile settings resolved through the existing `resolveWorkflowOverrides`
 * precedence (workflow → cluster). `maxRemediations` is left to the built-in
 * bugfix default (2). `failThenPass` is opt-in per scenario.
 */
export function bugfixSettings(opts: { failThenPass?: boolean } = {}): OrchestratorSettings {
  return {
    workflows: {
      'speckit-bugfix': {
        review: {
          profile: 'verification',
          blockingSeverity: 'critical',
          failThenPass: opts.failThenPass ?? false,
        },
      },
    },
  } as OrchestratorSettings;
}

// ---------------------------------------------------------------------------
// Shared assertions / observability helpers.
// ---------------------------------------------------------------------------

/** Phases in the order the loop marked them active (via labelManager.onPhaseStart). */
export function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

/** A `remediateTrigger` that fires exactly once, then returns false. */
export function fireOnceTrigger(): () => boolean {
  let fired = false;
  return () => {
    if (fired) return false;
    fired = true;
    return true;
  };
}

/** Findings artifact with a round-1 blocking "missing regression test" finding. */
export function missingRegressionTestArtifact(round: number): FindingsArtifact {
  if (round === 1) {
    return {
      verdict: 'changes-required',
      findings: [
        {
          marker: 'f-block-1',
          text: 'Missing regression test that fails without the fix',
          severity: 'blocking',
        },
      ],
    };
  }
  return { verdict: 'clean', findings: [] };
}
