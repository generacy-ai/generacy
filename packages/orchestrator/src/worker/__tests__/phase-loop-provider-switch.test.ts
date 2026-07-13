import { vi, describe, it, expect } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { WorkerConfigSchema } from '../config.js';
import type { WorkerConfig } from '../config.js';

/**
 * Provider-switch session-drop + model-preserve per plan.md Acceptance Gate #4.
 *
 * Assertions:
 *  (a) provider switch clears `resumeSessionId` on the next spawnPhase call.
 *  (b) same-provider model change preserves `resumeSessionId` AND emits
 *      `agent.model.transition` with correct `prevModel` / `nextModel` fields.
 *  (c) same-provider same-model preserves `resumeSessionId` AND does NOT emit
 *      the log line.
 *
 * The phase-loop routes provider selection through `spawnPhase(options)`; we
 * inspect the options each call receives. No real launcher required — we mock
 * `cliSpawner.spawnPhase` and let the loop drive the resolver.
 */

function makeSuccessResult(phase: WorkflowPhase, sessionId: string): PhaseResult {
  return {
    phase,
    success: true,
    exitCode: 0,
    durationMs: 100,
    output: [],
    sessionId,
  };
}

interface CapturingLogger extends Logger {
  infoCalls: Array<{ obj: Record<string, unknown> | null; msg: string }>;
}

function createCapturingLogger(): CapturingLogger {
  const infoCalls: Array<{ obj: Record<string, unknown> | null; msg: string }> = [];
  const logger: CapturingLogger = {
    info: ((first: unknown, second?: unknown) => {
      if (typeof first === 'string') {
        infoCalls.push({ obj: null, msg: first });
      } else {
        infoCalls.push({ obj: first as Record<string, unknown>, msg: second as string });
      }
    }) as Logger['info'],
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => logger,
    infoCalls,
  } as CapturingLogger;
  return logger;
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
      postFailureAlert: vi.fn().mockResolvedValue(undefined),
    } as any,
    gateChecker: {
      checkGates: vi.fn().mockReturnValue([]),
    } as any,
    cliSpawner: {
      spawnPhase: vi.fn(),
      runValidatePhase: vi.fn().mockResolvedValue(makeSuccessResult('validate', 'ses-validate')),
      runPreValidateInstall: vi.fn().mockResolvedValue(makeSuccessResult('validate', 'ses-validate')),
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

function createContext(logger: Logger): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'job-1',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
    } as any,
    startPhase: 'plan',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getFilesChangedBetween: vi.fn().mockResolvedValue([]),
    } as any,
    logger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/test/repo/issues/42',
    description: 'test',
  };
}

function createConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return WorkerConfigSchema.parse({
    workspaceDir: '/tmp',
    ...overrides,
  });
}

describe('PhaseLoop — provider switch drops session (FR-011)', () => {
  it('(a) provider switch between phases clears resumeSessionId on next spawn', async () => {
    const logger = createCapturingLogger();
    const phaseLoop = new PhaseLoop(logger);
    const deps = createMockDeps();

    // plan → claude-code, implement → test-agent
    const config = createConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              plan: { provider: 'claude-code' },
              implement: { provider: 'test-agent' },
            },
          },
        },
      },
    });

    const capturedSpawns: Array<{ phase: WorkflowPhase; provider?: string; model?: string; resumeSessionId?: string }> = [];
    (deps.cliSpawner.spawnPhase as any).mockImplementation(
      async (phase: WorkflowPhase, options: { provider?: string; model?: string; resumeSessionId?: string }) => {
        capturedSpawns.push({
          phase,
          provider: options.provider,
          model: options.model,
          resumeSessionId: options.resumeSessionId,
        });
        return makeSuccessResult(phase, `ses-${phase}`);
      },
    );

    await phaseLoop.executeLoop(createContext(logger), config, deps, ['plan', 'implement']);

    expect(capturedSpawns).toHaveLength(2);
    // Phase 1 (plan): claude-code, no prior session
    expect(capturedSpawns[0]).toMatchObject({ phase: 'plan', provider: 'claude-code' });
    expect(capturedSpawns[0]?.resumeSessionId).toBeUndefined();
    // Phase 2 (implement): test-agent — because provider CHANGED, session was dropped.
    expect(capturedSpawns[1]).toMatchObject({ phase: 'implement', provider: 'test-agent' });
    expect(capturedSpawns[1]?.resumeSessionId).toBeUndefined();
  });
});

describe('PhaseLoop — model change preserves session + emits transition log', () => {
  it('(b) same-provider model change preserves resumeSessionId AND emits agent.model.transition', async () => {
    const logger = createCapturingLogger();
    const phaseLoop = new PhaseLoop(logger);
    const deps = createMockDeps();

    // plan → sonnet, implement → opus, both claude-code.
    const config = createConfig({
      agents: {
        default: { provider: 'claude-code' },
        workflows: {
          'speckit-feature': {
            phases: {
              plan: { model: 'sonnet-4-6' },
              implement: { model: 'opus-4-7' },
            },
          },
        },
      },
    });

    const capturedSpawns: Array<{ phase: WorkflowPhase; model?: string; resumeSessionId?: string; previousModel?: string }> = [];
    (deps.cliSpawner.spawnPhase as any).mockImplementation(
      async (phase: WorkflowPhase, options: { model?: string; resumeSessionId?: string; previousModel?: string }) => {
        capturedSpawns.push({
          phase,
          model: options.model,
          resumeSessionId: options.resumeSessionId,
          previousModel: options.previousModel,
        });
        return makeSuccessResult(phase, `ses-${phase}`);
      },
    );

    await phaseLoop.executeLoop(createContext(logger), config, deps, ['plan', 'implement']);

    expect(capturedSpawns).toHaveLength(2);
    expect(capturedSpawns[0]).toMatchObject({ phase: 'plan', model: 'sonnet-4-6' });
    expect(capturedSpawns[0]?.resumeSessionId).toBeUndefined();
    // Phase 2 preserves session — same provider (claude-code).
    expect(capturedSpawns[1]).toMatchObject({
      phase: 'implement',
      model: 'opus-4-7',
      resumeSessionId: 'ses-plan',
      previousModel: 'sonnet-4-6',
    });

    // Transition log line emitted
    const transitionLog = logger.infoCalls.find((c) => c.msg === 'agent.model.transition');
    expect(transitionLog).toBeDefined();
    expect(transitionLog?.obj).toMatchObject({
      provider: 'claude-code',
      prevModel: 'sonnet-4-6',
      nextModel: 'opus-4-7',
    });
  });

  it('(c) same-provider same-model preserves session and does NOT emit the transition log', async () => {
    const logger = createCapturingLogger();
    const phaseLoop = new PhaseLoop(logger);
    const deps = createMockDeps();

    // Every phase resolves to the same {provider: claude-code, model: sonnet-4-6}
    const config = createConfig({
      agents: {
        default: { provider: 'claude-code', model: 'sonnet-4-6' },
      },
    });

    const capturedSpawns: Array<{ phase: WorkflowPhase; model?: string; resumeSessionId?: string }> = [];
    (deps.cliSpawner.spawnPhase as any).mockImplementation(
      async (phase: WorkflowPhase, options: { model?: string; resumeSessionId?: string }) => {
        capturedSpawns.push({
          phase,
          model: options.model,
          resumeSessionId: options.resumeSessionId,
        });
        return makeSuccessResult(phase, `ses-${phase}`);
      },
    );

    await phaseLoop.executeLoop(createContext(logger), config, deps, ['plan', 'implement']);

    expect(capturedSpawns).toHaveLength(2);
    expect(capturedSpawns[0]).toMatchObject({ phase: 'plan', model: 'sonnet-4-6' });
    // Session preserved across phase (same provider, same model)
    expect(capturedSpawns[1]).toMatchObject({
      phase: 'implement',
      model: 'sonnet-4-6',
      resumeSessionId: 'ses-plan',
    });

    // No transition log for a same-model spawn
    const transitionLog = logger.infoCalls.find((c) => c.msg === 'agent.model.transition');
    expect(transitionLog).toBeUndefined();
  });
});

describe('PhaseLoop — unknown provider surfaces via spawn-error catch (T023)', () => {
  it('propagates UnknownProviderError from the spawner through the phase-loop error path', async () => {
    const logger = createCapturingLogger();
    const phaseLoop = new PhaseLoop(logger);
    const deps = createMockDeps();

    const config = createConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              implement: { provider: 'does-not-exist' },
            },
          },
        },
      },
    });

    // Simulate the AgentLauncher's UnknownProviderError bubbling up through
    // cliSpawner.spawnPhase — no silent fallback to Claude.
    const unknownProviderError = new Error('Unknown provider "does-not-exist" for kind "phase"');
    unknownProviderError.name = 'UnknownProviderError';
    (deps.cliSpawner.spawnPhase as any).mockRejectedValueOnce(unknownProviderError);

    // startPhase must match the sequence — override the plan default.
    const ctx = { ...createContext(logger), startPhase: 'implement' as WorkflowPhase };

    let caught: unknown;
    try {
      await phaseLoop.executeLoop(ctx, config, deps, ['implement']);
    } catch (err) {
      caught = err;
    }

    // The phase-loop rethrows the spawn error after posting the failure alert.
    expect(caught).toBeDefined();
    expect(String(caught)).toContain('Unknown provider "does-not-exist"');
    // Failure alert was posted (spawn-error path)
    expect(deps.stageCommentManager.postFailureAlert).toHaveBeenCalled();
    // Provider was requested — not silently swapped for claude-code
    expect(deps.cliSpawner.spawnPhase).toHaveBeenCalledWith(
      'implement',
      expect.objectContaining({ provider: 'does-not-exist' }),
      expect.anything(),
    );
  });
});
