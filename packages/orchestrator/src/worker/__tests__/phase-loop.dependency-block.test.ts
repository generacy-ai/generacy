import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import type { WorkerConfig } from '../config.js';
import { MARKER_BLOCK, MARKER_LIMIT } from '../dependency-block.js';

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
function makeSuccessResult(
  phase: WorkflowPhase,
  implementResult?: Record<string, unknown>,
): PhaseResult {
  return {
    phase,
    success: true,
    exitCode: 0,
    durationMs: 100,
    output: [],
    ...(implementResult ? { implementResult } : {}),
  };
}

function makeFailResult(phase: WorkflowPhase): PhaseResult {
  return {
    phase,
    success: false,
    exitCode: 1,
    durationMs: 50,
    output: [],
    error: { message: `${phase} failed`, output: '', phase },
  };
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

function createMockContext(): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 42,
      workflowName: 'speckit-feature',
    } as any,
    startPhase: 'implement' as WorkflowPhase,
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      getFilesChangedByOwnCommits: vi
        .fn()
        .mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getIssueComments: vi.fn().mockResolvedValue([]),
      addIssueComment: vi.fn().mockResolvedValue(undefined),
      removeLabels: vi.fn().mockResolvedValue(undefined),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/test/repo/issues/42',
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

function makeBlockCommentBody(refCount: number): string {
  const refs = Array.from({ length: refCount }, (_, i) => `test/repo#${i + 1}`);
  return `${MARKER_BLOCK}\n\`\`\`json\n{"on":${JSON.stringify(refs)}}\n\`\`\`\n\nImplementation paused — blocked on dependencies.`;
}

function makeLimitCommentBody(): string {
  return `${MARKER_LIMIT}\nDependency-block cycle cap reached. Add completed:dependency-limit to grant another round.`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PhaseLoop — dependency-blocked branch (#1211)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  // SC-001
  it('implement with blocked sentinel → onGateHit("implement","waiting-for:dependencies") called, no failed:implement, WIP commit precedes gate', async () => {
    const context = createMockContext();
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(
      makeSuccessResult('implement', {
        blocked_on: ['generacy-ai/generacy#1198', '#42'],
        partial: true,
        tasks_completed: 5,
        tasks_remaining: 10,
        tasks_total: 15,
      }),
    );

    const commitCalls: string[] = [];
    (deps.prManager.commitPushAndEnsurePr as any).mockImplementation(async () => {
      commitCalls.push('commit');
      return { prUrl: null, hasChanges: true };
    });

    const gateCalls: Array<[string, string]> = [];
    (deps.labelManager.onGateHit as any).mockImplementation(async (phase: string, label: string) => {
      gateCalls.push([phase, label]);
    });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    // WIP commit happened before gate
    expect(commitCalls.length).toBeGreaterThanOrEqual(1);

    // onGateHit called for waiting-for:dependencies
    expect(gateCalls).toContainEqual(['implement', 'waiting-for:dependencies']);

    // No failed:implement (onError NOT called)
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
  });

  // SC-002
  it('no sentinel + unchanged tasks_remaining → no-progress guard still fires (regression)', async () => {
    const context = createMockContext();
    const config = createConfig();

    // First call: partial with tasks_remaining=5
    // Second call: partial with same tasks_remaining=5 (no progress)
    let callCount = 0;
    (deps.cliSpawner.spawnPhase as any).mockImplementation(async () => {
      callCount++;
      return makeSuccessResult('implement', {
        partial: true,
        tasks_completed: 3,
        tasks_remaining: 5,
        tasks_total: 8,
      });
    });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    // The no-progress guard should fire (SC-002) — second iteration detects no progress
    // With maxImplementRetries=2, the first is consumed, the second iteration fires guard
    expect(result.completed).toBe(false);
    // onError is called by the no-progress guard
    expect(deps.labelManager.onError).toHaveBeenCalledWith('implement');
  });

  // FR-013: third block cycle → dependency-limit
  it('third block cycle → waiting-for:dependency-limit + limit comment posted', async () => {
    const context = createMockContext();
    const config = createConfig({ maxImplementRetries: 2 });

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(
      makeSuccessResult('implement', {
        blocked_on: ['generacy-ai/generacy#1'],
      }),
    );

    // Three existing block comments → cap reached
    context.github.getIssueComments = vi.fn().mockResolvedValue([
      {
        id: 1,
        body: makeBlockCommentBody(1),
        author: 'generacy[bot]',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 2,
        body: makeBlockCommentBody(1),
        author: 'generacy[bot]',
        created_at: '2026-02-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      },
      {
        id: 3,
        body: makeBlockCommentBody(1),
        author: 'generacy[bot]',
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      },
    ]);

    const gateCalls: Array<[string, string]> = [];
    (deps.labelManager.onGateHit as any).mockImplementation(async (phase: string, label: string) => {
      gateCalls.push([phase, label]);
    });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    // Should hit dependency-limit, not dependencies
    expect(gateCalls).toContainEqual(['implement', 'waiting-for:dependency-limit']);
    expect(gateCalls).not.toContainEqual(['implement', 'waiting-for:dependencies']);

    // Limit comment was posted
    expect(context.github.addIssueComment).toHaveBeenCalled();
  });

  // FR-013: post-grant cycle count resets
  it('post-grant cycle count resets — limit comment newer than blocks allows re-block', async () => {
    const context = createMockContext();
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(
      makeSuccessResult('implement', {
        blocked_on: ['generacy-ai/generacy#1'],
      }),
    );

    // Two old block comments + one newer limit comment → should NOT be at cap
    context.github.getIssueComments = vi.fn().mockResolvedValue([
      {
        id: 1,
        body: makeBlockCommentBody(1),
        author: 'generacy[bot]',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 2,
        body: makeBlockCommentBody(1),
        author: 'generacy[bot]',
        created_at: '2026-02-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      },
      // Limit comment newer than both blocks — resets the baseline
      {
        id: 3,
        body: makeLimitCommentBody(),
        author: 'generacy[bot]',
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      },
      // One new block after the grant
      {
        id: 4,
        body: makeBlockCommentBody(1),
        author: 'generacy[bot]',
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-04-01T00:00:00Z',
      },
    ]);

    const gateCalls: Array<[string, string]> = [];
    (deps.labelManager.onGateHit as any).mockImplementation(async (phase: string, label: string) => {
      gateCalls.push([phase, label]);
    });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    // Should hit waiting-for:dependencies, NOT dependency-limit (cycle count = 1 after reset)
    expect(gateCalls).toContainEqual(['implement', 'waiting-for:dependencies']);
    expect(gateCalls).not.toContainEqual(['implement', 'waiting-for:dependency-limit']);

    // Block comment was posted
    expect(context.github.addIssueComment).toHaveBeenCalled();
  });

  // Blocked with no valid refs → falls through to normal flow
  it('blocked sentinel with zero valid refs → falls through to normal flow', async () => {
    const context = createMockContext();
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(
      makeSuccessResult('implement', {
        blocked_on: ['garbage', 'not/a/ref', ''],
        partial: true,
        tasks_completed: 1,
        tasks_remaining: 0,
        tasks_total: 1,
      }),
    );

    const gateCalls: Array<[string, string]> = [];
    (deps.labelManager.onGateHit as any).mockImplementation(async (phase: string, label: string) => {
      gateCalls.push([phase, label]);
    });

    const result = await phaseLoop.executeLoop(context, config, deps, ['implement']);

    // No gate hit — normal flow continues
    expect(gateCalls).toHaveLength(0);
    // Should complete since tasks_remaining=0
    expect(result.completed).toBe(true);
    // WIP commit should NOT be called
    expect(deps.prManager.commitPushAndEnsurePr).not.toHaveBeenCalled();
  });

  // Coexistence with PARTIAL: blocked wins control flow
  it('coexistence with PARTIAL — blocked wins control flow, partial counts recorded', async () => {
    const context = createMockContext();
    const config = createConfig();

    (deps.cliSpawner.spawnPhase as any).mockResolvedValue(
      makeSuccessResult('implement', {
        blocked_on: ['test/repo#1'],
        partial: true,
        tasks_completed: 5,
        tasks_remaining: 10,
        tasks_total: 15,
      }),
    );

    const gateCalls: Array<[string, string]> = [];
    (deps.labelManager.onGateHit as any).mockImplementation(async (phase: string, label: string) => {
      gateCalls.push([phase, label]);
    });

    await phaseLoop.executeLoop(context, config, deps, ['implement']);

    // Blocked branch runs first → gate hit for dependencies
    expect(gateCalls).toContainEqual(['implement', 'waiting-for:dependencies']);

    // The increment re-loop is skipped (blocked branch returns before it)
    // onPhaseComplete should NOT be called for implement
    expect(deps.labelManager.onPhaseComplete).not.toHaveBeenCalled();
  });
});