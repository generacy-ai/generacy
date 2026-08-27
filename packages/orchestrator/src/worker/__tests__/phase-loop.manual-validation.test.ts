import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { TasksMdEvaluation } from '../tasks-md-fallback.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import type { WorkerConfig } from '../config.js';

const MANUAL_GATE = 'waiting-for:manual-validation';

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

type CapturedLog = { obj: Record<string, unknown>; msg?: string };

function createCapturingLogger(): { logger: Logger; warns: CapturedLog[]; infos: CapturedLog[] } {
  const warns: CapturedLog[] = [];
  const infos: CapturedLog[] = [];
  const logger = {
    info: (obj: Record<string, unknown>, msg?: string) => infos.push({ obj, msg }),
    warn: (obj: Record<string, unknown>, msg?: string) => warns.push({ obj, msg }),
    error: () => {},
    debug: () => {},
    child: () => logger,
  } as unknown as Logger;
  return { logger, warns, infos };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fresh object per call — the safety net MUTATES `result.implementResult` when
 * it synthesizes a partial, so a shared `mockResolvedValue` object would leak
 * the synthesis into the next increment's spawn result.
 */
function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 100, output: [] };
}

function makeSentinelResult(implementResult: Record<string, unknown>): PhaseResult {
  return {
    phase: 'implement',
    success: true,
    exitCode: 0,
    durationMs: 100,
    output: [],
    implementResult: implementResult as PhaseResult['implementResult'],
  };
}

/** The #2723 remainder: two "Manually verify …" tasks over a done story. */
function manualOnlyEval(): TasksMdEvaluation {
  return { kind: 'manual-only', unchecked: 2, manual: 2, checked: 27, total: 29 };
}

/** The #2714 remainder: a single `[manual]` browser-verification task. */
function markerManualOnlyEval(): TasksMdEvaluation {
  return { kind: 'manual-only', unchecked: 1, manual: 1, checked: 29, total: 30 };
}

function incompleteEval(automatable: number, manual: number, checked: number): TasksMdEvaluation {
  const unchecked = automatable + manual;
  return {
    kind: 'incomplete',
    unchecked,
    automatable,
    manual,
    checked,
    total: unchecked + checked,
  };
}

function completeEval(checked = 10): TasksMdEvaluation {
  return { kind: 'complete', unchecked: 0, checked, total: checked };
}

function createMockDeps(): PhaseLoopDeps {
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
      spawnPhase: vi.fn().mockImplementation(async () => makeSuccessResult('implement')),
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
  };
}

function createMockContext(labels: string[] = []): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 2723,
      workflowName: 'speckit-feature',
    } as any,
    startPhase: 'implement' as WorkflowPhase,
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      getFilesChangedByOwnCommits: vi
        .fn()
        .mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getIssueComments: vi.fn().mockResolvedValue([]),
      addIssueComment: vi.fn().mockResolvedValue(undefined),
      removeLabels: vi.fn().mockResolvedValue(undefined),
      getIssueLabels: vi.fn().mockResolvedValue(labels),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/test/repo/issues/2723',
    description: 'test',
  };
}

function createConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: "pnpm install && pnpm -r --filter './packages/*' build",
    gates: {},
    maxImplementRetries: 2,
    ...overrides,
  };
}

function gateCalls(deps: PhaseLoopDeps): Array<[string, string]> {
  return (deps.labelManager.onGateHit as any).mock.calls as Array<[string, string]>;
}

function errorStageComments(deps: PhaseLoopDeps): unknown[] {
  return (deps.stageCommentManager.updateStageComment as any).mock.calls.filter(
    (c: any[]) => c[0]?.status === 'error',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PhaseLoop — manual-validation pause (#1214)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  // -------------------------------------------------------------------------
  // T011 — label present suppresses synthesis (SC-001, SC-003, FR-004)
  // -------------------------------------------------------------------------
  it('label present + unchecked tasks → pauses on the gate without synthesizing a partial (SC-001)', async () => {
    const context = createMockContext([MANUAL_GATE]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    expect(result.lastPhase).toBe('implement');

    // No synthesized partial, so no implement re-entry.
    expect(result.results[0]!.implementResult).toBeUndefined();
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(1);

    // Exactly one commit — the pause path is the phase's only commit path.
    expect(deps.prManager.commitPushAndEnsurePr).toHaveBeenCalledTimes(1);
    expect(gateCalls(deps)).toContainEqual(['implement', MANUAL_GATE]);
  });

  it('manual-validation pause applies no failure labels and posts no failure alert (SC-003, FR-004)', async () => {
    const context = createMockContext([MANUAL_GATE]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());

    await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    // `failed:implement` / `failed:implement-repeated` / `agent:error` are all
    // routed through these two seams.
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect((deps.labelManager as any).onRepeatedError).not.toHaveBeenCalled();
    expect(deps.stageCommentManager.postFailureAlert).not.toHaveBeenCalled();
    expect(errorStageComments(deps)).toHaveLength(0);

    // The only gate applied is the manual-validation one.
    expect(gateCalls(deps)).toEqual([['implement', MANUAL_GATE]]);
  });

  // -------------------------------------------------------------------------
  // T012 — manual-only classification and the pause sequence
  // -------------------------------------------------------------------------
  it('label absent + manual-only evaluation → pauses instead of re-entering (SC-002, #2714 shape)', async () => {
    const context = createMockContext([]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(markerManualOnlyEval());

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    expect(result.completed).toBe(false);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(1);
    expect(result.results[0]!.implementResult).toBeUndefined();
    expect(gateCalls(deps)).toContainEqual(['implement', MANUAL_GATE]);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
  });

  it('grants completed:implement BEFORE hitting the gate (Q1=A — what makes resumeFrom:validate resolvable)', async () => {
    const context = createMockContext([]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());

    const order: string[] = [];
    (deps.labelManager.onPhaseComplete as any).mockImplementation(async (phase: string) => {
      order.push(`onPhaseComplete:${phase}`);
    });
    (deps.labelManager.onGateHit as any).mockImplementation(async (phase: string, label: string) => {
      order.push(`onGateHit:${phase}:${label}`);
    });

    await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(order).toEqual([
      'onPhaseComplete:implement',
      `onGateHit:implement:${MANUAL_GATE}`,
    ]);
  });

  it('pushRefused at the pause commit → aborts with gateHit false and zero label mutations (#1051)', async () => {
    const context = createMockContext([]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({
      pushRefused: 'pre-push guard: protected branch',
    });

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(false);
    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('implement');
    expect(deps.labelManager.onPhaseComplete).not.toHaveBeenCalled();
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // T013 — precedence and mixed remainders
  // -------------------------------------------------------------------------
  it('mixed remainder with no label → re-enters counting only the automatable tasks (SC-006, FR-008)', async () => {
    const context = createMockContext([]);
    (deps.evaluateTasksMd as any) = vi
      .fn()
      .mockReturnValueOnce(incompleteEval(3, 2, 5))
      .mockReturnValueOnce(completeEval(10));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
    // 5 unchecked, 2 of them manual → the synthesized remainder is 3, not 5.
    expect(result.results[0]!.implementResult).toMatchObject({
      partial: true,
      tasks_remaining: 3,
      tasks_completed: 5,
      tasks_total: 10,
    });
    expect(gateCalls(deps)).toHaveLength(0);
  });

  it('purely automatable remainder with no label → re-entry identical to #1187 (SC-007 companion)', async () => {
    const context = createMockContext([]);
    (deps.evaluateTasksMd as any) = vi
      .fn()
      .mockReturnValueOnce(incompleteEval(5, 0, 5))
      .mockReturnValueOnce(completeEval(10));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(result.results[0]!.implementResult).toMatchObject({ tasks_remaining: 5 });
    expect(gateCalls(deps)).toHaveLength(0);
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('implement');
  });

  it('label present + automatable tasks remaining → pauses anyway and warns about the divergence (Q4=A)', async () => {
    const { logger, warns } = createCapturingLogger();
    const loop = new PhaseLoop(logger);
    const context = createMockContext([MANUAL_GATE]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(incompleteEval(3, 1, 6));

    const result = await loop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    expect(result.results[0]!.implementResult).toBeUndefined();
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(1);

    const divergence = warns.find(
      (w) => w.obj.reason === 'manual-validation-label-present',
    );
    expect(divergence).toBeDefined();
    expect(divergence!.obj).toMatchObject({
      phase: 'implement',
      issueNumber: 2723,
      unchecked: 4,
      automatable: 3,
      manual: 1,
      checked: 6,
      total: 10,
    });
  });

  it('getIssueLabels rejecting → warns and follows the label-absent rows (manual-only → pause)', async () => {
    const { logger, warns } = createCapturingLogger();
    const loop = new PhaseLoop(logger);
    const context = createMockContext([]);
    context.github.getIssueLabels = vi.fn().mockRejectedValue(new Error('403 rate limited'));
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());

    const result = await loop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(warns.some((w) => w.msg?.includes('falling back to tasks.md classification'))).toBe(
      true,
    );
    expect(result.gateHit).toBe(true);
    expect(gateCalls(deps)).toContainEqual(['implement', MANUAL_GATE]);
  });

  it('getIssueLabels rejecting → incomplete evaluation still re-enters (fail-open, never fail-closed)', async () => {
    const context = createMockContext([]);
    context.github.getIssueLabels = vi.fn().mockRejectedValue(new Error('boom'));
    (deps.evaluateTasksMd as any) = vi
      .fn()
      .mockReturnValueOnce(incompleteEval(4, 0, 6))
      .mockReturnValueOnce(completeEval(10));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
    expect(gateCalls(deps)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T014 — no-progress guard (sentinel-present manual remainder)
  // -------------------------------------------------------------------------
  it('no-progress guard + manual-only remainder → pauses instead of failing (FR-009)', async () => {
    const context = createMockContext([]);
    // Sentinel present on both increments with an unchanged remainder — the
    // safety-net block never runs, so only the guard can catch this.
    (deps.cliSpawner.spawnPhase as any).mockImplementation(async () =>
      makeSentinelResult({ partial: true, tasks_completed: 27, tasks_remaining: 2, tasks_total: 29 }),
    );
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    expect(result.completed).toBe(false);
    expect(gateCalls(deps)).toContainEqual(['implement', MANUAL_GATE]);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect(deps.stageCommentManager.postFailureAlert).not.toHaveBeenCalled();
    expect(errorStageComments(deps)).toHaveLength(0);
  });

  // PR #1215 review Finding 4: the label alone must NOT rescue a no-progress
  // guard failure — a stale label is not stripped on `process:` requeue, so
  // corroborating tasks.md manual remainder is required.
  it('no-progress guard + manual-validation label (corroborated) → pauses instead of failing (FR-009)', async () => {
    const context = createMockContext([MANUAL_GATE]);
    (deps.cliSpawner.spawnPhase as any).mockImplementation(async () =>
      makeSentinelResult({ partial: true, tasks_completed: 5, tasks_remaining: 5, tasks_total: 10 }),
    );
    // Label present AND tasks.md carries a manual remainder → corroborated
    // pause. `incompleteEval(3, 2, 5)`: 3 automatable, 2 manual.
    deps.evaluateTasksMd = vi.fn().mockReturnValue(incompleteEval(3, 2, 5));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    expect(gateCalls(deps)).toContainEqual(['implement', MANUAL_GATE]);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect(errorStageComments(deps)).toHaveLength(0);
  });

  // PR #1215 review Finding 4: label without corroboration is treated as stale.
  it('no-progress guard + stale manual-validation label + no manual work → fails (Finding 4)', async () => {
    const { logger, warns } = createCapturingLogger();
    const loop = new PhaseLoop(logger);
    const context = createMockContext([MANUAL_GATE]);
    (deps.cliSpawner.spawnPhase as any).mockImplementation(async () =>
      makeSentinelResult({ partial: true, tasks_completed: 5, tasks_remaining: 5, tasks_total: 10 }),
    );
    // Label present but tasks.md has no manual work → label is treated as stale.
    deps.evaluateTasksMd = vi.fn().mockReturnValue(incompleteEval(5, 0, 5));

    const result = await loop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(false);
    expect(result.completed).toBe(false);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    expect(warns.some((w) => w.obj.reason === 'manual-validation-label-stale')).toBe(true);
  });

  it('no-progress guard + automatable remainder → fails exactly as before (FR-010)', async () => {
    const context = createMockContext([]);
    (deps.cliSpawner.spawnPhase as any).mockImplementation(async () =>
      makeSentinelResult({ partial: true, tasks_completed: 5, tasks_remaining: 5, tasks_total: 10 }),
    );
    deps.evaluateTasksMd = vi.fn().mockReturnValue(incompleteEval(5, 0, 5));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(false);
    expect(gateCalls(deps)).toHaveLength(0);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    expect(deps.stageCommentManager.postFailureAlert).toHaveBeenCalled();
    expect(errorStageComments(deps)).toHaveLength(1);

    const failed = result.results[result.results.length - 1]!;
    expect(failed.success).toBe(false);
    expect(failed.error).toMatchObject({
      message: 'Implement increment made no progress — aborting to prevent infinite loop',
      output: 'no progress: tasks_remaining stayed at 5 across two increments',
      phase: 'implement',
    });
  });

  // -------------------------------------------------------------------------
  // T015 — the sentinel path advances normally (SC-007)
  //
  // PR #1215 review Finding 2: the sentinel path now consults tasks.md in the
  // no-progress guard to normalize `tasks_remaining` to automatable-only
  // (the sentinel emits the full unchecked count, the safety-net synthesizes
  // automatable-only — comparing the two units caused false-fails). The SC-007
  // invariant is preserved as "sentinel path advances the same as pre-#1214":
  // the manual-only safety-net pause is never triggered by the sentinel path.
  // -------------------------------------------------------------------------
  it('sentinel-derived implementResult advances normally without triggering the manual-only pause (SC-007)', async () => {
    const context = createMockContext([MANUAL_GATE]);
    (deps.cliSpawner.spawnPhase as any)
      .mockImplementationOnce(async () =>
        makeSentinelResult({
          partial: true,
          tasks_completed: 5,
          tasks_remaining: 5,
          tasks_total: 10,
        }),
      )
      .mockImplementationOnce(async () =>
        makeSentinelResult({
          partial: false,
          tasks_completed: 10,
          tasks_remaining: 0,
          tasks_total: 10,
        }),
      );
    // Tasks.md eval used only for Finding 2 normalization in the guard block.
    // First increment shows progress (automatable=3), second is not partial so
    // the guard block doesn't run. `getIssueLabels` is not consulted because
    // the safety-net block never runs (sentinel present).
    (deps.evaluateTasksMd as any) = vi
      .fn()
      .mockReturnValueOnce(incompleteEval(3, 0, 7))
      .mockReturnValueOnce(completeEval(10));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
    // Label read (from the safety-net block) is not consulted while a sentinel
    // is driving the increments — even with the gate label present.
    expect(context.github.getIssueLabels).not.toHaveBeenCalled();
    expect(gateCalls(deps)).toHaveLength(0);
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('implement');
  });

  // -------------------------------------------------------------------------
  // PR #1215 review Finding 1: gate override
  // -------------------------------------------------------------------------
  it('unsatisfied implement-phase gate (always) → pauses on that gate instead of manual-validation (Finding 1)', async () => {
    const context = createMockContext([]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());
    (deps.gateChecker.checkGates as any).mockReturnValue([
      { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' },
    ]);

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    expect(result.completed).toBe(false);
    // The implementation-review gate was applied, not manual-validation.
    expect(gateCalls(deps)).toEqual([['implement', 'waiting-for:implementation-review']]);
    // completed:implement is still granted (the phase completed automatable work).
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('implement');
  });

  it('satisfied implement-phase gate (completed label present) → falls through to manual-validation (Finding 1)', async () => {
    const context = createMockContext(['completed:implementation-review', MANUAL_GATE]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());
    (deps.gateChecker.checkGates as any).mockReturnValue([
      { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' },
    ]);

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    // implementation-review is already satisfied; apply manual-validation.
    expect(gateCalls(deps)).toEqual([['implement', MANUAL_GATE]]);
  });

  // -------------------------------------------------------------------------
  // PR #1215 review Finding 3: job:paused + stage comment on pause
  // -------------------------------------------------------------------------
  it('manual-validation pause emits job:paused and refreshes the stage comment (Finding 3)', async () => {
    const jobEvents: Array<[string, any]> = [];
    const context = createMockContext([]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());
    deps.jobEventEmitter = ((event: string, payload: any) => {
      jobEvents.push([event, payload]);
    }) as any;
    (context as any).jobId = 'job-abc';

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    const pausedEvent = jobEvents.find(([e]) => e === 'job:paused');
    expect(pausedEvent).toBeDefined();
    expect(pausedEvent![1]).toMatchObject({
      jobId: 'job-abc',
      status: 'paused',
      currentStep: 'implement',
      gateLabel: MANUAL_GATE,
    });

    // The stage comment was refreshed with the pause snapshot (status: in_progress,
    // implement marked complete in the phases array).
    const stageCalls = (deps.stageCommentManager.updateStageComment as any).mock.calls;
    const pauseSnapshot = stageCalls[stageCalls.length - 1][0];
    expect(pauseSnapshot.status).toBe('in_progress');
    expect(
      pauseSnapshot.phases.find((p: any) => p.phase === 'implement')?.status,
    ).toBe('complete');
  });

  // PR #1215 review Finding 2: the false-fail scenario the reviewer flagged.
  // safety-net first (synthesizes automatable=7 → lastTasksRemaining=7),
  // sentinel second reports tasks_remaining=8 (10 unchecked − 2 done, manual
  // included). Pre-fix this false-failed as `8 >= 7`. Post-fix the guard reads
  // tasks.md and compares automatable-only (5 < 7 → continues normally).
  it('mixed synthesized-then-sentinel remainder: guard normalizes to automatable-only (Finding 2)', async () => {
    const context = createMockContext([]);
    // Three implement runs: (1) no sentinel → safety-net synthesizes,
    // (2) sentinel partial with unchecked count including manual,
    // (3) sentinel non-partial → advance.
    (deps.cliSpawner.spawnPhase as any)
      .mockImplementationOnce(async () => makeSuccessResult('implement'))
      .mockImplementationOnce(async () =>
        makeSentinelResult({ partial: true, tasks_completed: 2, tasks_remaining: 8, tasks_total: 10 }),
      )
      .mockImplementationOnce(async () =>
        makeSentinelResult({ partial: false, tasks_completed: 10, tasks_remaining: 0, tasks_total: 10 }),
      );
    // Increment 1: safety-net evaluates once (7 automatable, 3 manual) and the
    // guard block reuses that result. Increment 2: guard evaluates once
    // (5 automatable, 3 manual). Increment 3: sentinel partial=false → guard
    // block skipped, no eval call.
    (deps.evaluateTasksMd as any) = vi
      .fn()
      .mockReturnValueOnce(incompleteEval(7, 3, 0))
      .mockReturnValueOnce(incompleteEval(5, 3, 2));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    // Progress observed (automatable dropped 7→5) → guard does not fire,
    // workflow completes.
    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect(gateCalls(deps)).toHaveLength(0);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(3);
  });
});
