import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import { GateChecker } from '../gate-checker.js';
import type { TasksMdEvaluation } from '../tasks-md-fallback.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { WorkerConfigSchema, type WorkerConfig } from '../config.js';

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

  // Q4=A: the label wins UNCONDITIONALLY — no tasks.md corroboration. The
  // remainder here reports 5 automatable / 0 manual tasks, i.e. the exact shape
  // a corroboration rule would reject, and it must still pause.
  it('no-progress guard + manual-validation label → pauses instead of failing (FR-009)', async () => {
    const context = createMockContext([MANUAL_GATE]);
    (deps.cliSpawner.spawnPhase as any).mockImplementation(async () =>
      makeSentinelResult({ partial: true, tasks_completed: 5, tasks_remaining: 5, tasks_total: 10 }),
    );
    // Label wins even though the remainder still reports automatable work.
    deps.evaluateTasksMd = vi.fn().mockReturnValue(incompleteEval(5, 0, 5));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    expect(gateCalls(deps)).toContainEqual(['implement', MANUAL_GATE]);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect(errorStageComments(deps)).toHaveLength(0);
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
  // T015 — the sentinel path is untouched (SC-007)
  // -------------------------------------------------------------------------
  it('sentinel-derived implementResult never reaches the manual check (SC-007)', async () => {
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
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
    // Neither the fallback evaluator nor the label read is consulted while a
    // sentinel is driving the increments — even with the gate label present.
    expect(deps.evaluateTasksMd).not.toHaveBeenCalled();
    expect(context.github.getIssueLabels).not.toHaveBeenCalled();
    expect(gateCalls(deps)).toHaveLength(0);
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('implement');
  });

  // -------------------------------------------------------------------------
  // PR #1215 review Finding 1 (BLOCKER-3): implement's own gates are applied IN
  // ADDITION to manual-validation, never INSTEAD of it. Substituting drops the
  // whole point of the feature (FR-003, US1, SC-001/SC-002): nothing on the
  // issue would say manual work is pending and the reviewer would approve a
  // story with an unchecked manual task.
  // -------------------------------------------------------------------------
  it('unsatisfied implement-phase gate (always) → applies BOTH that gate and manual-validation (Finding 1)', async () => {
    const context = createMockContext([]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());
    (deps.gateChecker.checkGates as any).mockReturnValue([
      { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' },
    ]);

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    expect(result.completed).toBe(false);
    // Q1=A ordering: completed:implement, then manual-validation, then the
    // co-applied implement gate.
    expect(gateCalls(deps)).toEqual([
      ['implement', MANUAL_GATE],
      ['implement', 'waiting-for:implementation-review'],
    ]);
    // completed:implement is still granted (the phase completed automatable work).
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('implement');
    // The reported gate stays manual-validation — it is the reason for the pause.
    expect(result.results[0]!.gateHit?.gateLabel).toBe(MANUAL_GATE);
  });

  it('satisfied implement-phase gate (completed label present) → only manual-validation is applied (Finding 1)', async () => {
    const context = createMockContext(['completed:implementation-review', MANUAL_GATE]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());
    (deps.gateChecker.checkGates as any).mockReturnValue([
      { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' },
    ]);

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    // implementation-review is already satisfied; only manual-validation lands.
    expect(gateCalls(deps)).toEqual([['implement', MANUAL_GATE]]);
  });

  it('unsatisfied on-sibling-review gate → flips siblings ready and co-applies the gate (Finding 1a)', async () => {
    const context = createMockContext([]);
    // An unparseable PR url short-circuits `checkSiblingReviews` to
    // "not approved" WITHOUT shelling out to `gh` — enough to activate the gate.
    (context as any).linkedPRs = [{ url: 'not-a-pr-url', repo: 'sibling', number: 7 }];
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());
    (deps.gateChecker.checkGates as any).mockReturnValue([
      { phase: 'implement', gateLabel: 'waiting-for:sibling-review', condition: 'on-sibling-review' },
    ]);
    (deps.prManager as any).markSiblingsReadyForReview = vi.fn().mockResolvedValue(undefined);

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    expect(gateCalls(deps)).toEqual([
      ['implement', MANUAL_GATE],
      ['implement', 'waiting-for:sibling-review'],
    ]);
    // Same side-effect the normal gate loop performs — otherwise a multi-repo
    // story never flips its sibling PRs ready for review.
    expect((deps.prManager as any).markSiblingsReadyForReview).toHaveBeenCalledWith(
      (context as any).linkedPRs,
    );
  });

  it('on-merge-conflict implement gate is NOT raised at this seam (matches the gate loop)', async () => {
    const context = createMockContext([]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());
    (deps.gateChecker.checkGates as any).mockReturnValue([
      { phase: 'implement', gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' },
    ]);

    await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(gateCalls(deps)).toEqual([['implement', MANUAL_GATE]]);
  });

  // ITEM-7: pin the CONTRACT against the real default speckit-feature config
  // rather than a hand-fed gate list — this is the configuration the reviewer
  // said drops `waiting-for:manual-validation` today.
  it('default speckit-feature config (flag-OFF) still applies waiting-for:manual-validation (ITEM-7)', async () => {
    const context = createMockContext([]);
    deps.evaluateTasksMd = vi.fn().mockReturnValue(manualOnlyEval());
    // Real GateChecker over the real default gates — no mocking of either.
    deps.gateChecker = new GateChecker(mockLogger);
    const realConfig = WorkerConfigSchema.parse({ workspaceDir: '/tmp' });
    expect(realConfig.ciMergeGateEnabled).toBe(false);

    const result = await phaseLoop.executeLoop(context, realConfig, deps, ['implement']);

    expect(result.gateHit).toBe(true);
    const applied = gateCalls(deps).map(([, label]) => label);
    expect(applied).toContain(MANUAL_GATE);
    expect(applied).toContain('waiting-for:implementation-review');
    // `on-merge-conflict` is driven by the base-merge seam, never here.
    expect(applied).not.toContain('waiting-for:merge-conflicts');
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

  // -------------------------------------------------------------------------
  // PR #1215 review Finding 2 (BLOCKER-2): the guard must compare like with
  // like. The sentinel reports the FULL unchecked count; the safety net
  // synthesizes AUTOMATABLE-only. Mixing the two units false-fails a
  // progressing run. The fix tracks the unit and resets the baseline across a
  // unit change — it does NOT re-derive the sentinel's count from tasks.md,
  // because the sentinel path must not consult the fallback source (SC-007).
  // -------------------------------------------------------------------------
  it('synthesized-then-sentinel remainder: unit change resets the baseline instead of false-failing (Finding 2)', async () => {
    const context = createMockContext([]);
    // Three implement runs: (1) no sentinel → safety-net synthesizes
    // automatable=7, (2) sentinel partial reporting 8 unchecked (10 − 2 done,
    // manual included), (3) sentinel non-partial → advance.
    (deps.cliSpawner.spawnPhase as any)
      .mockImplementationOnce(async () => makeSuccessResult('implement'))
      .mockImplementationOnce(async () =>
        makeSentinelResult({ partial: true, tasks_completed: 2, tasks_remaining: 8, tasks_total: 10 }),
      )
      .mockImplementationOnce(async () =>
        makeSentinelResult({ partial: false, tasks_completed: 10, tasks_remaining: 0, tasks_total: 10 }),
      );
    deps.evaluateTasksMd = vi.fn().mockReturnValue(incompleteEval(7, 3, 0));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    // Pre-fix this false-failed as `8 >= 7` across two different units.
    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect(gateCalls(deps)).toHaveLength(0);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(3);
  });

  it('a sentinel that stalls after a unit change still escalates on the next same-unit pair (Finding 2)', async () => {
    const context = createMockContext([]);
    // (1) safety net synthesizes automatable=7 → baseline 7 (automatable).
    // (2) sentinel 8 → unit change → baseline RESET to 8 (sentinel), no compare.
    // (3) sentinel 8 again → same unit, 8 >= 8 → guard escalates.
    (deps.cliSpawner.spawnPhase as any)
      .mockImplementationOnce(async () => makeSuccessResult('implement'))
      .mockImplementation(async () =>
        makeSentinelResult({ partial: true, tasks_completed: 2, tasks_remaining: 8, tasks_total: 10 }),
      );
    deps.evaluateTasksMd = vi.fn().mockReturnValue(incompleteEval(7, 3, 0));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.completed).toBe(false);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(3);
  });

  it('the sentinel path never re-derives tasks_remaining from tasks.md (SC-007, Finding 2 regression)', async () => {
    const context = createMockContext([]);
    // The scenario the previous fix broke: the agent makes real progress
    // (20 → 10) while tasks.md still shows 30 unchecked. Normalizing through
    // tasks.md would compare 30 >= 30 and fail a progressing run.
    (deps.cliSpawner.spawnPhase as any)
      .mockImplementationOnce(async () =>
        makeSentinelResult({ partial: true, tasks_completed: 10, tasks_remaining: 20, tasks_total: 30 }),
      )
      .mockImplementationOnce(async () =>
        makeSentinelResult({ partial: true, tasks_completed: 20, tasks_remaining: 10, tasks_total: 30 }),
      )
      .mockImplementationOnce(async () =>
        makeSentinelResult({ partial: false, tasks_completed: 30, tasks_remaining: 0, tasks_total: 30 }),
      );
    deps.evaluateTasksMd = vi.fn().mockReturnValue(incompleteEval(30, 0, 0));

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect(deps.evaluateTasksMd).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ITEM-7 — the FIELD case, end to end through the REAL tasks.md evaluator.
//
// Painworth/ai-lawfirm#2723's actual remainder. Neither line carries a
// `[manual]` marker nor an in-window keyword, so the classifier reports
// `incomplete` with `manual: 0` — exactly the shape that a "the label needs
// tasks.md corroboration" rule discards, re-entering implement and landing
// `failed:implement` + `failed:implement-repeated` on a complete, green story.
// This test deliberately does NOT stub `deps.evaluateTasksMd`: the real
// evaluator reads a real tasks.md off disk, so the assertion pins the contract
// (the agent's gate label is authoritative) and not the implementation.
// ---------------------------------------------------------------------------

/** VERBATIM from Painworth/ai-lawfirm#2723 — do not paraphrase. */
const ISSUE_2723_TASKS_MD = [
  '## Phase 3.5: Validation',
  '',
  '- [x] T026 Wire the emulator harness',
  '- [x] T027 Unit-test the policy resolver',
  '- [ ] T028 Browser-verify per repo policy (quickstart.md §Emulator): ...',
  '- [ ] T029 Berman-deploy checklist for SC-002 (deferred per house practice — emulator cannot place LiveKit calls)',
  '',
].join('\n');

describe('PhaseLoop — #2723 field case through the real evaluator (#1214, ITEM-7)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-loop-1214-'));
    const specDir = path.join(checkoutPath, 'specs', '2723-livekit-emulator-policy');
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(path.join(specDir, 'tasks.md'), ISSUE_2723_TASKS_MD, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
  });

  it('unkeyworded, unmarked manual remainder + gate label → pauses, never re-enters (Q4=A)', async () => {
    const context = createMockContext([MANUAL_GATE]);
    context.checkoutPath = checkoutPath;
    // No `deps.evaluateTasksMd` stub — the real FS-backed evaluator runs.

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    expect(result.gateHit).toBe(true);
    expect(result.completed).toBe(false);
    // The bug being fixed: a second implement invocation.
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(1);
    expect(result.results[0]!.implementResult).toBeUndefined();
    expect(gateCalls(deps)).toContainEqual(['implement', MANUAL_GATE]);
    // Not a failure (FR-004).
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect((deps.labelManager as any).onRepeatedError).not.toHaveBeenCalled();
    expect(deps.stageCommentManager.postFailureAlert).not.toHaveBeenCalled();
    expect(errorStageComments(deps)).toHaveLength(0);
  });

  it('the same remainder WITHOUT the gate label re-enters (the label is what makes it pause)', async () => {
    const context = createMockContext([]);
    context.checkoutPath = checkoutPath;
    (deps.cliSpawner.spawnPhase as any).mockImplementation(async () =>
      makeSuccessResult('implement'),
    );

    const result = await phaseLoop.executeLoop(context, createConfig(), deps, ['implement']);

    // tasks.md classifies both remaining tasks as AUTOMATABLE (manual: 0), so
    // without the label the engine legitimately re-enters — which is precisely
    // why the label has to be authoritative.
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
    expect(result.results[0]!.implementResult).toMatchObject({
      partial: true,
      tasks_remaining: 2,
      tasks_completed: 2,
      tasks_total: 4,
    });
  });
});
