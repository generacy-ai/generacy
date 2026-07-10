/**
 * Integration tests for the pre-phase base-merge hook in PhaseLoop (#864).
 *
 * Covers:
 * - clean merge → phase proceeds (implement / pre-validate / validate)
 * - conflict → waiting-for:merge-conflicts pause with errorEvidence.mergeConflict
 * - hook ordering (base-merge fires BEFORE the phase's own command)
 * - discriminant: implement uses { commit: true }, validate uses { commit: false }
 * - no PR fallback: resolveBaseBranch → default branch → runner still invoked
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { BaseMergeResult, BaseMergeRunner } from '../base-merge.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return {
    phase,
    success: true,
    exitCode: 0,
    durationMs: 100,
    output: [],
  };
}

function createMockDeps(baseMergeRunner?: BaseMergeRunner): PhaseLoopDeps {
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
      getPrNumber: vi.fn().mockReturnValue(1),
    } as any,
    baseMergeRunner,
  };
}

function createMockContext(startPhase: WorkflowPhase = 'implement'): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'job-1',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 864,
      workflowName: 'speckit-feature',
    } as any,
    startPhase,
    github: {
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'main' } }),
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      // Product-diff post-implement checks a non-spec file exists.
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    branch: '864-found-during-cockpit-v1',
    issueUrl: 'https://github.com/test/repo/issues/864',
    description: 'test',
  };
}

function createConfig(): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    phaseTimeoutOverrides: {},
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'echo validate',
    preValidateCommand: 'echo pre',
    maxImplementRetries: 2,
    gates: {
      'speckit-feature': [
        { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' },
      ],
    },
  } as WorkerConfig;
}

// A fake BaseMergeRunner factory. Records call args + returns canned results.
function makeFakeRunner(results: BaseMergeResult[]): {
  runner: BaseMergeRunner;
  calls: Array<{ checkoutPath: string; branch: string; baseRef: string; commit: boolean }>;
} {
  const calls: Array<{ checkoutPath: string; branch: string; baseRef: string; commit: boolean }> = [];
  let idx = 0;
  const runner: BaseMergeRunner = async (checkoutPath, branch, baseRef, opts) => {
    calls.push({ checkoutPath, branch, baseRef, commit: opts.commit });
    const r = results[idx] ?? results[results.length - 1] ?? { ok: true, baseRef };
    idx++;
    return r;
  };
  return { runner, calls };
}

describe('PhaseLoop pre-phase base-merge (#864)', () => {
  let loop: PhaseLoop;
  beforeEach(() => {
    loop = new PhaseLoop(mockLogger);
  });

  describe('implement — clean merge', () => {
    it('proceeds with implement phase after clean merge and passes { commit: true } to runner', async () => {
      const { runner, calls } = makeFakeRunner([
        { ok: true, baseRef: 'origin/main', mergeSha: 'abc123' },
      ]);
      const deps = createMockDeps(runner);
      const context = createMockContext('implement');
      const config = createConfig();

      // Skip validate for this test — only test implement
      const result = await loop.executeLoop(context, config, deps, ['implement']);

      expect(deps.cliSpawner.spawnPhase).toHaveBeenCalled();
      expect(result.completed).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        checkoutPath: '/tmp/repo',
        branch: '864-found-during-cockpit-v1',
        baseRef: 'origin/main',
        commit: true,
      });
    });

    it('runs base-merge BEFORE the implement CLI spawn (hook ordering)', async () => {
      const events: string[] = [];
      const runner: BaseMergeRunner = async (_c, _b, baseRef) => {
        events.push('base-merge');
        return { ok: true, baseRef };
      };
      const deps = createMockDeps(runner);
      (deps.cliSpawner.spawnPhase as any) = vi.fn(async () => {
        events.push('cli-spawn');
        return makeSuccessResult('implement');
      });
      const context = createMockContext('implement');

      await loop.executeLoop(context, createConfig(), deps, ['implement']);

      expect(events.indexOf('base-merge')).toBeLessThan(events.indexOf('cli-spawn'));
    });
  });

  describe('implement — conflict', () => {
    it('pauses with waiting-for:merge-conflicts, populates errorEvidence.mergeConflict, gateHit=true', async () => {
      const { runner } = makeFakeRunner([
        {
          ok: false,
          baseRef: 'origin/main',
          conflictedPaths: ['CLAUDE.md', 'package.json', 'package-lock.json'],
        },
      ]);
      const deps = createMockDeps(runner);
      const context = createMockContext('implement');

      const result = await loop.executeLoop(context, createConfig(), deps, ['implement']);

      expect(result.gateHit).toBe(true);
      expect(result.completed).toBe(false);
      expect(result.lastPhase).toBe('implement');

      // waiting-for:merge-conflicts applied
      expect(deps.labelManager.onGateHit).toHaveBeenCalledWith(
        'implement',
        'waiting-for:merge-conflicts',
      );

      // Stage comment updated with mergeConflict evidence
      const updateCalls = (deps.stageCommentManager.updateStageComment as any).mock.calls;
      const mergeConflictCall = updateCalls.find(
        (c: any[]) =>
          c[0]?.errorEvidence &&
          'mergeConflict' in c[0].errorEvidence,
      );
      expect(mergeConflictCall).toBeDefined();
      expect(mergeConflictCall[0].errorEvidence.mergeConflict).toEqual({
        baseRef: 'origin/main',
        conflictedPaths: ['CLAUDE.md', 'package.json', 'package-lock.json'],
      });

      // Stage comment status is in_progress (a pause, not an error)
      expect(mergeConflictCall[0].status).toBe('in_progress');

      // No CLI spawn happened (pause fired before phase execution)
      expect(deps.cliSpawner.spawnPhase).not.toHaveBeenCalled();
    });
  });

  describe('validate — clean merge (pre-validate and validate)', () => {
    it('passes { commit: false } on both pre-validate and validate runs', async () => {
      const { runner, calls } = makeFakeRunner([
        { ok: true, baseRef: 'origin/main' },
        { ok: true, baseRef: 'origin/main' },
      ]);
      const deps = createMockDeps(runner);
      const context = createMockContext('validate');

      await loop.executeLoop(context, createConfig(), deps, ['validate']);

      expect(calls).toHaveLength(2);
      expect(calls[0]!.commit).toBe(false);
      expect(calls[1]!.commit).toBe(false);
    });

    it('runs pre-validate base-merge BEFORE pre-validate install', async () => {
      const events: string[] = [];
      const runner: BaseMergeRunner = async (_c, _b, baseRef) => {
        events.push('base-merge');
        return { ok: true, baseRef };
      };
      const deps = createMockDeps(runner);
      (deps.cliSpawner.runPreValidateInstall as any) = vi.fn(async () => {
        events.push('pre-validate-install');
        return makeSuccessResult('validate');
      });
      (deps.cliSpawner.runValidatePhase as any) = vi.fn(async () => {
        events.push('validate-cmd');
        return makeSuccessResult('validate');
      });
      const context = createMockContext('validate');

      await loop.executeLoop(context, createConfig(), deps, ['validate']);

      const preValidateInstallIdx = events.indexOf('pre-validate-install');
      const firstBaseMergeIdx = events.indexOf('base-merge');
      expect(firstBaseMergeIdx).toBeGreaterThanOrEqual(0);
      expect(firstBaseMergeIdx).toBeLessThan(preValidateInstallIdx);
    });

    it('runs a second base-merge before the validate command itself', async () => {
      const events: string[] = [];
      const runner: BaseMergeRunner = async (_c, _b, baseRef) => {
        events.push('base-merge');
        return { ok: true, baseRef };
      };
      const deps = createMockDeps(runner);
      (deps.cliSpawner.runPreValidateInstall as any) = vi.fn(async () => {
        events.push('pre-validate-install');
        return makeSuccessResult('validate');
      });
      (deps.cliSpawner.runValidatePhase as any) = vi.fn(async () => {
        events.push('validate-cmd');
        return makeSuccessResult('validate');
      });
      const context = createMockContext('validate');

      await loop.executeLoop(context, createConfig(), deps, ['validate']);

      const baseMergeCount = events.filter((e) => e === 'base-merge').length;
      expect(baseMergeCount).toBe(2);
      const lastBaseMergeIdx = events.lastIndexOf('base-merge');
      const validateIdx = events.indexOf('validate-cmd');
      expect(lastBaseMergeIdx).toBeLessThan(validateIdx);
      expect(lastBaseMergeIdx).toBeGreaterThan(events.indexOf('pre-validate-install'));
    });
  });

  describe('validate — conflict', () => {
    it('conflict in pre-validate pauses with waiting-for:merge-conflicts', async () => {
      const { runner } = makeFakeRunner([
        { ok: false, baseRef: 'origin/main', conflictedPaths: ['test.ts'] },
      ]);
      const deps = createMockDeps(runner);
      const context = createMockContext('validate');

      const result = await loop.executeLoop(context, createConfig(), deps, ['validate']);

      expect(result.gateHit).toBe(true);
      expect(deps.labelManager.onGateHit).toHaveBeenCalledWith(
        'validate',
        'waiting-for:merge-conflicts',
      );
      // Pre-validate install never ran (paused first)
      expect(deps.cliSpawner.runPreValidateInstall).not.toHaveBeenCalled();
    });

    it('conflict in validate (second call, post pre-validate) still pauses', async () => {
      const { runner } = makeFakeRunner([
        { ok: true, baseRef: 'origin/main' }, // pre-validate: clean
        { ok: false, baseRef: 'origin/main', conflictedPaths: ['x.ts'] }, // validate: conflict
      ]);
      const deps = createMockDeps(runner);
      const context = createMockContext('validate');

      const result = await loop.executeLoop(context, createConfig(), deps, ['validate']);

      expect(result.gateHit).toBe(true);
      expect(deps.labelManager.onGateHit).toHaveBeenCalledWith(
        'validate',
        'waiting-for:merge-conflicts',
      );
      // Pre-validate install DID run (pre-validate merge was clean)
      expect(deps.cliSpawner.runPreValidateInstall).toHaveBeenCalled();
      // Validate command DID NOT run (paused before it)
      expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
    });
  });

  describe('resolveBaseBranch fallback', () => {
    it('when no PR exists, base ref falls back to origin/<default> and runner is still invoked', async () => {
      const { runner, calls } = makeFakeRunner([
        { ok: true, baseRef: 'origin/develop' },
      ]);
      const deps = createMockDeps(runner);
      (deps.prManager.getPrNumber as any) = vi.fn().mockReturnValue(undefined);
      const context = createMockContext('implement');
      (context.github.getPullRequest as any) = vi.fn();

      await loop.executeLoop(context, createConfig(), deps, ['implement']);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.baseRef).toBe('origin/develop');
      expect(context.github.getPullRequest).not.toHaveBeenCalled();
      expect(context.github.getDefaultBranch).toHaveBeenCalled();
    });
  });

  // FR-005 (#889): pre-existing repo without waiting-for:merge-conflicts must
  // still pause successfully — the LabelManager's memoized ensure-pass creates
  // the missing label just before addLabels fires. Uses a real LabelManager
  // wired to a fake GitHubClient rather than the vi.fn() mock deps above.
  describe('pre-existing repo without waiting-for:merge-conflicts label (FR-005)', () => {
    it('creates the missing label and pauses successfully', async () => {
      const { LabelManager } = await import('../label-manager.js');
      const { WORKFLOW_LABELS } = await import('@generacy-ai/workflow-engine');

      LabelManager.resetEnsureCacheForTests();

      const calls: string[] = [];
      const existingLabels = WORKFLOW_LABELS.filter(
        (l) => l.name !== 'waiting-for:merge-conflicts',
      );
      const fakeGithub = {
        getIssue: vi.fn().mockImplementation(async () => {
          calls.push('getIssue');
          return { labels: [] };
        }),
        listLabels: vi.fn().mockImplementation(async () => {
          calls.push('listLabels');
          return existingLabels;
        }),
        createLabel: vi.fn().mockImplementation(async (_o, _r, name) => {
          calls.push(`createLabel:${name}`);
        }),
        addLabels: vi.fn().mockImplementation(async (_o, _r, _i, labels) => {
          calls.push(`addLabels:${labels.join(',')}`);
        }),
        removeLabels: vi.fn().mockImplementation(async () => {
          calls.push('removeLabels');
        }),
      };

      const lm = new LabelManager(
        fakeGithub as any,
        'test',
        'repo',
        864,
        mockLogger,
      );

      // Runner reports a conflict → phase-loop calls onGateHit(implement, waiting-for:merge-conflicts)
      const { runner } = makeFakeRunner([
        {
          ok: false,
          baseRef: 'origin/main',
          conflictedPaths: ['CLAUDE.md'],
        },
      ]);
      const deps = createMockDeps(runner);
      deps.labelManager = lm as any;
      const context = createMockContext('implement');

      const result = await loop.executeLoop(context, createConfig(), deps, ['implement']);

      expect(result.gateHit).toBe(true);

      // Sequence assertion — listLabels → createLabel('waiting-for:merge-conflicts', ...) → addLabels([waiting-for:merge-conflicts, agent:paused])
      const listIdx = calls.indexOf('listLabels');
      const createIdx = calls.indexOf('createLabel:waiting-for:merge-conflicts');
      const addIdx = calls.findIndex((c) => c.startsWith('addLabels:waiting-for:merge-conflicts'));

      expect(listIdx).toBeGreaterThanOrEqual(0);
      expect(createIdx).toBeGreaterThan(listIdx);
      expect(addIdx).toBeGreaterThan(createIdx);
    });
  });
});
