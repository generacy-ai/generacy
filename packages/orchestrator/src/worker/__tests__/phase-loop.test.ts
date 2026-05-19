import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
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
      checkGate: vi.fn().mockReturnValue(null),
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
    github: {} as any,
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

describe('PhaseLoop - implement phase requires changes', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('fails implement phase when no changes and no prior implementation', async () => {
    const context = createMockContext('implement');
    context.github = {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentBranch: vi.fn().mockResolvedValue('008-feature'),
      getCommitsBetween: vi.fn().mockResolvedValue([
        { sha: 'abc', message: 'chore(speckit): complete specify phase for #8' },
      ]),
    } as any;
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('implement'));
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: false });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('implement');
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
  });

  it('continues when no new changes but prior implementation commit exists on branch', async () => {
    const context = createMockContext('implement');
    context.github = {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentBranch: vi.fn().mockResolvedValue('008-feature'),
      getCommitsBetween: vi.fn().mockResolvedValue([
        { sha: 'abc', message: 'chore(speckit): complete specify phase for #8' },
        { sha: 'def', message: 'chore(speckit): complete implement phase for #8' },
      ]),
    } as any;
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('implement'));
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: false });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('implement');
  });

  it('soft-passes when no new changes but prior WIP retry commit exists on branch', async () => {
    const context = createMockContext('implement');
    context.github = {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentBranch: vi.fn().mockResolvedValue('008-feature'),
      getCommitsBetween: vi.fn().mockResolvedValue([
        { sha: 'abc', message: 'wip(speckit): partial implement progress for #8 (retry 1)' },
      ]),
    } as any;
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(makeSuccessResult('implement'));
    (deps.prManager.commitPushAndEnsurePr as any).mockResolvedValue({ prUrl: null, hasChanges: false });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
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
    (deps.gateChecker.checkGate as any).mockReturnValue({
      phase: 'clarify',
      gateLabel: 'waiting-for:clarification',
      condition: 'always',
    });

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
