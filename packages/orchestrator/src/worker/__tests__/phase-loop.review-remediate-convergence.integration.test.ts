// #1132 US1 (T010–T018) — full review⇄remediate convergence, end-to-end.
//
// Drives PhaseLoop.executeLoop through the REAL review + remediate executor
// seams (via the injectable deps the P3 executors #1124/#1125/#1128/#1129 wired)
// and asserts the whole multi-round loop composes:
//
//   AC1 (T011): a round-1 blocking review routes off-sequence into `remediate`,
//     converts the engine-ready PR back to draft, and backtracks to re-`review`.
//   AC2 (T012): a still-blocking round-2 re-review re-enters `remediate` and the
//     remediation counter increments.
//   AC3 (T013): a clean re-review marks the PR ready and the loop advances into
//     `validate`.
//   AC4 (T014): the SECOND remediate entry point (#1129) — a failing `validate`
//     routes back into `remediate`, re-reviews, and re-validates green.
//   AC5 (T015): a green `validate` after the final remediation terminates the
//     loop forward with no further backtrack.
//   AC6 / FR-006 (T016): the findings artifact + remediation counter stay
//     consistent at every transition (counter increments per remediation round).
//   FR-005 / SC-005 (T017): at most one validate/suite execution per clean-review
//     cycle — the suite never re-runs while findings remain open.
//   FR-004 / SC-006 (T018): every clean review → ready; every remediate entry →
//     back to draft.
//
// Parameterized over both workflows (`speckit-feature`, `speckit-bugfix`). Per
// research.md Decision 2 (Q2=A): each round's verdict is steered by pre-writing
// the review sidecar via a call-scripted stand-in executor that mirrors the real
// ReviewExecutor's write contract (read prior → advance round → preserve the
// remediation budget). No CLI-output shim.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, WorkflowPhase, PhaseResult } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { BaseMergeResult } from '../base-merge.js';
import type { FindingsArtifact } from '../review-findings-artifact.js';
import {
  bumpRemediationCount,
  readReviewArtifactSync,
  writeReviewArtifact,
} from '../review-artifact.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

const OWNER = 'christrudelpw';
const REPO = 'snappoll';
const ISSUE = 1132;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

type Verdict = 'clean' | 'changes-required';

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

function makeValidateFailure(): PhaseResult {
  return {
    phase: 'validate',
    success: false,
    exitCode: 1,
    durationMs: 100,
    output: [],
    capturedStdout: "src/foo.ts:10:5 - error TS2304: Cannot find name 'bar'.",
    capturedStderr: '',
    error: { message: 'validate failed', output: 'exit 1', phase: 'validate' },
  } as PhaseResult;
}

/**
 * Call-scripted review executor stand-in. Mirrors the real ReviewExecutor's
 * persistence contract: read the prior artifact, advance `round`, preserve
 * `remediationCount` (a review write never resets the budget — #1128), and write
 * the steered verdict. The engine recomputes nothing here because the stand-in
 * writes the final verdict directly (Q2=A sidecar-seeding, no CLI shim).
 */
function makeScriptedReviewExecutor(checkoutPath: string, verdicts: Verdict[]) {
  let call = 0;
  const execute = vi.fn(async (): Promise<PhaseResult> => {
    const prior = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    const round = (prior?.round ?? 0) + 1;
    const verdict = verdicts[Math.min(call, verdicts.length - 1)]!;
    call++;
    const findings =
      verdict === 'changes-required'
        ? [
            {
              severity: 'critical' as const,
              file: 'src/a.ts',
              title: 'blocking finding',
              detail: 'must fix',
              round,
              status: 'open' as const,
            },
          ]
        : [];
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings,
      verdict,
      round,
      lastReviewedCommitSha: `sha${round}`,
      remediationCount: prior?.remediationCount ?? 0,
    });
    return makeSuccessResult('review');
  });
  return { execute };
}

/**
 * Mirror the strict ReviewArtifact into the #1125 FindingsArtifact so the review
 * side-effect block (postRound / mark-ready) sees a consistent verdict.
 */
function makeFindingsReader(
  checkoutPath: string,
): (context: WorkerContext) => Promise<{ artifact: FindingsArtifact; round: number } | null> {
  return async () => {
    const ra = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    if (!ra) return null;
    return {
      artifact: {
        verdict: ra.verdict,
        findings: ra.findings.map((f, idx) => ({
          marker: `finding-${idx}`,
          text: f.title,
          severity: 'blocking' as const,
        })),
      },
      round: ra.round,
    };
  };
}

function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

function baseDeps(): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      onRepeatedError: vi.fn().mockResolvedValue(undefined),
      onGateHit: vi.fn().mockResolvedValue(undefined),
    } as any,
    stageCommentManager: {
      updateStageComment: vi.fn().mockResolvedValue(undefined),
      postFailureAlert: vi.fn().mockResolvedValue(undefined),
    } as any,
    gateChecker: {
      checkGates: vi.fn((phase: WorkflowPhase, workflowName: string, config: WorkerConfig) =>
        (config.gates[workflowName] ?? []).filter((g) => g.phase === phase),
      ),
    } as any,
    cliSpawner: {
      spawnPhase: vi.fn().mockImplementation(async (phase: WorkflowPhase) => makeSuccessResult(phase)),
      runValidatePhase: vi.fn().mockResolvedValue(makeSuccessResult('validate')),
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
  };
}

function convergenceContext(checkoutPath: string, workflowName: string): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: {
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      workflowName,
    } as any,
    startPhase: 'review',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
      getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      commitExistsInCheckout: vi.fn().mockResolvedValue(true),
      getIssue: vi.fn().mockResolvedValue({ labels: [], state: 'open' }),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}`,
    description: 'test',
  };
}

function convergenceConfig(): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: '',
    // Configure the cap gate so the test proves convergence does NOT trip it.
    gates: {
      'speckit-feature': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
      'speckit-bugfix': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
    },
    maxImplementRetries: 0,
    reviewPhaseEnabled: true,
  } as WorkerConfig;
}

describe.each([['speckit-feature'], ['speckit-bugfix']])(
  'PhaseLoop full review⇄remediate convergence (#1132 US1) [%s]',
  (workflowName) => {
    let phaseLoop: PhaseLoop;
    let checkoutPath: string;

    beforeEach(async () => {
      phaseLoop = new PhaseLoop(mockLogger);
      checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phaseloop-conv-'));
    });

    afterEach(async () => {
      await fs.rm(checkoutPath, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it('converges over two blocking rounds → clean → validate green (AC1/AC2/AC3/AC5/AC6, T011–T017)', async () => {
      const deps = baseDeps();
      const reviewExecutor = makeScriptedReviewExecutor(checkoutPath, [
        'changes-required', // round 1 — AC1: blocking entry
        'changes-required', // round 2 — AC2: still blocking, re-remediate
        'clean', // round 3 — AC3: clean → ready → validate
      ]);
      const remediateExecute = vi.fn(async (): Promise<PhaseResult> => {
        await bumpRemediationCount(checkoutPath, WORKFLOW_ID);
        return makeSuccessResult('remediate');
      });
      deps.reviewExecutor = reviewExecutor as any;
      deps.remediateExecutor = { execute: remediateExecute } as any;
      deps.remediateTrigger = (ctx) =>
        readReviewArtifactSync(ctx.checkoutPath, WORKFLOW_ID)?.verdict === 'changes-required';
      deps.readFindingsArtifact = makeFindingsReader(checkoutPath);
      deps.reviewPoster = {
        postRound: vi.fn().mockResolvedValue(undefined),
        resolveResolvedThreads: vi.fn().mockResolvedValue(undefined),
      } as any;

      const sequence = getPhaseSequence(workflowName, true) as WorkflowPhase[];
      const result = await phaseLoop.executeLoop(
        convergenceContext(checkoutPath, workflowName),
        convergenceConfig(),
        deps,
        sequence,
      );

      // AC5: forward termination after a green validate — no further backtrack.
      expect(result.completed).toBe(true);
      expect(result.gateHit).toBe(false);
      expect(result.lastPhase).toBe('validate');

      // AC1/AC2/AC3: two blocking rounds each backtrack through `remediate`, the
      // clean round-3 advances into `validate`.
      expect(phaseStartOrder(deps)).toEqual([
        'review',
        'remediate',
        'review',
        'remediate',
        'review',
        'validate',
      ]);

      // AC2/AC6 (T012/T016): the remediation counter increments once per
      // remediation round and the findings artifact is consistent at the end.
      expect(remediateExecute).toHaveBeenCalledTimes(2);
      const finalArtifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
      expect(finalArtifact.remediationCount).toBe(2);
      expect(finalArtifact.round).toBe(3);
      expect(finalArtifact.verdict).toBe('clean');

      // FR-004 / SC-006 (T018): every remediate entry converts the PR back to
      // draft (2 entries), and the single clean review marks it ready.
      expect(deps.prManager.convertToDraftIfEngineMarkedReady).toHaveBeenCalledTimes(2);
      expect(deps.prManager.markReadyForReview).toHaveBeenCalledTimes(1);

      // FR-004 (T018): a review is posted every round; re-review rounds (≥2)
      // resolve prior threads.
      expect((deps.reviewPoster as any).postRound).toHaveBeenCalledTimes(3);
      expect((deps.reviewPoster as any).resolveResolvedThreads).toHaveBeenCalledTimes(2);

      // FR-005 / SC-005 (T017): at most one validate/suite execution per
      // clean-review cycle — the suite never re-runs while findings are open.
      expect(deps.cliSpawner.runValidatePhase).toHaveBeenCalledTimes(1);

      // The cap gate is configured but convergence never trips it.
      expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
    });

    it('validate-failure re-enters remediate → review → validate-green (AC4, T014)', async () => {
      const checkoutPath2 = checkoutPath;
      const handle = vi.fn().mockResolvedValue(undefined);
      const onError = vi.fn().mockResolvedValue(undefined);

      // No-op base-merge runner — its call count is the #914 per-cycle guard
      // assertion (one merge per validate cycle).
      const baseMergeRunner = vi
        .fn<[], Promise<BaseMergeResult>>()
        .mockResolvedValue({ ok: true, baseRef: 'origin/develop' } as BaseMergeResult);

      const runValidatePhase = vi
        .fn()
        .mockResolvedValueOnce(makeValidateFailure())
        .mockResolvedValue(makeSuccessResult('validate'));

      // Review executor always writes CLEAN: the changes-required artifact that
      // drives the remediate seam here is the SYNTHESIZED one from the validate
      // routing branch (#1129), not a reviewer verdict.
      const reviewExecutor = makeScriptedReviewExecutor(checkoutPath2, ['clean']);

      const deps = baseDeps();
      deps.labelManager = {
        onPhaseStart: vi.fn().mockResolvedValue(undefined),
        onPhaseComplete: vi.fn().mockResolvedValue(undefined),
        onError,
        onRepeatedError: vi.fn().mockResolvedValue(undefined),
        onGateHit: vi.fn().mockResolvedValue(undefined),
      } as any;
      deps.cliSpawner = {
        spawnPhase: vi.fn().mockResolvedValue(makeSuccessResult('implement')),
        runValidatePhase,
        runPreValidateInstall: vi.fn().mockResolvedValue(makeSuccessResult('validate')),
      } as any;
      deps.prManager = {
        commitPushAndEnsurePr: vi.fn().mockResolvedValue({ prUrl: null, hasChanges: true }),
        getPrNumber: vi.fn().mockReturnValue(42),
        convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
        markReadyForReview: vi.fn().mockResolvedValue(undefined),
      } as any;
      deps.reviewExecutor = reviewExecutor as any;
      deps.validateFixHandler = { handle } as any;
      deps.baseMergeRunner = baseMergeRunner as any;
      deps.failureFingerprintTracker = {
        countPriorOccurrences: vi.fn(async () => 0),
      } as any;
      deps.remediateTrigger = (ctx) =>
        readReviewArtifactSync(ctx.checkoutPath, WORKFLOW_ID)?.verdict === 'changes-required';

      const ctx = convergenceContext(checkoutPath2, workflowName);
      // #864/#914: branch is required for the pre-phase base-merge to run.
      ctx.branch = `${ISSUE}-validate-remediate`;
      (ctx.github as any).findPRForBranchAnyState = vi
        .fn()
        .mockResolvedValue({ number: 42, state: 'open' });

      const config = convergenceConfig();
      // AC4 exercises the validate-origin entry, not the cap gate.
      config.gates = {};

      const result = await phaseLoop.executeLoop(ctx, config, deps, ['review', 'validate']);

      expect(result.completed).toBe(true);

      // review, validate(fail→route), review(stub→remediate seam via #1129),
      // review(clean), validate(green).
      expect(phaseStartOrder(deps)).toEqual([
        'review',
        'validate',
        'review',
        'remediate',
        'review',
        'validate',
      ]);

      // The #1129 validate-fix adapter dispatches exactly once, at the seam.
      expect(handle).toHaveBeenCalledTimes(1);

      // validate ran twice: the initial red, then the post-remediation green.
      expect(runValidatePhase).toHaveBeenCalledTimes(2);

      // One base-merge per validate cycle (two validate entries → two merges).
      expect(baseMergeRunner).toHaveBeenCalledTimes(2);

      // FR-009: `failed:validate` never applied on the routed path.
      expect(onError).not.toHaveBeenCalledWith('validate');
    });
  },
);
