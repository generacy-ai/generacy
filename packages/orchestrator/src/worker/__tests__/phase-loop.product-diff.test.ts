import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import type { WorkerConfig } from '../config.js';

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

function createMockContext(startPhase: WorkflowPhase = 'implement'): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: {
      owner: 'generacy-ai',
      repo: 'generacy',
      issueNumber: 820,
      workflowName: 'speckit-feature',
    } as any,
    startPhase,
    github: {} as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/generacy-ai/generacy/issues/820',
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
  };
}

describe('PhaseLoop - product-diff empty-implement detection (SC-001)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('SC-001: fails implement when cumulative diff has only spec files', async () => {
    const context = createMockContext('implement');
    context.github = {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getFilesChangedBetween: vi.fn().mockResolvedValue([
        'specs/820/tasks.md',
        'specs/820/plan.md',
      ]),
    } as any;
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('implement');
    const last = result.results[result.results.length - 1]!;
    expect(last.error?.message).toMatch(/no product-code changes/);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    // validate must NEVER run when implement fails product-diff
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
  });

  it('resolves base ref against PR base when getPrNumber() is set', async () => {
    const context = createMockContext('implement');
    const getPullRequest = vi.fn().mockResolvedValue({
      number: 42,
      base: { ref: 'main', sha: 'abc' },
    });
    const getFilesChangedBetween = vi.fn().mockResolvedValue(['specs/only.md']);
    context.github = {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getPullRequest,
      getFilesChangedBetween,
    } as any;
    (deps.prManager.getPrNumber as any) = vi.fn().mockReturnValue(42);
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(getPullRequest).toHaveBeenCalledWith('generacy-ai', 'generacy', 42);
    expect(getFilesChangedBetween).toHaveBeenCalledWith('origin/main', 'HEAD');
  });

  it('falls back to origin/<default-branch> when no PR yet', async () => {
    const context = createMockContext('implement');
    const getFilesChangedBetween = vi.fn().mockResolvedValue(['specs/only.md']);
    context.github = {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getPullRequest: vi.fn(),
      getFilesChangedBetween,
    } as any;
    (deps.prManager.getPrNumber as any) = vi.fn().mockReturnValue(undefined);
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(getFilesChangedBetween).toHaveBeenCalledWith('origin/develop', 'HEAD');
    expect(context.github.getPullRequest).not.toHaveBeenCalled();
  });

  it('detection failure (git diff throws) routes to onError, does not silently pass', async () => {
    const context = createMockContext('implement');
    context.github = {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getFilesChangedBetween: vi.fn().mockRejectedValue(
        new Error('fatal: bad revision origin/develop'),
      ),
    } as any;
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('implement');
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
    const last = result.results[result.results.length - 1]!;
    expect(last.error?.message).toMatch(/product-diff detection failed/);
  });
});

describe('PhaseLoop - product-diff regression (SC-002)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('SC-002: passes through to validate when a single product file changed', async () => {
    const context = createMockContext('implement');
    context.github = {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getFilesChangedBetween: vi.fn().mockResolvedValue([
        'packages/orchestrator/src/foo.ts',
      ]),
    } as any;
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.runValidatePhase).toHaveBeenCalled();
  });

  it('SC-002: passes through when mixed spec + product diff', async () => {
    const context = createMockContext('implement');
    context.github = {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getFilesChangedBetween: vi.fn().mockResolvedValue([
        'specs/820/plan.md',
        'packages/orchestrator/src/foo.ts',
      ]),
    } as any;
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.runValidatePhase).toHaveBeenCalled();
  });
});
