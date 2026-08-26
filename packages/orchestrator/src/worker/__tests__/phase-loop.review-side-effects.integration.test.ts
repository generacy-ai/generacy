/**
 * #1125 T021 — review side-effect wiring through the phase loop (US2/US3).
 *
 * Drives the `#1125` review side-effect block against a mock ReviewPoster +
 * PrManager via the injectable `readFindingsArtifact` seam. Pins SC-002 (clean
 * verdict → PR marked ready, before validate by linear order), SC-003
 * (remediate entry → PR converted to draft), and the production-inertness
 * invariant (seam undefined → zero poster/PR-lifecycle calls, byte-identical
 * loop behavior).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { ReviewArtifact, Severity } from '../review-artifact.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 100, output: [] };
}

function createMockDeps(): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onPhaseExecutedWithoutCompletion: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      onGateHit: vi.fn().mockResolvedValue(undefined),
    } as never,
    stageCommentManager: {
      updateStageComment: vi.fn().mockResolvedValue(undefined),
      postFailureAlert: vi.fn().mockResolvedValue(undefined),
    } as never,
    gateChecker: {
      checkGates: vi.fn().mockReturnValue([]),
    } as never,
    cliSpawner: {
      spawnPhase: vi.fn().mockImplementation(async (phase: WorkflowPhase) => makeSuccessResult(phase)),
      runValidatePhase: vi.fn().mockResolvedValue(makeSuccessResult('validate')),
      runPreValidateInstall: vi.fn().mockResolvedValue(makeSuccessResult('validate')),
    } as never,
    outputCapture: {
      processChunk: vi.fn(),
      flush: vi.fn(),
      getOutput: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as never,
    prManager: {
      commitPushAndEnsurePr: vi.fn().mockResolvedValue({ prUrl: null, hasChanges: true }),
      getPrNumber: vi.fn().mockReturnValue(7),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
    } as never,
  };
}

function createMockContext(): WorkerContext {
  return {
    workerId: 'test-worker',
    item: { owner: 'o', repo: 'r', issueNumber: 1125, workflowName: 'speckit-feature' } as never,
    startPhase: 'implement',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    } as never,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/o/r/issues/1125',
    description: 'test',
  };
}

function createConfig(): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: '',
    gates: {},
    maxImplementRetries: 2,
    reviewPhaseEnabled: true,
  } as WorkerConfig;
}

function makeReviewPoster() {
  return {
    postRound: vi.fn().mockResolvedValue(undefined),
    resolveResolvedThreads: vi.fn().mockResolvedValue(undefined),
  };
}

// #1161 collapsed the poster/convergence schemas onto the single canonical
// `ReviewArtifact`; the review side-effect block now reads `artifact.round` off
// the artifact itself and receives `blockingSeverity` from the seam.
const BLOCKING_SEVERITY: Severity = 'critical';

function reviewArtifact(overrides: Partial<ReviewArtifact>): ReviewArtifact {
  return {
    verdict: 'clean',
    findings: [],
    round: 1,
    lastReviewedCommitSha: 'sha',
    remediationCount: 0,
    markedReadyByEngine: false,
    ...overrides,
  };
}

const CLEAN: ReviewArtifact = reviewArtifact({ verdict: 'clean', findings: [], round: 1 });
const CHANGES_R1: ReviewArtifact = reviewArtifact({
  verdict: 'changes-required',
  round: 1,
  findings: [
    { id: 'm1', severity: 'critical', file: 'src/a.ts', title: 'fix', detail: 'fix', round: 1, status: 'open' },
  ],
});
const CHANGES_R2: ReviewArtifact = reviewArtifact({
  verdict: 'changes-required',
  round: 2,
  findings: [
    { id: 'm1', severity: 'critical', file: 'src/a.ts', title: 'fix', detail: 'fix', round: 2, status: 'open' },
  ],
});

describe('#1125 review side effects through the phase loop', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('SC-002: clean verdict posts one review and marks the PR ready before validate', async () => {
    const reviewPoster = makeReviewPoster();
    deps.reviewPoster = reviewPoster as never;
    deps.readFindingsArtifact = vi
      .fn()
      .mockResolvedValue({ artifact: CLEAN, blockingSeverity: BLOCKING_SEVERITY });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(createMockContext(), createConfig(), deps, sequence);

    expect(result.completed).toBe(true);
    expect(reviewPoster.postRound).toHaveBeenCalledTimes(1);
    expect(reviewPoster.postRound).toHaveBeenCalledWith(CLEAN.findings, 1, BLOCKING_SEVERITY);
    // First round → no thread resolution.
    expect(reviewPoster.resolveResolvedThreads).not.toHaveBeenCalled();

    const markReady = deps.prManager.markReadyForReview as ReturnType<typeof vi.fn>;
    const runValidate = deps.cliSpawner.runValidatePhase as ReturnType<typeof vi.fn>;
    expect(markReady).toHaveBeenCalledTimes(1);
    // Marked ready BEFORE validate ran (review is linear-before-validate).
    expect(markReady.mock.invocationCallOrder[0]!).toBeLessThan(runValidate.mock.invocationCallOrder[0]!);
  });

  it('does not mark ready when the verdict is changes-required', async () => {
    const reviewPoster = makeReviewPoster();
    deps.reviewPoster = reviewPoster as never;
    deps.readFindingsArtifact = vi
      .fn()
      .mockResolvedValue({ artifact: CHANGES_R1, blockingSeverity: BLOCKING_SEVERITY });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    await phaseLoop.executeLoop(createMockContext(), createConfig(), deps, sequence);

    expect(reviewPoster.postRound).toHaveBeenCalledTimes(1);
    expect(deps.prManager.markReadyForReview).not.toHaveBeenCalled();
  });

  it('SC-003: on remediate entry the PR is converted to draft, then re-review resolves threads (round ≥ 2)', async () => {
    const reviewPoster = makeReviewPoster();
    deps.reviewPoster = reviewPoster as never;
    // Round 1 clean would end the loop; drive a remediate pass with a fire-once
    // trigger so the loop re-reviews at round 2.
    let fired = false;
    deps.remediateTrigger = () => {
      if (fired) return false;
      fired = true;
      return true;
    };
    // #1156 FR-005: round is authoritative from the sidecar. Round 1 on the first
    // review pass, round 2 after the remediate backtrack — so the re-review both
    // escapes the dedupe skip and satisfies the `round >= 2` thread-resolution gate.
    deps.readFindingsArtifact = vi
      .fn()
      .mockResolvedValueOnce({ artifact: CHANGES_R1, blockingSeverity: BLOCKING_SEVERITY })
      .mockResolvedValueOnce({ artifact: CHANGES_R2, blockingSeverity: BLOCKING_SEVERITY });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(createMockContext(), createConfig(), deps, sequence);

    expect(result.completed).toBe(true);
    // Two review passes: round 1 and round 2 (after the remediate backtrack).
    expect(reviewPoster.postRound).toHaveBeenCalledTimes(2);
    expect(reviewPoster.postRound).toHaveBeenNthCalledWith(1, CHANGES_R1.findings, 1, BLOCKING_SEVERITY);
    expect(reviewPoster.postRound).toHaveBeenNthCalledWith(2, CHANGES_R2.findings, 2, BLOCKING_SEVERITY);
    // Round 2 → threads resolved.
    expect(reviewPoster.resolveResolvedThreads).toHaveBeenCalledTimes(1);
    // Remediate entry converted the PR back to draft.
    expect(deps.prManager.convertToDraftIfEngineMarkedReady).toHaveBeenCalledTimes(1);
  });

  it('inertness: with readFindingsArtifact undefined, no poster/PR-lifecycle calls fire', async () => {
    const reviewPoster = makeReviewPoster();
    deps.reviewPoster = reviewPoster as never;
    // deps.readFindingsArtifact intentionally left undefined (production default).
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(createMockContext(), createConfig(), deps, sequence);

    expect(result.completed).toBe(true);
    expect(reviewPoster.postRound).not.toHaveBeenCalled();
    expect(reviewPoster.resolveResolvedThreads).not.toHaveBeenCalled();
    expect(deps.prManager.markReadyForReview).not.toHaveBeenCalled();
    expect(deps.prManager.convertToDraftIfEngineMarkedReady).not.toHaveBeenCalled();
  });
});
