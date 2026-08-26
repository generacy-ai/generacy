// #1158 PR #1173 review — branch-untouched guarantee (FR-007 / SC-005).
//
// A clean-run remediate that exits non-zero (`timedOut=false`, `exitCode!=0`)
// must leave the branch untouched. Skipping the remediate commit is not
// enough: the failed fixer may have left dirty tracked files and/or new
// untracked files in the working tree. On the `i--` re-entry, the review
// phase's step-5 `commitPushAndEnsurePr('review')` runs
// getStatus → stageAll → commit and would land that abandoned partial fix on
// the branch under a 'complete review phase' commit. The loop must revert the
// working tree (hard-reset + clean, preserving `.generacy/`) before continuing.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, WorkflowPhase, PhaseResult } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { ReviewArtifact, Severity } from '../review-artifact.js';
import { readReviewArtifactSync, writeReviewArtifact } from '../review-artifact.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

const OWNER = 'christrudelpw';
const REPO = 'snappoll';
const ISSUE = 1158;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

type Verdict = 'clean' | 'changes-required';

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

/** Scripted review executor: writes the steered verdict, advancing `round`. */
function makeScriptedReviewExecutor(checkoutPath: string, verdicts: Verdict[]) {
  let call = 0;
  const execute = vi.fn(async (): Promise<PhaseResult> => {
    const prior = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    const round = (prior?.round ?? 0) + 1;
    const verdict = verdicts[Math.min(call, verdicts.length - 1)]!;
    call++;
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings:
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
          : [],
      verdict,
      round,
      lastReviewedCommitSha: `sha${round}`,
      remediationCount: prior?.remediationCount ?? 0,
    });
    return makeSuccessResult('review');
  });
  return { execute };
}

function makeFindingsReader(
  checkoutPath: string,
): (context: WorkerContext) => Promise<{ artifact: ReviewArtifact; blockingSeverity: Severity } | null> {
  return async () => {
    const ra = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    if (!ra) return null;
    // Live seam shape (#1161): the canonical artifact (round lives in `ra.round`)
    // plus the blocking severity used for the poster's render projection.
    return { artifact: ra, blockingSeverity: 'critical' };
  };
}

function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

function makeGithub() {
  return {
    getDefaultBranch: vi.fn().mockResolvedValue('develop'),
    getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
    getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
    getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    commitExistsInCheckout: vi.fn().mockResolvedValue(true),
    getIssue: vi.fn().mockResolvedValue({ labels: [], state: 'open' }),
    discardWorkingTreeChanges: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(
  checkoutPath: string,
  remediateResult: PhaseResult,
): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onPhaseExecutedWithoutCompletion: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      onRepeatedError: vi.fn().mockResolvedValue(undefined),
      onGateHit: vi.fn().mockResolvedValue(undefined),
    } as any,
    stageCommentManager: {
      updateStageComment: vi.fn().mockResolvedValue(undefined),
      postFailureAlert: vi.fn().mockResolvedValue(undefined),
    } as any,
    gateChecker: {
      checkGates: vi.fn().mockReturnValue([]),
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
      getPrNumber: vi.fn().mockReturnValue(42),
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
    reviewExecutor: makeScriptedReviewExecutor(checkoutPath, ['changes-required', 'clean']) as any,
    remediateExecutor: { execute: vi.fn(async (): Promise<PhaseResult> => remediateResult) } as any,
    remediateTrigger: (ctx: WorkerContext) =>
      readReviewArtifactSync(ctx.checkoutPath, WORKFLOW_ID)?.verdict === 'changes-required',
    readFindingsArtifact: makeFindingsReader(checkoutPath),
    reviewPoster: {
      postRound: vi.fn().mockResolvedValue(undefined),
      resolveResolvedThreads: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function makeContext(checkoutPath: string): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: { owner: OWNER, repo: REPO, issueNumber: ISSUE, workflowName: 'speckit-feature' } as any,
    startPhase: 'review',
    github: makeGithub() as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}`,
    description: 'test',
  };
}

function makeConfig(): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: '',
    gates: {},
    maxImplementRetries: 0,
    reviewPhaseEnabled: true,
  } as WorkerConfig;
}

describe('PhaseLoop remediate skip → branch untouched (#1158 FR-007 / SC-005)', () => {
  let phaseLoop: PhaseLoop;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phaseloop-skip-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('a clean-run non-zero remediate reverts the working tree and never commits the remediate', async () => {
    const deps = makeDeps(checkoutPath, {
      phase: 'remediate',
      success: false,
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      output: [],
    } as PhaseResult);
    const ctx = makeContext(checkoutPath);

    const result = await phaseLoop.executeLoop(ctx, makeConfig(), deps, ['review', 'validate']);

    // Loop still self-heals to a clean re-review and advances to validate.
    expect(result.completed).toBe(true);
    expect(phaseStartOrder(deps)).toEqual(['review', 'remediate', 'review', 'validate']);

    // FR-007 / SC-005: the working tree is reverted (hard-reset + clean),
    // preserving `.generacy/` so the review sidecar survives.
    expect(ctx.github.discardWorkingTreeChanges).toHaveBeenCalledTimes(1);
    expect(ctx.github.discardWorkingTreeChanges).toHaveBeenCalledWith(['.generacy']);

    // The abandoned partial fix is NEVER committed: no remediate commit fires.
    const commitPhases = (deps.prManager.commitPushAndEnsurePr as any).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(commitPhases).not.toContain('remediate');
  });

  it('a timeout-kill remediate keeps partial work — commits and does NOT revert', async () => {
    const deps = makeDeps(checkoutPath, {
      phase: 'remediate',
      success: false,
      exitCode: null,
      timedOut: true,
      durationMs: 1,
      output: [],
    } as PhaseResult);
    const ctx = makeContext(checkoutPath);

    const result = await phaseLoop.executeLoop(ctx, makeConfig(), deps, ['review', 'validate']);

    expect(result.completed).toBe(true);

    // Partial work from a timeout-kill is worth keeping: commit the remediate,
    // never revert the tree.
    const commitPhases = (deps.prManager.commitPushAndEnsurePr as any).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(commitPhases).toContain('remediate');
    expect(ctx.github.discardWorkingTreeChanges).not.toHaveBeenCalled();
  });

  it('aborts the loop if the working-tree revert itself fails', async () => {
    const deps = makeDeps(checkoutPath, {
      phase: 'remediate',
      success: false,
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      output: [],
    } as PhaseResult);
    const ctx = makeContext(checkoutPath);
    (ctx.github.discardWorkingTreeChanges as any).mockRejectedValue(new Error('git reset failed'));

    const result = await phaseLoop.executeLoop(ctx, makeConfig(), deps, ['review', 'validate']);

    // Cannot guarantee a clean branch → abort rather than commit garbage.
    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('remediate');
    // Never re-enters review after the failed revert.
    expect(phaseStartOrder(deps)).toEqual(['review', 'remediate']);
  });
});
