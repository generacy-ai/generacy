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

    // #914 T005 — implement phase — single merge (symmetry case per Q5-B).
    // Guards against a future edit that mirrors a "pre-install-for-implement"
    // hook and reintroduces a double-merge shape on the committed-merge path.
    it('implement — single merge (symmetry case per Q5-B)', async () => {
      const events: string[] = [];
      const runner: BaseMergeRunner = async (_c, _b, baseRef) => {
        events.push('base-merge');
        return { ok: true, baseRef, mergeSha: 'abc123' };
      };
      const deps = createMockDeps(runner);
      (deps.cliSpawner.spawnPhase as any) = vi.fn(async () => {
        events.push('implement-spawn');
        return makeSuccessResult('implement');
      });
      const context = createMockContext('implement');

      await loop.executeLoop(context, createConfig(), deps, ['implement']);

      const baseMergeCount = events.filter((e) => e === 'base-merge').length;
      expect(baseMergeCount).toBe(1);
      expect(events).toEqual(['base-merge', 'implement-spawn']);
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
      // #898 Ship 1: mergeConflict now carries `manualRemedy` too.
      expect(mergeConflictCall[0].errorEvidence.mergeConflict.baseRef).toBe('origin/main');
      expect(mergeConflictCall[0].errorEvidence.mergeConflict.conflictedPaths).toEqual([
        'CLAUDE.md',
        'package.json',
        'package-lock.json',
      ]);

      // Stage comment status is in_progress (a pause, not an error)
      expect(mergeConflictCall[0].status).toBe('in_progress');

      // No CLI spawn happened (pause fired before phase execution)
      expect(deps.cliSpawner.spawnPhase).not.toHaveBeenCalled();
    });

    // #898 T005 — Ship 1: self-describing pause remedy carried in the payload.
    it('includes manualRemedy with substituted branch/base/issue-ref (FR-011/FR-012)', async () => {
      const { runner } = makeFakeRunner([
        {
          ok: false,
          baseRef: 'origin/develop',
          conflictedPaths: ['CLAUDE.md', 'src/foo.ts'],
        },
      ]);
      const deps = createMockDeps(runner);
      const context = createMockContext('implement');

      const result = await loop.executeLoop(context, createConfig(), deps, ['implement']);

      expect(result.gateHit).toBe(true);

      const updateCalls = (deps.stageCommentManager.updateStageComment as any).mock.calls;
      const mergeConflictCall = updateCalls.find(
        (c: any[]) =>
          c[0]?.errorEvidence &&
          'mergeConflict' in c[0].errorEvidence,
      );
      expect(mergeConflictCall).toBeDefined();
      const evidence = mergeConflictCall[0].errorEvidence.mergeConflict;

      expect(evidence.conflictedPaths).toEqual(['CLAUDE.md', 'src/foo.ts']);
      expect(evidence.manualRemedy).toBeDefined();
      expect(evidence.manualRemedy.steps).toHaveLength(3);

      // Step 1: <branch> and <base> substituted
      expect(evidence.manualRemedy.steps[0]).toContain('864-found-during-cockpit-v1');
      expect(evidence.manualRemedy.steps[0]).toContain('origin/develop');
      // Step 2: contains generacy cockpit advance and --gate merge-conflicts
      expect(evidence.manualRemedy.steps[1]).toContain('generacy cockpit advance');
      expect(evidence.manualRemedy.steps[1]).toContain('--gate merge-conflicts');
      // Step 3: mentions re-runs
      expect(evidence.manualRemedy.steps[2]).toContain('re-runs');

      // Warning contains re-pause substring
      expect(evidence.manualRemedy.warning).toContain('re-pause');
    });

    // #898 T005 SC-005 — advance-without-resolve → re-pause preserves paths.
    it('re-pause on second run also names the conflicted paths (SC-005)', async () => {
      // Runner returns the same conflict twice — simulates advance-without-
      // resolve: operator ran `cockpit advance` without fixing the branch,
      // phase re-ran, pre-merge re-hit the same conflict.
      const conflictedPaths = ['CLAUDE.md'];
      const { runner } = makeFakeRunner([
        { ok: false, baseRef: 'origin/main', conflictedPaths },
        { ok: false, baseRef: 'origin/main', conflictedPaths },
      ]);
      const deps = createMockDeps(runner);
      const context = createMockContext('implement');

      // First pause
      await loop.executeLoop(context, createConfig(), deps, ['implement']);
      // Second pause (advance-without-resolve replay)
      await loop.executeLoop(context, createConfig(), deps, ['implement']);

      const updateCalls = (deps.stageCommentManager.updateStageComment as any).mock.calls;
      const mergeConflictCalls = updateCalls.filter(
        (c: any[]) =>
          c[0]?.errorEvidence && 'mergeConflict' in c[0].errorEvidence,
      );
      expect(mergeConflictCalls.length).toBeGreaterThanOrEqual(2);

      const first = mergeConflictCalls[0][0].errorEvidence.mergeConflict;
      const second = mergeConflictCalls[mergeConflictCalls.length - 1][0].errorEvidence.mergeConflict;
      expect(first.conflictedPaths).toEqual(conflictedPaths);
      expect(second.conflictedPaths).toEqual(conflictedPaths);
      // Both pauses carry a manualRemedy — the pause is self-describing on
      // every re-run, not only the first.
      expect(first.manualRemedy).toBeDefined();
      expect(second.manualRemedy).toBeDefined();
    });
  });

  describe('validate — clean merge (pre-validate and validate)', () => {
    it('passes { commit: false } on the single validate-cycle merge', async () => {
      // #914 flipped this from asserting 2 calls (buggy) to 1 call. The
      // ephemeral discriminant `commit: false` is the load-bearing part —
      // it distinguishes the validate cycle from implement's committed merge.
      const { runner, calls } = makeFakeRunner([
        { ok: true, baseRef: 'origin/main' },
      ]);
      const deps = createMockDeps(runner);
      const context = createMockContext('validate');

      await loop.executeLoop(context, createConfig(), deps, ['validate']);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.commit).toBe(false);
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

    it('runs a single base-merge before the pre-validate install', async () => {
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
      expect(baseMergeCount).toBe(1);
      // Event order: [base-merge, install, validate] — one merge, then both
      // commands run against the same merged tree.
      expect(events).toEqual(['base-merge', 'pre-validate-install', 'validate-cmd']);
    });

    // #914 T002 — install artifacts survive to validate (SC-001).
    // Reproduces snappoll#4 at unit scope: a second base-merge between
    // install and validate would `git clean -fd` the install output. The
    // fix guarantees at most one merge per cycle, so the install marker
    // survives into the validate step.
    it('install artifacts survive to validate', async () => {
      let installArtifactPresent = false;
      let validateSawInstallArtifact: boolean | undefined;
      const events: string[] = [];
      const runner: BaseMergeRunner = async (_c, _b, baseRef) => {
        events.push('base-merge');
        // Simulate `git reset --hard origin/<branch>` + `git clean -fd`
        // discarding untracked install output.
        installArtifactPresent = false;
        return { ok: true, baseRef };
      };
      const deps = createMockDeps(runner);
      (deps.cliSpawner.runPreValidateInstall as any) = vi.fn(async () => {
        events.push('pre-validate-install');
        installArtifactPresent = true;
        return makeSuccessResult('validate');
      });
      (deps.cliSpawner.runValidatePhase as any) = vi.fn(async () => {
        events.push('validate-cmd');
        validateSawInstallArtifact = installArtifactPresent;
        return makeSuccessResult('validate');
      });
      const context = createMockContext('validate');

      const result = await loop.executeLoop(context, createConfig(), deps, ['validate']);

      expect(result.completed).toBe(true);
      // The load-bearing assertion — validate must see the install output.
      expect(validateSawInstallArtifact).toBe(true);
      const baseMergeCount = events.filter((e) => e === 'base-merge').length;
      expect(baseMergeCount).toBe(1);
      expect(events).toEqual(['base-merge', 'pre-validate-install', 'validate-cmd']);
    });

    // #914 T003 — up-to-date branch: single merge, unchanged behavior (FR-003).
    it('up-to-date branch — single merge, unchanged behavior', async () => {
      const { runner, calls } = makeFakeRunner([
        { ok: true, baseRef: 'origin/main' },
      ]);
      const deps = createMockDeps(runner);
      const installFake = vi.fn(async () => makeSuccessResult('validate'));
      const validateFake = vi.fn(async () => makeSuccessResult('validate'));
      (deps.cliSpawner.runPreValidateInstall as any) = installFake;
      (deps.cliSpawner.runValidatePhase as any) = validateFake;
      const context = createMockContext('validate');

      await loop.executeLoop(context, createConfig(), deps, ['validate']);

      expect(calls).toHaveLength(1);
      expect(installFake).toHaveBeenCalledTimes(1);
      expect(validateFake).toHaveBeenCalledTimes(1);
    });

    // #914 T004 — retry re-runs install AND merge (clarification Q3-A).
    // A same-phase retry is a new for-loop iteration, so the per-iteration
    // `hasBaseMergedThisCycle` guard re-initializes and the merge fires again.
    // Simulated here by driving the loop with `['validate', 'validate']` —
    // each iteration is an independent cycle and should merge exactly once.
    it('retry re-runs install AND merge', async () => {
      const events: string[] = [];
      const runner: BaseMergeRunner = async (_c, _b, baseRef) => {
        events.push('base-merge');
        return { ok: true, baseRef };
      };
      const deps = createMockDeps(runner);
      const installFake = vi.fn(async () => {
        events.push('pre-validate-install');
        return makeSuccessResult('validate');
      });
      const validateFake = vi.fn(async () => {
        events.push('validate-cmd');
        return makeSuccessResult('validate');
      });
      (deps.cliSpawner.runPreValidateInstall as any) = installFake;
      (deps.cliSpawner.runValidatePhase as any) = validateFake;
      const context = createMockContext('validate');

      await loop.executeLoop(context, createConfig(), deps, ['validate', 'validate']);

      const baseMergeCount = events.filter((e) => e === 'base-merge').length;
      expect(baseMergeCount).toBe(2);
      expect(installFake).toHaveBeenCalledTimes(2);
      // Each attempt travels [merge, install, validate] together — the
      // guard resets on iteration boundary, not on the whole loop.
      expect(events).toEqual([
        'base-merge', 'pre-validate-install', 'validate-cmd',
        'base-merge', 'pre-validate-install', 'validate-cmd',
      ]);
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

    // #914 deleted the "conflict in validate (second call, post pre-validate)
    // still pauses" test — its premise (a second base-merge call between
    // install and validate) no longer exists. The only pre-phase merge fires
    // before install, so the "conflict in pre-validate pauses" case above is
    // the sole conflict-in-validate scenario.
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
