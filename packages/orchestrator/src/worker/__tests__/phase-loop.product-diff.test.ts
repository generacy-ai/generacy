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
    getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
    getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(ownFiles),
    getFilesChangedBetween: vi.fn().mockResolvedValue(cumulativeFiles),
    // #1112: a reused phase-start-ref is resolve-checked before use. Default to
    // "resolves" so existing cases exercise the reuse path unchanged.
    commitExistsInCheckout: vi.fn().mockResolvedValue(true),
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
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('a1b2c3d4');
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
  });

  it('captures the phase-start ref via getCurrentCommitSha before measuring the diff', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['specs/1107/tasks.md']);
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(context.github.getCurrentCommitSha).toHaveBeenCalled();
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('a1b2c3d4');
  });

  it('SC-005: detection failure (own-commit diff throws) routes to onError, does not silently pass', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub([]);
    context.github.getFilesChangedByOwnCommits = vi
      .fn()
      .mockRejectedValue(new Error('fatal: bad revision a1b2c3d4..HEAD'));
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
      'phase-start-ref:generacy-ai:generacy:1107:no-branch:implement',
    );
  });

  it('reuses a persisted start ref across increments (persist-once)', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    const setValueRaw = vi.fn().mockResolvedValue(undefined);
    deps.phaseTracker = {
      getValueRaw: vi.fn().mockResolvedValue('deadbeef'),
      setValueRaw,
      clearRaw: vi.fn().mockResolvedValue(undefined),
    } as any;
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    // Existing ref reused: getCurrentCommitSha never consulted, no re-persist.
    expect(context.github.getCurrentCommitSha).not.toHaveBeenCalled();
    expect(setValueRaw).not.toHaveBeenCalled();
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('deadbeef');
  });

  it('scopes the persisted start ref by branch (re-entry on a new branch captures fresh)', async () => {
    const context = createMockContext('implement');
    context.branch = '1107-b';
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    // Stub the branch-driven guards that only kick in when context.branch is
    // set: the phase-loop-entry push guard (#1051) and the pre-implement
    // base-merge (#864). Both are unrelated to the phase-start-ref capture
    // site under test.
    (context.github as any).findPRForBranchAnyState = vi.fn().mockResolvedValue(null);
    deps.baseMergeRunner = vi.fn().mockResolvedValue({ ok: true, mergeSha: 'a1b2c3d4' }) as any;
    const setValueRaw = vi.fn().mockResolvedValue(undefined);
    const getValueRaw = vi.fn().mockResolvedValue(null);
    deps.phaseTracker = {
      getValueRaw,
      setValueRaw,
      clearRaw: vi.fn().mockResolvedValue(undefined),
    } as any;
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(getValueRaw).toHaveBeenCalledWith(
      'phase-start-ref:generacy-ai:generacy:1107:1107-b:implement',
    );
    expect(setValueRaw).toHaveBeenCalledWith(
      'phase-start-ref:generacy-ai:generacy:1107:1107-b:implement',
      'a1b2c3d4',
      expect.any(Number),
    );
  });

  it('rejects a non-SHA persisted ref and re-captures via getCurrentCommitSha', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    const setValueRaw = vi.fn().mockResolvedValue(undefined);
    // Empty-string persisted value would silently invert the guard by
    // producing an empty file list. Must be rejected as if absent.
    deps.phaseTracker = {
      getValueRaw: vi.fn().mockResolvedValue(''),
      setValueRaw,
      clearRaw: vi.fn().mockResolvedValue(undefined),
    } as any;
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(context.github.getCurrentCommitSha).toHaveBeenCalled();
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('a1b2c3d4');
    expect(setValueRaw).toHaveBeenCalled();
  });

  it('SC-005: empty-string return from getCurrentCommitSha routes to detection failure', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    context.github.getCurrentCommitSha = vi.fn().mockResolvedValue('');
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(false);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
    const last = result.results[result.results.length - 1]!;
    expect(last.error?.message).toMatch(/product-diff detection failed/);
  });
});

describe('PhaseLoop - phase-start-ref legacy migration + resolve-check (#1112)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  const BRANCH_KEY = 'phase-start-ref:generacy-ai:generacy:1107:no-branch:implement';
  const LEGACY_KEY = 'phase-start-ref:generacy-ai:generacy:1107:implement';

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  it('SC-001: migrates a valid legacy ref on a branch-scoped miss and reuses it', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    const getValueRaw = vi.fn(async (key: string) =>
      key === LEGACY_KEY ? 'deadbeef' : null,
    );
    const setValueRaw = vi.fn().mockResolvedValue(undefined);
    const clearRaw = vi.fn().mockResolvedValue(undefined);
    deps.phaseTracker = { getValueRaw, setValueRaw, clearRaw } as any;
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    // Legacy ref reused directly — no fresh HEAD capture.
    expect(context.github.getCurrentCommitSha).not.toHaveBeenCalled();
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('deadbeef');
    // Re-persisted under the branch-scoped key BEFORE the legacy clear (Q1=A).
    expect(setValueRaw).toHaveBeenCalledWith(BRANCH_KEY, 'deadbeef', expect.any(Number));
    expect(clearRaw).toHaveBeenCalledWith(LEGACY_KEY);
    const setOrder = setValueRaw.mock.invocationCallOrder[0]!;
    const legacyClearIdx = clearRaw.mock.calls.findIndex((c) => c[0] === LEGACY_KEY);
    const clearOrder = clearRaw.mock.invocationCallOrder[legacyClearIdx]!;
    expect(setOrder).toBeLessThan(clearOrder);
    // Phase passed to validate.
    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalledWith('implement');
  });

  it('SC-002: clears the legacy key exactly once on the shape-invalid legacy case', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    const getValueRaw = vi.fn(async (key: string) =>
      key === LEGACY_KEY ? '' : null,
    );
    const setValueRaw = vi.fn().mockResolvedValue(undefined);
    const clearRaw = vi.fn().mockResolvedValue(undefined);
    deps.phaseTracker = { getValueRaw, setValueRaw, clearRaw } as any;
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    // Shape-invalid legacy → not migrated, but consumed (cleared) exactly once.
    const legacyClears = clearRaw.mock.calls.filter((c) => c[0] === LEGACY_KEY);
    expect(legacyClears).toHaveLength(1);
    // No migration write; fresh HEAD captured instead.
    expect(setValueRaw).not.toHaveBeenCalledWith(BRANCH_KEY, '', expect.any(Number));
    expect(context.github.getCurrentCommitSha).toHaveBeenCalled();
  });

  it('SC-002: clears the legacy key exactly once on the shape-valid-but-unresolvable legacy case', async () => {
    // Q3=A third arm: a well-formed sha in the legacy key whose commit does
    // not exist in this checkout (attempt-1-merge-never-pushed after re-entry
    // on a fresh clone). The clear must still fire — otherwise the same
    // unresolvable legacy value is re-read and re-rejected on every subsequent
    // branch-scoped miss until its 7-day TTL. Kills the mutation that defers
    // the legacy clear until after the resolve check.
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    context.github.commitExistsInCheckout = vi.fn().mockResolvedValue(false);
    const getValueRaw = vi.fn(async (key: string) =>
      key === LEGACY_KEY ? 'deadbeef' : null,
    );
    const setValueRaw = vi.fn().mockResolvedValue(undefined);
    const clearRaw = vi.fn().mockResolvedValue(undefined);
    deps.phaseTracker = { getValueRaw, setValueRaw, clearRaw } as any;
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    // Shape-valid legacy ref → migrated + consumed even though the resolve
    // check subsequently rejects it. Clear fires exactly once, regardless of
    // whether the ref survived the resolve check.
    const legacyClears = clearRaw.mock.calls.filter((c) => c[0] === LEGACY_KEY);
    expect(legacyClears).toHaveLength(1);
    // Fresh HEAD capture followed the resolve-check rejection.
    expect(context.github.commitExistsInCheckout).toHaveBeenCalledWith('deadbeef');
    expect(context.github.getCurrentCommitSha).toHaveBeenCalled();
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('a1b2c3d4');
  });

  it('SC-003: re-captures fresh HEAD when the persisted ref does not resolve in this checkout', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    context.github.commitExistsInCheckout = vi.fn().mockResolvedValue(false);
    const getValueRaw = vi.fn(async (key: string) =>
      key === BRANCH_KEY ? 'deadbeef' : null,
    );
    const setValueRaw = vi.fn().mockResolvedValue(undefined);
    deps.phaseTracker = {
      getValueRaw,
      setValueRaw,
      clearRaw: vi.fn().mockResolvedValue(undefined),
    } as any;
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(context.github.commitExistsInCheckout).toHaveBeenCalledWith('deadbeef');
    // Unresolvable → treat as absent → capture fresh HEAD and persist it.
    expect(context.github.getCurrentCommitSha).toHaveBeenCalled();
    expect(setValueRaw).toHaveBeenCalledWith(BRANCH_KEY, 'a1b2c3d4', expect.any(Number));
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('a1b2c3d4');
    // No throw, no product-diff-error, no escalation.
    expect(result.completed).toBe(true);
    expect(deps.labelManager.onError).not.toHaveBeenCalledWith('implement');
  });

  it('SC-004: reuses a branch-scoped ref directly when it resolves (no legacy read)', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    const getValueRaw = vi.fn(async (key: string) =>
      key === BRANCH_KEY ? 'deadbeef' : null,
    );
    const setValueRaw = vi.fn().mockResolvedValue(undefined);
    deps.phaseTracker = {
      getValueRaw,
      setValueRaw,
      clearRaw: vi.fn().mockResolvedValue(undefined),
    } as any;
    const config = createConfig();

    await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    // Branch-scoped hit that resolves → no legacy read-through, no re-capture.
    expect(getValueRaw).not.toHaveBeenCalledWith(LEGACY_KEY);
    expect(context.github.getCurrentCommitSha).not.toHaveBeenCalled();
    expect(setValueRaw).not.toHaveBeenCalled();
    expect(context.github.getFilesChangedByOwnCommits).toHaveBeenCalledWith('deadbeef');
  });

  it('SC-005: a non-commit-missing git fault (throw) routes to product-diff-error', async () => {
    const context = createMockContext('implement');
    context.github = makeGithub(['packages/orchestrator/src/foo.ts']);
    context.github.commitExistsInCheckout = vi
      .fn()
      .mockRejectedValue(new Error('git rev-parse ... failed (exit 128): fatal: not a git repository'));
    const getValueRaw = vi.fn(async (key: string) =>
      key === BRANCH_KEY ? 'deadbeef' : null,
    );
    deps.phaseTracker = {
      getValueRaw,
      setValueRaw: vi.fn().mockResolvedValue(undefined),
      clearRaw: vi.fn().mockResolvedValue(undefined),
    } as any;
    const config = createConfig();

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement', 'validate']);

    expect(result.completed).toBe(false);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
    const last = result.results[result.results.length - 1]!;
    expect(last.error?.message).toMatch(/product-diff detection failed/);
  });
});
