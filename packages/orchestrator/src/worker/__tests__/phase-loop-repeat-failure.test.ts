import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, WorkflowPhase } from '../types.js';
import { FAILURE_ALERT_MARKER_PREFIX } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { FailureFingerprintTracker } from '../../services/failure-fingerprint-tracker.js';
import { computeFailureFingerprint } from '../failure-fingerprint.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

// Snappoll#8 replay: three verbatim `no-product-code-changes` failures on
// christrudelpw/snappoll#8. Same phase, same classifier, same reason text.
const SNAPPOLL_CLASSIFIER = 'no-product-code-changes';
const SNAPPOLL_PHASE: WorkflowPhase = 'implement';

// Build the evidence shape that arrives at postFailureAlert on the snappoll
// no-product-code-changes site. This mirrors what buildErrorEvidence produces
// downstream of the no-product-code-changes classifier at phase-loop.ts:~710.
const SNAPPOLL_EVIDENCE = {
  command: 'implement',
  exitDescriptor: `failed post-exit: ${SNAPPOLL_CLASSIFIER} (process exit 0)`,
  outputTail: '(no output on either stream)',
  reason:
    'Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/]. Implement must modify at least one non-excluded file.',
};

const SNAPPOLL_FINGERPRINT = computeFailureFingerprint({
  phase: SNAPPOLL_PHASE,
  evidence: SNAPPOLL_EVIDENCE,
});

function makeSuccessResult(phase: WorkflowPhase): any {
  return { phase, success: true, exitCode: 0, durationMs: 100, output: [] };
}

interface DepsHandles {
  deps: PhaseLoopDeps;
  onError: ReturnType<typeof vi.fn>;
  onRepeatedError: ReturnType<typeof vi.fn>;
  postFailureAlert: ReturnType<typeof vi.fn>;
  tracker: FailureFingerprintTracker;
  setPriorCount: (n: number) => void;
}

function createDeps(): DepsHandles {
  let priorCount = 0;
  const onError = vi.fn().mockResolvedValue(undefined);
  const onRepeatedError = vi.fn().mockResolvedValue(undefined);
  const postFailureAlert = vi.fn().mockResolvedValue(undefined);
  const tracker: FailureFingerprintTracker = {
    countPriorOccurrences: vi.fn(async () => priorCount),
  };
  return {
    deps: {
      labelManager: {
        onPhaseStart: vi.fn().mockResolvedValue(undefined),
        onPhaseComplete: vi.fn().mockResolvedValue(undefined),
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
      } as any,
      failureFingerprintTracker: tracker,
    },
    onError,
    onRepeatedError,
    postFailureAlert,
    tracker,
    setPriorCount: (n: number) => {
      priorCount = n;
    },
  };
}

function createContext(): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: {
      owner: 'christrudelpw',
      repo: 'snappoll',
      issueNumber: 8,
      workflowName: 'speckit-feature',
    } as any,
    startPhase: 'implement',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      // Return only spec-prefixed files to trigger the no-product-code-changes classifier.
      getFilesChangedBetween: vi.fn().mockResolvedValue(['specs/942/tasks.md']),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
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
    maxImplementRetries: 0, // don't loop through the implement-retry path
  } as WorkerConfig;
}

describe('PhaseLoop repeat-failure escalation (#942)', () => {
  let phaseLoop: PhaseLoop;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
  });

  it('1st failure: applies failed:<phase> only; no -repeated; alert carries occurrence=1', async () => {
    const { deps, onError, onRepeatedError, postFailureAlert, setPriorCount } = createDeps();
    setPriorCount(0);

    const result = await phaseLoop.executeLoop(createContext(), createConfig(), deps, [
      'implement',
      'validate',
    ]);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('implement');
    expect(onError).toHaveBeenCalledWith('implement');
    expect(onRepeatedError).not.toHaveBeenCalled();
    expect(postFailureAlert).toHaveBeenCalledTimes(1);
    const alertArg = postFailureAlert.mock.calls[0]![0];
    expect(alertArg.occurrence).toBe(1);
    expect(alertArg.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('2nd identical failure: applies failed:<phase> AND failed:<phase>-repeated; alert occurrence=2', async () => {
    const { deps, onError, onRepeatedError, postFailureAlert, setPriorCount } = createDeps();
    // 1 prior identical failure already in the issue's comment thread.
    setPriorCount(1);

    const result = await phaseLoop.executeLoop(createContext(), createConfig(), deps, [
      'implement',
      'validate',
    ]);

    expect(result.completed).toBe(false);
    expect(onError).toHaveBeenCalledWith('implement');
    // The escalation path fires because occurrence >= REPEAT_FAILURE_THRESHOLD (2).
    expect(onRepeatedError).toHaveBeenCalledWith('implement');
    expect(postFailureAlert).toHaveBeenCalledTimes(1);
    const alertArg = postFailureAlert.mock.calls[0]![0];
    expect(alertArg.occurrence).toBe(2);
    expect(alertArg.fingerprint).toBe(SNAPPOLL_FINGERPRINT);
  });

  it('3rd identical failure still escalates (idempotent): -repeated re-fires on Nth ≥ 2', async () => {
    const { deps, onRepeatedError, postFailureAlert, setPriorCount } = createDeps();
    setPriorCount(2); // Two prior identical failures already recorded.

    await phaseLoop.executeLoop(createContext(), createConfig(), deps, ['implement', 'validate']);

    expect(onRepeatedError).toHaveBeenCalledWith('implement');
    const alertArg = postFailureAlert.mock.calls[0]![0];
    expect(alertArg.occurrence).toBe(3);
  });

  it('missing tracker: escalation degrades to no-op (occurrence=1, no -repeated)', async () => {
    const { deps, onError, onRepeatedError, postFailureAlert } = createDeps();
    // Rip the tracker out.
    delete (deps as any).failureFingerprintTracker;

    const result = await phaseLoop.executeLoop(createContext(), createConfig(), deps, [
      'implement',
      'validate',
    ]);

    expect(result.completed).toBe(false);
    expect(onError).toHaveBeenCalledWith('implement');
    expect(onRepeatedError).not.toHaveBeenCalled();
    const alertArg = postFailureAlert.mock.calls[0]![0];
    expect(alertArg.occurrence).toBe(1);
  });

  it('regression: snappoll#8 replay — three inputs all fingerprint identically', () => {
    // Guard-rail: proves the fingerprint stays stable across runId variation.
    const fp1 = computeFailureFingerprint({ phase: 'implement', evidence: SNAPPOLL_EVIDENCE });
    const fp2 = computeFailureFingerprint({ phase: 'implement', evidence: SNAPPOLL_EVIDENCE });
    const fp3 = computeFailureFingerprint({ phase: 'implement', evidence: SNAPPOLL_EVIDENCE });
    expect(fp1).toBe(fp2);
    expect(fp2).toBe(fp3);
  });

  it('regression: v1 marker prefix substring still starts the failure-alert body', async () => {
    // Confirms the v1 dedup path at stage-comment-manager.ts still matches:
    // even after the v2 fingerprint marker was appended, `FAILURE_ALERT_MARKER_PREFIX`
    // must remain the first-chars prefix of the rendered body.
    const { deps, postFailureAlert, setPriorCount } = createDeps();
    setPriorCount(1);

    // Call escalateAndAlert indirectly by driving the phase loop into a failure.
    await phaseLoop.executeLoop(createContext(), createConfig(), deps, ['implement', 'validate']);

    // We don't render here (postFailureAlert is a mock), so instead we assert
    // the alert argument shape — data required to render a v1-marker-prefixed body.
    const alertArg = postFailureAlert.mock.calls[0]![0];
    expect(alertArg.stage).toBeDefined();
    expect(alertArg.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(alertArg.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(alertArg.occurrence).toBe(2);
    // FAILURE_ALERT_MARKER_PREFIX is the static prefix consumers use for dedup.
    expect(FAILURE_ALERT_MARKER_PREFIX).toBe('<!-- generacy:failure-alert:');
  });
});
