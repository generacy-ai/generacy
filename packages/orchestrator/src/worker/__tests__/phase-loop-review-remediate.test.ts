/**
 * #1121 T011 — phase-loop wiring for the `review` / `remediate` phases.
 *
 * US1 AC4: with `reviewPhaseEnabled=false` (the default), a feature/bugfix run
 * SKIPS `review` before any label/comment side effect fires — byte-identical to
 * pre-change behavior (FR-008/SC-004). Proven here by asserting the LabelManager
 * never sees `review` (no `onPhaseStart('review')` → no `phase:review` label, no
 * `onPhaseComplete('review')` → no `completed:review`).
 *
 * US2 AC1/AC2: with an injected fire-once-then-false `remediateTrigger`, the loop
 * enters `remediate` off-sequence after `review` completes, re-enters `review`,
 * and terminates (no infinite loop; eventually advances past `review`).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, WorkflowPhase } from '../types.js';
import type { WorkerConfig } from '../config.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

function createMockDeps(): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onPhaseExecutedWithoutCompletion: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
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
      spawnPhase: vi.fn().mockResolvedValue({
        phase: 'implement',
        success: true,
        exitCode: 0,
        durationMs: 100,
        output: [],
      }),
      runValidatePhase: vi.fn().mockResolvedValue({
        phase: 'validate',
        success: true,
        exitCode: 0,
        durationMs: 100,
        output: [],
      }),
      runPreValidateInstall: vi.fn().mockResolvedValue({
        phase: 'validate',
        success: true,
        exitCode: 0,
        durationMs: 100,
        output: [],
      }),
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
      // #1125: remediate entry converts the PR back to draft (no-op unless the
      // engine marked it ready). Stubbed here so the #1121 seam test still runs.
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function createMockContext(startPhase: WorkflowPhase): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 1121,
      workflowName: 'speckit-feature',
    } as any,
    startPhase,
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      getFilesChangedByOwnCommits: vi
        .fn()
        .mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/test/repo/issues/1121',
    description: 'test',
  };
}

function createConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: '',
    gates: {},
    maxImplementRetries: 2,
    ...overrides,
  } as WorkerConfig;
}

function startCalls(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map((c: unknown[]) => c[0]);
}

function completeCalls(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseComplete as any).mock.calls.map((c: unknown[]) => c[0]);
}

describe('#1121 PhaseLoop — review feature-flag skip (US1 AC4)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('skips review with no label side effects when reviewPhaseEnabled is false (default)', async () => {
    const context = createMockContext('implement');
    const config = createConfig(); // reviewPhaseEnabled defaults to false/undefined

    const result = await phaseLoop.executeLoop(context, config, deps, [
      'implement',
      'review',
      'validate',
    ]);

    expect(result.completed).toBe(true);

    // No LabelManager traffic for `review` at all — the skip fires BEFORE
    // onPhaseStart, so neither phase:review nor completed:review is applied.
    expect(startCalls(deps)).not.toContain('review');
    expect(completeCalls(deps)).not.toContain('review');

    // The surrounding phases still run normally (byte-identical behavior).
    expect(startCalls(deps)).toEqual(['implement', 'validate']);
    expect(completeCalls(deps)).toEqual(['implement', 'validate']);
  });

  it('executes review (label side effects fire) when reviewPhaseEnabled is true', async () => {
    const context = createMockContext('implement');
    const config = createConfig({ reviewPhaseEnabled: true } as Partial<WorkerConfig>);

    const result = await phaseLoop.executeLoop(context, config, deps, [
      'implement',
      'review',
      'validate',
    ]);

    expect(result.completed).toBe(true);
    expect(startCalls(deps)).toEqual(['implement', 'review', 'validate']);
    expect(completeCalls(deps)).toEqual(['implement', 'review', 'validate']);
  });
});

describe('#1121 PhaseLoop — off-sequence remediate seam (US2 AC1/AC2)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('enters remediate once, returns to review, and terminates', async () => {
    const context = createMockContext('review');
    const config = createConfig({ reviewPhaseEnabled: true } as Partial<WorkerConfig>);

    // Fire once on the first review completion, then never again — proves the
    // seam is entered exactly once and the loop advances past review afterward.
    let fired = false;
    const remediateTrigger = vi.fn(() => {
      if (fired) return false;
      fired = true;
      return true;
    });

    const result = await phaseLoop.executeLoop(
      context,
      { ...config, } as WorkerConfig,
      { ...deps, remediateTrigger },
      ['review'],
    );

    // Terminates cleanly (no infinite loop).
    expect(result.completed).toBe(true);

    // remediate entered exactly once, off-sequence.
    expect(startCalls(deps).filter((p) => p === 'remediate')).toEqual(['remediate']);
    expect(completeCalls(deps).filter((p) => p === 'remediate')).toEqual(['remediate']);

    // review ran twice: the original pass, then the re-entry after remediate.
    expect(startCalls(deps).filter((p) => p === 'review')).toEqual(['review', 'review']);

    // Ordered trace: review → remediate → review.
    expect(startCalls(deps)).toEqual(['review', 'remediate', 'review']);

    // The synthetic results carry the off-sequence remediate pass.
    expect(result.results.map((r) => r.phase)).toEqual(['review', 'remediate', 'review']);
  });

  it('does not enter remediate when the trigger never fires (dead in production)', async () => {
    const context = createMockContext('review');
    const config = createConfig({ reviewPhaseEnabled: true } as Partial<WorkerConfig>);

    // No remediateTrigger injected → undefined → seam is dead.
    const result = await phaseLoop.executeLoop(context, config, deps, ['review']);

    expect(result.completed).toBe(true);
    expect(startCalls(deps)).toEqual(['review']);
    expect(startCalls(deps)).not.toContain('remediate');
  });
});
