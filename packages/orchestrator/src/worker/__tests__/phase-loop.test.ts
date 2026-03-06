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
    preValidateCommand: 'pnpm install',
    gates: {},
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
