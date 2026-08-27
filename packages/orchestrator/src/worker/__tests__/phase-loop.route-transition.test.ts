import { vi, describe, it, expect } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { WorkerConfigSchema } from '../config.js';
import type { WorkerConfig } from '../config.js';

/**
 * #1199 — route-aware session invalidation + transition logging.
 *
 * D-4 test seam: partial-mock `@generacy-ai/generacy-plugin-claude-code` so the
 * real module is preserved but `resolveRoute` is stubbed and steered by model
 * name (a model string containing `/` → 'gateway', otherwise 'subscription').
 * The orchestrator's contract is "react to a route change", not "classify
 * models", so steering the stub keeps these assertions independent of #1198's
 * classification rule.
 *
 * Assertions:
 *  SC-001: same provider, subscription → gateway: session dropped, route
 *          transition logged.
 *  SC-002: same provider, same route (subscription → subscription) but model
 *          change: session kept, model transition logged, NO route transition.
 *  Q2→A:  provider AND route change together: provider-switch line AND
 *          agent.route.transition both logged; session dropped exactly once.
 *  Q3→A:  first CLI phase (currentRoute undefined): no route transition, no drop.
 *  FR-006: spawn-site options payload includes the resolved route.
 */

vi.mock('@generacy-ai/generacy-plugin-claude-code', async (importActual) => {
  const actual = await importActual<typeof import('@generacy-ai/generacy-plugin-claude-code')>();
  return {
    ...actual,
    resolveRoute: vi.fn((model?: string) =>
      model !== undefined && model.includes('/') ? 'gateway' : 'subscription',
    ),
  };
});

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

interface CapturedSpawn {
  phase: WorkflowPhase;
  provider?: string;
  model?: string;
  route?: string;
  resumeSessionId?: string;
}

function captureSpawns(deps: PhaseLoopDeps): CapturedSpawn[] {
  const captured: CapturedSpawn[] = [];
  (deps.cliSpawner.spawnPhase as any).mockImplementation(
    async (
      phase: WorkflowPhase,
      options: { provider?: string; model?: string; route?: string; resumeSessionId?: string },
    ) => {
      captured.push({
        phase,
        provider: options.provider,
        model: options.model,
        route: options.route,
        resumeSessionId: options.resumeSessionId,
      });
      return makeSuccessResult(phase, `ses-${phase}`);
    },
  );
  return captured;
}

describe('PhaseLoop — route change drops session (SC-001)', () => {
  it('same provider, subscription → gateway: drops session and logs agent.route.transition', async () => {
    const logger = createCapturingLogger();
    const phaseLoop = new PhaseLoop(logger);
    const deps = createMockDeps();

    // Both phases claude-code; plan resolves subscription (claude-opus-4-8),
    // implement resolves gateway (openrouter/a/b).
    const config = createConfig({
      agents: {
        default: { provider: 'claude-code' },
        workflows: {
          'speckit-feature': {
            phases: {
              plan: { model: 'claude-opus-4-8' },
              implement: { model: 'openrouter/a/b' },
            },
          },
        },
      },
    });

    const capturedSpawns = captureSpawns(deps);

    await phaseLoop.executeLoop(createContext(logger), config, deps, ['plan', 'implement']);

    expect(capturedSpawns).toHaveLength(2);
    expect(capturedSpawns[0]).toMatchObject({ phase: 'plan', route: 'subscription' });
    // Second spawn: route flipped → session dropped.
    expect(capturedSpawns[1]).toMatchObject({ phase: 'implement', route: 'gateway' });
    expect(capturedSpawns[1]?.resumeSessionId).toBeUndefined();

    const routeLog = logger.infoCalls.find((c) => c.msg === 'agent.route.transition');
    expect(routeLog).toBeDefined();
    expect(routeLog?.obj).toMatchObject({
      phase: 'implement',
      prevRoute: 'subscription',
      nextRoute: 'gateway',
      prevModel: 'claude-opus-4-8',
      nextModel: 'openrouter/a/b',
    });
  });
});

describe('PhaseLoop — same-route model change keeps session (SC-002)', () => {
  it('subscription → subscription with model change: session kept, model transition only', async () => {
    const logger = createCapturingLogger();
    const phaseLoop = new PhaseLoop(logger);
    const deps = createMockDeps();

    const config = createConfig({
      agents: {
        default: { provider: 'claude-code' },
        workflows: {
          'speckit-feature': {
            phases: {
              plan: { model: 'claude-opus-4-8' },
              implement: { model: 'claude-sonnet-5' },
            },
          },
        },
      },
    });

    const capturedSpawns = captureSpawns(deps);

    await phaseLoop.executeLoop(createContext(logger), config, deps, ['plan', 'implement']);

    expect(capturedSpawns).toHaveLength(2);
    expect(capturedSpawns[0]).toMatchObject({ phase: 'plan', route: 'subscription' });
    // Session preserved — same provider, same route.
    expect(capturedSpawns[1]).toMatchObject({
      phase: 'implement',
      route: 'subscription',
      resumeSessionId: 'ses-plan',
    });

    expect(logger.infoCalls.find((c) => c.msg === 'agent.model.transition')).toBeDefined();
    expect(logger.infoCalls.find((c) => c.msg === 'agent.route.transition')).toBeUndefined();
  });
});

describe('PhaseLoop — simultaneous provider + route change (Q2→A)', () => {
  it('logs both provider-switch line AND agent.route.transition; session dropped once', async () => {
    const logger = createCapturingLogger();
    const phaseLoop = new PhaseLoop(logger);
    const deps = createMockDeps();

    // plan: claude-code + subscription model; implement: other-provider + gateway model.
    const config = createConfig({
      agents: {
        workflows: {
          'speckit-feature': {
            phases: {
              plan: { provider: 'claude-code', model: 'claude-opus-4-8' },
              implement: { provider: 'test-agent', model: 'openrouter/a/b' },
            },
          },
        },
      },
    });

    const capturedSpawns = captureSpawns(deps);

    await phaseLoop.executeLoop(createContext(logger), config, deps, ['plan', 'implement']);

    expect(capturedSpawns).toHaveLength(2);
    expect(capturedSpawns[1]).toMatchObject({
      phase: 'implement',
      provider: 'test-agent',
      route: 'gateway',
    });
    // Session dropped (either the provider-switch or route-change branch clears it;
    // both are idempotent → still undefined).
    expect(capturedSpawns[1]?.resumeSessionId).toBeUndefined();

    const providerLog = logger.infoCalls.find(
      (c) => c.msg === 'Provider switch detected — dropping session for fresh start',
    );
    const routeLog = logger.infoCalls.find((c) => c.msg === 'agent.route.transition');
    expect(providerLog).toBeDefined();
    expect(routeLog).toBeDefined();
    expect(routeLog?.obj).toMatchObject({
      prevRoute: 'subscription',
      nextRoute: 'gateway',
    });
  });
});

describe('PhaseLoop — first CLI phase initializes route only (Q3→A)', () => {
  it('does not log a route transition or drop the (absent) session on the first phase', async () => {
    const logger = createCapturingLogger();
    const phaseLoop = new PhaseLoop(logger);
    const deps = createMockDeps();

    const config = createConfig({
      agents: { default: { provider: 'claude-code', model: 'openrouter/a/b' } },
    });

    const capturedSpawns = captureSpawns(deps);

    await phaseLoop.executeLoop(createContext(logger), config, deps, ['plan']);

    expect(capturedSpawns).toHaveLength(1);
    // FR-006: route present on the very first spawn.
    expect(capturedSpawns[0]).toMatchObject({ phase: 'plan', route: 'gateway' });
    // Q3→A: undefined → X initializes only.
    expect(logger.infoCalls.find((c) => c.msg === 'agent.route.transition')).toBeUndefined();
  });
});
