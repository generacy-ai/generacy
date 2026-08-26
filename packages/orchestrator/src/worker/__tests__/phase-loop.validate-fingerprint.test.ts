import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, WorkflowPhase, PhaseResult } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { FailureFingerprintTracker } from '../../services/failure-fingerprint-tracker.js';
import {
  readReviewArtifactSync,
  writeReviewArtifact,
} from '../review-artifact.js';

// ---------------------------------------------------------------------------
// #1129 T010 (SC-002 / SC-003 / FR-008 / FR-009)
//
// Drives the routed validate-failure branch with `reviewPhaseEnabled = true`
// and a linked PR. Asserts:
//  - fingerprint escalation applies `failed:validate-repeated` at
//    REPEAT_FAILURE_THRESHOLD (SC-002);
//  - `failed:validate` (labelManager.onError('validate')) is NEVER applied on
//    the routed path (FR-009);
//  - #1158: the single RemediateExecutor is invoked at exactly one site — the
//    remediate seam — and never on both the routing branch and the remediate
//    seam for one failure (SC-003 / FR-008).
// ---------------------------------------------------------------------------

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

// The failing validate result the routing branch consumes. The captured
// streams carry a deterministic TypeScript error so the fingerprint is stable
// across the fail→remediate→re-run cycle.
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

interface DepsHandles {
  deps: PhaseLoopDeps;
  onError: ReturnType<typeof vi.fn>;
  onRepeatedError: ReturnType<typeof vi.fn>;
  postFailureAlert: ReturnType<typeof vi.fn>;
  remediateExecute: ReturnType<typeof vi.fn>;
  runValidatePhase: ReturnType<typeof vi.fn>;
}

function createDeps(checkoutPath: string, priorCount: number, workflowId: string): DepsHandles {
  const onError = vi.fn().mockResolvedValue(undefined);
  const onRepeatedError = vi.fn().mockResolvedValue(undefined);
  const postFailureAlert = vi.fn().mockResolvedValue(undefined);
  // #1158: both origins converge on the single RemediateExecutor at the seam —
  // the retired ValidateFixHandler adapter is gone.
  const remediateExecute = vi.fn(async (): Promise<PhaseResult> => makeSuccessResult('remediate'));

  // Fail the first validate run, succeed on the post-remediation re-run.
  const runValidatePhase = vi
    .fn()
    .mockResolvedValueOnce(makeValidateFailure())
    .mockResolvedValue(makeSuccessResult('validate'));

  const tracker: FailureFingerprintTracker = {
    countPriorOccurrences: vi.fn(async () => priorCount),
  };

  // Real review executor stand-in: writes a CLEAN artifact so the
  // production-shaped remediateTrigger stops firing after the fix, letting the
  // loop progress to the validate re-run.
  const reviewExecutor = {
    execute: vi.fn(async (): Promise<PhaseResult> => {
      await writeReviewArtifact(checkoutPath, workflowId, {
        findings: [],
        verdict: 'clean',
        round: 99,
        lastReviewedCommitSha: 'cleansha',
      });
      return makeSuccessResult('review');
    }),
  };

  return {
    deps: {
      labelManager: {
        onPhaseStart: vi.fn().mockResolvedValue(undefined),
        onPhaseComplete: vi.fn().mockResolvedValue(undefined),
        onPhaseExecutedWithoutCompletion: vi.fn().mockResolvedValue(undefined),
        onError,
        onRepeatedError,
        onGateHit: vi.fn().mockResolvedValue(undefined),
      } as any,
      stageCommentManager: {
        updateStageComment: vi.fn().mockResolvedValue(undefined),
        postFailureAlert,
      } as any,
      gateChecker: {
        checkGates: vi.fn().mockReturnValue([]),
      } as any,
      cliSpawner: {
        spawnPhase: vi.fn().mockResolvedValue(makeSuccessResult('implement')),
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
        getPrNumber: vi.fn().mockReturnValue(42),
        convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
        markReadyForReview: vi.fn().mockResolvedValue(undefined),
      } as any,
      failureFingerprintTracker: tracker,
      reviewExecutor: reviewExecutor as any,
      remediateExecutor: { execute: remediateExecute } as any,
      // Production-shaped trigger: the remediate seam fires iff the persisted
      // artifact verdict is `changes-required` (mirrors claude-cli-worker wiring).
      remediateTrigger: (ctx: WorkerContext) =>
        readReviewArtifactSync(ctx.checkoutPath, workflowId)?.verdict === 'changes-required',
    },
    onError,
    onRepeatedError,
    postFailureAlert,
    remediateExecute,
    runValidatePhase,
  };
}

function createContext(checkoutPath: string): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: {
      owner: 'christrudelpw',
      repo: 'snappoll',
      issueNumber: 8,
      workflowName: 'speckit-feature',
    } as any,
    startPhase: 'review',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: 'https://github.com/christrudelpw/snappoll/issues/8',
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
    maxImplementRetries: 0,
    reviewPhaseEnabled: true,
  } as WorkerConfig;
}

describe('PhaseLoop validate-failure fingerprint routing (#1129 T010)', () => {
  let phaseLoop: PhaseLoop;
  let checkoutPath: string;
  const workflowId = 'christrudelpw/snappoll#8';

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phaseloop-fp-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
  });

  it('repeat-identical validate failure escalates with failed:validate-repeated at threshold (SC-002)', async () => {
    // One prior identical failure already recorded → occurrence = 2 = threshold.
    const { deps, onError, onRepeatedError, postFailureAlert, remediateExecute } = createDeps(
      checkoutPath,
      1,
      workflowId,
    );

    const result = await phaseLoop.executeLoop(createContext(checkoutPath), createConfig(), deps, [
      'review',
      'validate',
    ]);

    // Terminal escalation on the routed path.
    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('validate');
    expect(onRepeatedError).toHaveBeenCalledWith('validate');

    // FR-009: `failed:validate` is NEVER applied on the routed path.
    expect(onError).not.toHaveBeenCalledWith('validate');

    // Alert carries occurrence = 2 and a well-formed fingerprint.
    expect(postFailureAlert).toHaveBeenCalledTimes(1);
    const alertArg = postFailureAlert.mock.calls[0]![0];
    expect(alertArg.occurrence).toBe(2);
    expect(alertArg.phase).toBe('validate');
    expect(alertArg.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    // SC-003: the terminal path never dispatches the remediate executor.
    expect(remediateExecute).not.toHaveBeenCalled();
  });

  it('first-time validate failure self-heals via exactly one remediate-seam adapter call (SC-003 / FR-008)', async () => {
    // No prior occurrence → occurrence = 1 < threshold → synthesize + remediate.
    const { deps, onError, onRepeatedError, postFailureAlert, remediateExecute, runValidatePhase } =
      createDeps(checkoutPath, 0, workflowId);

    const result = await phaseLoop.executeLoop(createContext(checkoutPath), createConfig(), deps, [
      'review',
      'validate',
    ]);

    // Self-heal reaches the validate green re-run and completes.
    expect(result.completed).toBe(true);

    // Alert posted once with occurrence = 1; no -repeated escalation.
    expect(postFailureAlert).toHaveBeenCalledTimes(1);
    expect(postFailureAlert.mock.calls[0]![0].occurrence).toBe(1);
    expect(onRepeatedError).not.toHaveBeenCalledWith('validate');

    // FR-009: `failed:validate` never applied on the routed path.
    expect(onError).not.toHaveBeenCalledWith('validate');

    // SC-003 / FR-008: the single RemediateExecutor runs at EXACTLY one site —
    // the remediate seam — for one failure. Never both the routing branch and
    // the seam.
    expect(remediateExecute).toHaveBeenCalledTimes(1);

    // validate ran twice: the initial red, then the post-remediation green.
    expect(runValidatePhase).toHaveBeenCalledTimes(2);
  });
});
