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

/**
 * Build a github stub for the phase-scoped guard (#1107). `ownFiles` are the
 * files the guard measures (own-commit diff since the captured start ref);
 * `cumulativeFiles` (optional) exercise the diagnostics `baseRef...HEAD` window,
 * which must NOT influence the pass/fail decision (SC-004).
 */
function makeGithub(ownFiles: string[], cumulativeFiles: string[] = ownFiles): any {
  return {
    getDefaultBranch: vi.fn().mockResolvedValue('develop'),
    getPullRequest: vi.fn(),
    getCurrentCommitSha: vi.fn().mockResolvedValue('startsha'),
    getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(ownFiles),
    getFilesChangedBetween: vi.fn().mockResolvedValue(cumulativeFiles),
  };
}

function createMockContext(startPhase: WorkflowPhase = 'implement'): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: {
      owner: 'generacy-ai',
      repo: 'generacy',
      issueNumber: 1107,
      workflowName: 'speckit-feature',
    } as any,
    startPhase,
    github: {} as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/generacy-ai/generacy/issues/1107',
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

describe('PhaseLoop - phase-scoped product-diff empty-implement detection', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('SC-001: fails implement when own-diff is an earlier-phase CLAUDE.md + a spec log', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['CLAUDE.md', 'specs/1107/conversation-log.jsonl']);
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

  it('SC-002: fails implement when own-diff is CLAUDE.md only', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['CLAUDE.md']);
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('implement');
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
  });

  it('SC-004: fails when own-diff is empty even though baseRef...HEAD carries product files', async () => {
    const context = createMockContext('implement');
    // Empty own-diff, but the cumulative window has an earlier-phase product
    // file — the guard must ignore the cumulative window (first-parent/no-merges).
    context.github = makeGithub([], ['packages/orchestrator/src/earlier-phase.ts']);
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('implement');
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('startsha');
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
  });

  it('captures the phase-start ref via getCurrentCommitSha before measuring the diff', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['specs/1107/tasks.md']);
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(context.github.getCurrentCommitSha).toHaveBeenCalled();
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('startsha');
  });

  it('SC-005: detection failure (own-commit diff throws) routes to onError, does not silently pass', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub([]);
    context.github.getFilesChangedByOwnCommits = vi
      .fn()
      .mockRejectedValue(new Error('fatal: bad revision startsha..HEAD'));
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('implement');
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
    const last = result.results[result.results.length - 1]!;
    expect(last.error?.message).toMatch(/product-diff detection failed/);
  });

  it('SC-005: detection failure when the start ref could not be captured', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/x/y.ts']);
    context.github.getCurrentCommitSha = vi
      .fn()
      .mockRejectedValue(new Error('fatal: not a git repository'));
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(false);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
    const last = result.results[result.results.length - 1]!;
    expect(last.error?.message).toMatch(/product-diff detection failed/);
  });
});

describe('PhaseLoop - phase-scoped product-diff healthy path (SC-003)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('SC-003: passes through to validate when a single product file changed', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.runValidatePhase).toHaveBeenCalled();
  });

  it('SC-003: passes through when own-diff mixes spec + product files', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['specs/1107/plan.md', 'packages/orchestrator/src/foo.ts']);
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.runValidatePhase).toHaveBeenCalled();
  });

  it('clears the persisted start ref on pass', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    const clearRaw = vi.fn().mockResolvedValue(undefined);
    deps.phaseTracker = {
      getValueRaw: vi.fn().mockResolvedValue(null),
      setValueRaw: vi.fn().mockResolvedValue(undefined),
      clearRaw,
    } as any;
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(clearRaw).toHaveBeenCalledWith(
      'phase-start-ref:generacy-ai:generacy:1107:implement',
    );
  });

  it('reuses a persisted start ref across increments (persist-once)', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    const setValueRaw = vi.fn().mockResolvedValue(undefined);
    deps.phaseTracker = {
      getValueRaw: vi.fn().mockResolvedValue('persisted-sha'),
      setValueRaw,
      clearRaw: vi.fn().mockResolvedValue(undefined),
    } as any;
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    // Existing ref reused: getCurrentCommitSha never consulted, no re-persist.
    expect(context.github.getCurrentCommitSha).not.toHaveBeenCalled();
    expect(setValueRaw).not.toHaveBeenCalled();
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('persisted-sha');
  });
});
