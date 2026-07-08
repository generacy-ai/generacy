import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase, PhaseAfterContext } from '../types.js';
import type { WorkerConfig } from '../config.js';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return {
    phase,
    success: true,
    exitCode: 0,
    durationMs: 100,
    output: [],
  };
}

function makeFailResult(phase: WorkflowPhase): PhaseResult {
  return {
    phase,
    success: false,
    exitCode: 1,
    durationMs: 50,
    output: [],
    error: { message: `${phase} failed`, stderr: '', phase },
  };
}

function createMockDeps(): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      onGateHit: vi.fn().mockResolvedValue(undefined),
    } as any,
    stageCommentManager: {
      updateStageComment: vi.fn().mockResolvedValue(undefined),
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
  };
}

function createMockContext(startPhase: WorkflowPhase = 'validate'): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 329,
      workflowName: 'speckit-feature',
    } as any,
    startPhase,
    // Default github mocks satisfy the implement product-diff check with a
    // non-spec (product) file. Individual tests may override.
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/test/repo/issues/329',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PhaseLoop - pre-validate install', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('runs pre-validate install before validate when preValidateCommand is set', async () => {
    const context = createMockContext('validate');
    const config = createConfig({ preValidateCommand: 'pnpm install' });

    const callOrder: string[] = [];
    (deps.cliSpawner.runPreValidateInstall as any).mockImplementation(async () => {
      callOrder.push('install');
      return makeSuccessResult('validate');
    });
    (deps.cliSpawner.runValidatePhase as any).mockImplementation(async () => {
      callOrder.push('validate');
      return makeSuccessResult('validate');
    });

    await phaseLoop.executeLoop(context, config, deps, ['validate']);

    expect(callOrder).toEqual(['install', 'validate']);
    expect(deps.cliSpawner.runPreValidateInstall).toHaveBeenCalledWith(
      '/tmp/repo',
      'pnpm install',
      context.signal,
    );
  });

  it('skips pre-validate install when preValidateCommand is empty string', async () => {
    const context = createMockContext('validate');
    const config = createConfig({ preValidateCommand: '' });

    await phaseLoop.executeLoop(context, config, deps, ['validate']);

    expect(deps.cliSpawner.runPreValidateInstall).not.toHaveBeenCalled();
    expect(deps.cliSpawner.runValidatePhase).toHaveBeenCalled();
  });

  it('stops phase loop when install fails (does not run validate)', async () => {
    const context = createMockContext('validate');
    const config = createConfig({ preValidateCommand: 'pnpm install' });

    (deps.cliSpawner.runPreValidateInstall as any).mockResolvedValue(makeFailResult('validate'));

    const result = await phaseLoop.executeLoop(context, config, deps, ['validate']);

    expect(result.completed).toBe(false);
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
    expect(deps.labelManager.onError).toHaveBeenCalledWith('validate');
  });
});

describe('PhaseLoop - implement retry logic', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('retries implement phase when it fails with hasChanges=true', async () => {
    const context = createMockContext('implement');
    const config = createConfig({ maxImplementRetries: 2 });

    // Fail once, then succeed
    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makeFailResult('implement'))
      .mockResolvedValueOnce(makeSuccessResult('implement'));

    // First call (retry commit): hasChanges=true; second call (success commit): hasChanges=true
    (deps.prManager.commitPushAndEnsurePr as any)
      .mockResolvedValueOnce({ prUrl: null, hasChanges: true })
      .mockResolvedValueOnce({ prUrl: null, hasChanges: true });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('implement');
  });

  it('falls through to error path immediately when implement fails with hasChanges=false', async () => {
    const context = createMockContext('implement');
    const config = createConfig({ maxImplementRetries: 2 });

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeFailResult('implement'));
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: false });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    expect(result.completed).toBe(false);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(1);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
  });

  it('stops retrying when maxImplementRetries is exhausted', async () => {
    const context = createMockContext('implement');
    const config = createConfig({ maxImplementRetries: 1 });

    // Always fails
    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeFailResult('implement'));
    // Always has changes (so retry is eligible each time)
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: true });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    expect(result.completed).toBe(false);
    // 1 initial attempt + 1 retry = 2 total
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
  });

  it('does NOT retry non-implement phases on failure', async () => {
    const context = createMockContext('clarify');
    const config = createConfig({ maxImplementRetries: 2 });

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeFailResult('clarify'));

    const result = await phaseLoop.executeLoop(context, config, deps, ['clarify']);

    expect(result.completed).toBe(false);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(1);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('clarify');
  });

  it('calls updateStageComment with status in_progress on retry', async () => {
    const context = createMockContext('implement');
    const config = createConfig({ maxImplementRetries: 2 });

    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makeFailResult('implement'))
      .mockResolvedValueOnce(makeSuccessResult('implement'));

    (deps.prManager.commitPushAndEnsurePr as any)
      .mockResolvedValueOnce({ prUrl: null, hasChanges: true })
      .mockResolvedValueOnce({ prUrl: null, hasChanges: true });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    const calls = (deps.stageCommentManager.updateStageComment as any).mock.calls;
    const retryCall = calls.find((c: any[]) => c[0].status === 'in_progress' && c[0].phases?.some((p: any) => p.phase === 'implement' && p.status === 'in_progress'));
    expect(retryCall).toBeDefined();
  });

  it('preserves phaseTimestamps startedAt across retries', async () => {
    const context = createMockContext('implement');
    const config = createConfig({ maxImplementRetries: 2 });

    const capturedStartedAts: string[] = [];

    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makeFailResult('implement'))
      .mockResolvedValueOnce(makeSuccessResult('implement'));

    (deps.prManager.commitPushAndEnsurePr as any)
      .mockResolvedValueOnce({ prUrl: null, hasChanges: true })
      .mockImplementationOnce(async () => {
        // On second call (success), capture startedAt from stage comment calls
        return { prUrl: null, hasChanges: true };
      });

    // Capture startedAt values from all stage comment updates
    (deps.stageCommentManager.updateStageComment as any).mockImplementation(async (data: any) => {
      if (data.startedAt) capturedStartedAts.push(data.startedAt);
    });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    // All calls should use the same startedAt (the first one recorded)
    const uniqueStartedAts = new Set(capturedStartedAts);
    expect(uniqueStartedAts.size).toBe(1);
  });

  it('does not trigger partial re-invocation when implement succeeds without implementResult', async () => {
    const context = createMockContext('implement');
    const config = createConfig();

    // Standard success with no implementResult (no sentinel parsed)
    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('implement'));
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: true });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(1);
  });

  it('implementRetryCount resets per executeLoop call', async () => {
    const context = createMockContext('implement');
    const config = createConfig({ maxImplementRetries: 1 });

    // First run: fail once, then succeed
    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makeFailResult('implement'))
      .mockResolvedValueOnce(makeSuccessResult('implement'));

    (deps.prManager.commitPushAndEnsurePr as any)
      .mockResolvedValueOnce({ prUrl: null, hasChanges: true })
      .mockResolvedValueOnce({ prUrl: null, hasChanges: true });

    const result1 = await phaseLoop.executeLoop(context, config, deps, ['implement']);
    expect(result1.completed).toBe(true);

    // Reset mocks for second run
    vi.clearAllMocks();
    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makeFailResult('implement'))
      .mockResolvedValueOnce(makeSuccessResult('implement'));

    (deps.prManager.commitPushAndEnsurePr as any)
      .mockResolvedValueOnce({ prUrl: null, hasChanges: true })
      .mockResolvedValueOnce({ prUrl: null, hasChanges: true });

    // Second run should also be able to retry (counter reset)
    const result2 = await phaseLoop.executeLoop(context, config, deps, ['implement']);
    expect(result2.completed).toBe(true);
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Implement increment / partial re-invocation
// ---------------------------------------------------------------------------

/** Build a PhaseResult with a partial implementResult (sentinel parsed). */
function makePartialResult(tasksCompleted: number, tasksRemaining: number): PhaseResult {
  return {
    phase: 'implement',
    success: true,
    exitCode: 0,
    durationMs: 100,
    output: [],
    implementResult: {
      partial: true,
      tasks_completed: tasksCompleted,
      tasks_remaining: tasksRemaining,
      tasks_total: tasksCompleted + tasksRemaining,
    },
  };
}

describe('PhaseLoop - implement partial re-invocation', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('re-invokes implement with a fresh session when partial result is received', async () => {
    const context = createMockContext('implement');
    const config = createConfig();

    // First call: partial (8 done, 5 remaining). Second: full success.
    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makePartialResult(8, 5))
      .mockResolvedValueOnce(makeSuccessResult('implement'));

    (deps.prManager.commitPushAndEnsurePr as any)
      .mockResolvedValue({ prUrl: 'https://github.com/pr/1', hasChanges: true });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    expect(result.completed).toBe(true);
    // Should have been called twice (once partial, once complete)
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
    // commitPushAndEnsurePr should be called for the partial increment and then for the final
    expect(deps.prManager.commitPushAndEnsurePr).toHaveBeenCalledTimes(2);
  });

  it('clears session ID between increments so next call gets a fresh session', async () => {
    const context = createMockContext('implement');
    const config = createConfig();

    const capturedSessionIds: (string | undefined)[] = [];

    (deps.cliSpawner.spawnPhase as any).mockImplementation(
      async (_phase: WorkflowPhase, options: { resumeSessionId?: string }) => {
        capturedSessionIds.push(options.resumeSessionId);
        // First call returns partial with a session ID; second returns success
        if (capturedSessionIds.length === 1) {
          return { ...makePartialResult(5, 5), sessionId: 'ses-increment-1' };
        }
        return makeSuccessResult('implement');
      },
    );

    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: true });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    // First call: no previous session (undefined)
    expect(capturedSessionIds[0]).toBeUndefined();
    // Second call: session should be cleared (undefined, not the old ses-increment-1)
    expect(capturedSessionIds[1]).toBeUndefined();
  });

  it('fails with error when no progress is made between increments (infinite loop guard)', async () => {
    const context = createMockContext('implement');
    const config = createConfig();

    // Both calls return the same tasks_remaining — no progress
    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makePartialResult(0, 10))  // 10 remaining
      .mockResolvedValueOnce(makePartialResult(0, 10)); // still 10 remaining — no progress

    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: true });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('implement');
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    // Should have been called at most twice (first partial OK, second triggers guard)
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledTimes(2);
  });

  it('posts a WIP commit message with task counts during partial re-invocation', async () => {
    const context = createMockContext('implement');
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makePartialResult(8, 5))
      .mockResolvedValueOnce(makeSuccessResult('implement'));

    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: true });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    const calls = (deps.prManager.commitPushAndEnsurePr as any).mock.calls;
    // First call should have the WIP partial message with task counts
    const wipCall = calls[0];
    expect(wipCall[1]?.message).toMatch(/wip\(speckit\)/);
    expect(wipCall[1]?.message).toMatch(/8 tasks done/);
    expect(wipCall[1]?.message).toMatch(/5 remaining/);
  });

  it('updates stage comment with in_progress status during partial increment', async () => {
    const context = createMockContext('implement');
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makePartialResult(5, 5))
      .mockResolvedValueOnce(makeSuccessResult('implement'));

    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: true });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    const calls = (deps.stageCommentManager.updateStageComment as any).mock.calls;
    // Should have at least one in_progress comment update during the partial phase
    const inProgressCall = calls.find((c: any[]) => c[0].status === 'in_progress');
    expect(inProgressCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Job lifecycle events
// ---------------------------------------------------------------------------

describe('PhaseLoop - job lifecycle events', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('emits job:phase_changed at the start of each phase', async () => {
    const context = { ...createMockContext('specify'), jobId: 'test-job-id' };
    const config = createConfig();

    deps.jobEventEmitter = vi.fn();

    // Both phases succeed via CLI spawner
    (deps.cliSpawner.spawnPhase as any)
      .mockResolvedValueOnce(makeSuccessResult('specify'))
      .mockResolvedValueOnce(makeSuccessResult('clarify'));

    await phaseLoop.executeLoop(context, config, deps, ['specify', 'clarify']);

    const emitter = deps.jobEventEmitter;
    // Should have been called at least twice (once per phase) with job:phase_changed
    const phaseChangedCalls = (emitter as any).mock.calls.filter(
      (c: any[]) => c[0] === 'job:phase_changed',
    );
    expect(phaseChangedCalls.length).toBe(2);

    // First call: specify
    expect(phaseChangedCalls[0][1]).toMatchObject({
      jobId: 'test-job-id',
      currentStep: 'specify',
      status: 'active',
    });

    // Second call: clarify
    expect(phaseChangedCalls[1][1]).toMatchObject({
      jobId: 'test-job-id',
      currentStep: 'clarify',
      status: 'active',
    });
  });

  it('emits job:paused when gate activates', async () => {
    const context = { ...createMockContext('clarify'), jobId: 'test-job-id' };
    context.github = {
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    } as any;
    const config = createConfig();

    deps.jobEventEmitter = vi.fn();

    // clarify phase succeeds
    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('clarify'));

    // Gate checker returns a gate for clarify
    (deps.gateChecker.checkGates as any).mockReturnValue([{
      phase: 'clarify',
      gateLabel: 'waiting-for:clarification',
      condition: 'always',
    }]);

    await phaseLoop.executeLoop(context, config, deps, ['clarify']);

    const emitter = deps.jobEventEmitter;
    const pausedCalls = (emitter as any).mock.calls.filter(
      (c: any[]) => c[0] === 'job:paused',
    );
    expect(pausedCalls.length).toBe(1);
    expect(pausedCalls[0][1]).toMatchObject({
      jobId: 'test-job-id',
      status: 'paused',
      gateLabel: 'waiting-for:clarification',
      currentStep: 'clarify',
    });
  });

  it('does not emit events when jobEventEmitter is not provided', async () => {
    const context = { ...createMockContext('specify'), jobId: 'test-job-id' };
    const config = createConfig();

    // Ensure no jobEventEmitter is set
    delete deps.jobEventEmitter;

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('specify'));

    // Should complete without errors
    const result = await phaseLoop.executeLoop(context, config, deps, ['specify']);

    expect(result.completed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sibling-repo prompt injection
// ---------------------------------------------------------------------------

describe('PhaseLoop - sibling workdir prompt injection', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('prepends sibling block to prompt when siblingWorkdirs is non-empty', async () => {
    const context = createMockContext('specify');
    context.siblingWorkdirs = {
      agency: '/workspaces/agency',
      'generacy-cloud': '/workspaces/generacy-cloud',
    };

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('specify'));

    await phaseLoop.executeLoop(context, createConfig(), deps, ['specify']);

    const spawnCall = (deps.cliSpawner.spawnPhase as any).mock.calls[0];
    const prompt: string = spawnCall[1].prompt;
    expect(prompt).toContain('**Sibling repos available in this workspace.**');
    expect(prompt).toContain('`agency` — `/workspaces/agency`');
    expect(prompt).toContain('`generacy-cloud` — `/workspaces/generacy-cloud`');
    expect(prompt).toContain(context.issueUrl);
  });

  it('passes original issueUrl when siblingWorkdirs is empty', async () => {
    const context = createMockContext('specify');
    context.siblingWorkdirs = {};

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('specify'));

    await phaseLoop.executeLoop(context, createConfig(), deps, ['specify']);

    const spawnCall = (deps.cliSpawner.spawnPhase as any).mock.calls[0];
    expect(spawnCall[1].prompt).toBe(context.issueUrl);
  });

  it('passes original issueUrl when siblingWorkdirs is absent', async () => {
    const context = createMockContext('specify');
    // siblingWorkdirs is undefined (not set)

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('specify'));

    await phaseLoop.executeLoop(context, createConfig(), deps, ['specify']);

    const spawnCall = (deps.cliSpawner.spawnPhase as any).mock.calls[0];
    expect(spawnCall[1].prompt).toBe(context.issueUrl);
  });
});

// ---------------------------------------------------------------------------
// phase:after handlers
// ---------------------------------------------------------------------------

describe('PhaseLoop - phaseAfterHandlers', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('invokes a no-op handler after commit/push and before gate check', async () => {
    const context = createMockContext('specify');
    const config = createConfig();
    const callOrder: string[] = [];

    (deps.labelManager.onPhaseComplete as any).mockImplementation(async () => {
      callOrder.push('onPhaseComplete');
    });

    const handler = vi.fn().mockImplementation(async () => {
      callOrder.push('handler');
    });

    (deps.gateChecker.checkGates as any).mockImplementation(() => {
      callOrder.push('checkGate');
      return [];
    });

    deps.phaseAfterHandlers = [handler];

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('specify'));
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: true });

    await phaseLoop.executeLoop(context, config, deps, ['specify']);

    expect(handler).toHaveBeenCalledTimes(1);
    // Verify ordering: onPhaseComplete → handler → checkGate
    expect(callOrder).toEqual(['onPhaseComplete', 'handler', 'checkGate']);

    // Verify handler receives correct context
    const handlerArg: PhaseAfterContext = handler.mock.calls[0][0];
    expect(handlerArg.phase).toBe('specify');
    expect(handlerArg.commitResult).toEqual({ prUrl: null, hasChanges: true });
    expect(handlerArg.checkoutPath).toBe(context.checkoutPath);
  });

  it('fails the phase when a handler throws (fail-fast, gate not checked)', async () => {
    const context = createMockContext('specify');
    const config = createConfig();

    const failingHandler = vi.fn().mockRejectedValue(new Error('handler-error'));
    const secondHandler = vi.fn();

    deps.phaseAfterHandlers = [failingHandler, secondHandler];

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('specify'));
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: true });

    await expect(
      phaseLoop.executeLoop(context, config, deps, ['specify']),
    ).rejects.toThrow('handler-error');

    expect(failingHandler).toHaveBeenCalledTimes(1);
    // Second handler should NOT have been called (fail-fast)
    expect(secondHandler).not.toHaveBeenCalled();
    // Gate should NOT have been checked
    expect(deps.gateChecker.checkGates).not.toHaveBeenCalled();
  });

  it('produces identical behavior when zero handlers are registered', async () => {
    const context = createMockContext('specify');
    const config = createConfig();

    deps.phaseAfterHandlers = [];

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('specify'));
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: true });

    const result = await phaseLoop.executeLoop(context, config, deps, ['specify']);

    expect(result.completed).toBe(true);
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('specify');
    expect(deps.gateChecker.checkGates).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure evidence threading (#847 Gap B / T008)
// ---------------------------------------------------------------------------

/** Locate the last stage-comment update call with status === 'error'. */
function findLastErrorCall(spy: any): any | undefined {
  const calls = spy.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0].status === 'error') return calls[i][0];
  }
  return undefined;
}

describe('PhaseLoop - errorEvidence threading (#847)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('threads errorEvidence into pre-validate install failure', async () => {
    const context = createMockContext('validate');
    const config = createConfig({ preValidateCommand: 'pnpm install' });

    const installResult: PhaseResult = {
      phase: 'validate',
      success: false,
      exitCode: 42,
      durationMs: 100,
      output: [],
      error: {
        message: 'Phase "validate" failed with exit code 42',
        stderr: 'ELIFECYCLE Command failed with exit code 42',
        phase: 'validate',
      },
    };
    (deps.cliSpawner.runPreValidateInstall as any).mockResolvedValue(installResult);

    await phaseLoop.executeLoop(context, config, deps, ['validate']);

    const errorCall = findLastErrorCall(deps.stageCommentManager.updateStageComment);
    expect(errorCall).toBeDefined();
    expect(errorCall.errorEvidence).toEqual({
      command: 'pnpm install',
      exitDescriptor: 'exit 42',
      stderrTail: 'ELIFECYCLE Command failed with exit code 42',
    });
  });

  it('threads errorEvidence for unexpected spawn error catch (synthetic PhaseResult)', async () => {
    const context = createMockContext('specify');
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any).mockRejectedValue(new Error('spawn ENOENT'));

    await expect(
      phaseLoop.executeLoop(context, config, deps, ['specify']),
    ).rejects.toThrow('spawn ENOENT');

    const errorCall = findLastErrorCall(deps.stageCommentManager.updateStageComment);
    expect(errorCall).toBeDefined();
    expect(errorCall.errorEvidence.command).toBe('specify');
    expect(errorCall.errorEvidence.exitDescriptor).toBe('exit 1');
    expect(errorCall.errorEvidence.stderrTail).toBe('(stderr empty)');
  });

  it('threads errorEvidence for a post-phase CLI failure (implement)', async () => {
    const context = createMockContext('implement');
    const config = createConfig({ maxImplementRetries: 0 });

    const failResult: PhaseResult = {
      phase: 'implement',
      success: false,
      exitCode: 3,
      durationMs: 50,
      output: [],
      error: {
        message: 'Phase "implement" failed with exit code 3',
        stderr: 'compilation failed\n  at line 5',
        phase: 'implement',
      },
    };
    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(failResult);
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: false });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    const errorCall = findLastErrorCall(deps.stageCommentManager.updateStageComment);
    expect(errorCall).toBeDefined();
    expect(errorCall.errorEvidence).toEqual({
      command: 'implement',
      exitDescriptor: 'exit 3',
      stderrTail: 'compilation failed\n  at line 5',
    });
  });

  it('threads errorEvidence for a post-phase validate failure (uses validateCommand)', async () => {
    const context = createMockContext('validate');
    const config = createConfig({
      preValidateCommand: '',
      validateCommand: 'npm test && npm run build',
    });

    const failResult: PhaseResult = {
      phase: 'validate',
      success: false,
      exitCode: 1,
      durationMs: 50,
      output: [],
      error: {
        message: 'Phase "validate" failed with exit code 1',
        stderr: 'Tests failed: 2 of 5',
        phase: 'validate',
      },
    };
    (deps.cliSpawner.runValidatePhase as any).mockResolvedValue(failResult);

    await phaseLoop.executeLoop(context, config, deps, ['validate']);

    const errorCall = findLastErrorCall(deps.stageCommentManager.updateStageComment);
    expect(errorCall).toBeDefined();
    expect(errorCall.errorEvidence).toEqual({
      command: 'npm test && npm run build',
      exitDescriptor: 'exit 1',
      stderrTail: 'Tests failed: 2 of 5',
    });
  });

  it('renders killed (SIGTERM) descriptor when error message signals a timeout', async () => {
    const context = createMockContext('specify');
    const config = createConfig({ phaseTimeoutMs: 900_000 });

    const failResult: PhaseResult = {
      phase: 'specify',
      success: false,
      exitCode: 1,
      durationMs: 900_000,
      output: [],
      error: {
        message: 'Phase "specify" timed out after 900000ms',
        stderr: 'last log line before kill',
        phase: 'specify',
      },
    };
    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(failResult);
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: false });

    await phaseLoop.executeLoop(context, config, deps, ['specify']);

    const errorCall = findLastErrorCall(deps.stageCommentManager.updateStageComment);
    expect(errorCall.errorEvidence.exitDescriptor).toBe('killed (SIGTERM) after 900000ms');
  });

  it('renders aborted descriptor when error message signals an abort', async () => {
    const context = createMockContext('specify');
    const config = createConfig();

    const failResult: PhaseResult = {
      phase: 'specify',
      success: false,
      exitCode: 1,
      durationMs: 50,
      output: [],
      error: {
        message: 'Phase "specify" was aborted',
        stderr: '',
        phase: 'specify',
      },
    };
    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(failResult);
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: false });

    await phaseLoop.executeLoop(context, config, deps, ['specify']);

    const errorCall = findLastErrorCall(deps.stageCommentManager.updateStageComment);
    expect(errorCall.errorEvidence.exitDescriptor).toBe('aborted');
    expect(errorCall.errorEvidence.stderrTail).toBe('(stderr empty)');
  });
});
