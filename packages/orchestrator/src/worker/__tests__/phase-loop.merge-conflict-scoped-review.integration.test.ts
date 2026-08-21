/**
 * #1131 T015 (SC-001 / SC-004) — merge-conflict re-arm → scoped review → validate.
 *
 * After `MergeConflictHandler` resolves a conflict it re-arms into `review`
 * with a `reviewScope` (see merge-conflict-handler.rearm.test.ts). The worker
 * builds a `WorkerContext` with `startPhase: 'review'` and that `reviewScope`
 * on it (see the claude-cli-worker wiring, T008/T009). This test drives
 * `PhaseLoop.executeLoop` from exactly that world and asserts the full
 * traversal:
 *
 *   - the loop starts at `review` (not the interrupted phase);
 *   - a CLEAN verdict advances into `validate` — the resolution is NOT allowed
 *     to bypass validation and sail straight to ready/merge (SC-004);
 *   - the run completes.
 *
 * The verdict is steered via `readFindingsArtifact` (clean) — the same lever as
 * the #1127 integration suite — so no real review logic runs here. The
 * scoped-executor window logic itself is unit-tested in review-executor.test.ts.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import { ReviewPoster } from '../review-poster.js';
import type { FindingsArtifact } from '../review-findings-artifact.js';
import type { ReviewArtifact, Severity } from '../review-artifact.js';
import {
  bumpRemediationCount,
  readReviewArtifactSync,
  writeReviewArtifact,
} from '../review-artifact.js';
import type { GitHubClient, Review } from '@generacy-ai/workflow-engine';

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

function createGithubSpy(): GitHubClient {
  return {
    listReviews: vi.fn(async () => [] as Review[]),
    listPullRequestFiles: vi.fn(async () => []),
    getPRReviewThreads: vi.fn(async () => []),
    resolveReviewThread: vi.fn(async () => undefined),
    createReview: vi.fn(async (): Promise<Review> => ({
      id: 1,
      user: { login: 'generacy[bot]' },
      body: '',
      state: 'COMMENTED',
      submittedAt: new Date().toISOString(),
    })),
  } as unknown as GitHubClient;
}

function createMockDeps(github: GitHubClient): PhaseLoopDeps {
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
      spawnPhase: vi.fn().mockImplementation(async (phase: WorkflowPhase) => makeSuccessResult(phase)),
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
      getPrNumber: vi.fn().mockReturnValue(42),
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
    reviewPoster: new ReviewPoster({
      github,
      owner: 'test',
      repo: 'repo',
      getPrNumber: () => 42,
      logger: mockLogger,
    }),
  };
}

/** A context shaped exactly as the worker builds it after a merge-conflict re-arm. */
function createResumedContext(
  workflowName: string,
  reviewScope: { baseSha: string; headSha: string },
): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 1131,
      workflowName,
    } as any,
    startPhase: 'review',
    resumeReason: 'merge-conflict-resolved',
    reviewScope,
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/test/repo/issues/1131',
    description: 'test',
  } as WorkerContext;
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
    reviewPhaseEnabled: true,
    ...overrides,
  } as WorkerConfig;
}

function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

function cleanArtifact(): FindingsArtifact {
  return {
    verdict: 'clean',
    findings: [{ marker: 'f-adv-1', text: 'nit', severity: 'advisory' }],
  };
}

describe('#1131 T015 — merge-conflict re-arm → scoped review → validate (SC-001/SC-004)', () => {
  let phaseLoop: PhaseLoop;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
  });

  for (const workflow of ['speckit-feature', 'speckit-bugfix'] as const) {
    it(`starts at review and lands in validate on a clean verdict (${workflow})`, async () => {
      const github = createGithubSpy();
      const deps = createMockDeps(github);
      deps.readFindingsArtifact = vi.fn().mockResolvedValue({ artifact: cleanArtifact(), round: 1 });
      const context = createResumedContext(workflow, { baseSha: 'base123', headSha: 'head456' });
      const config = createConfig();
      const sequence = getPhaseSequence(workflow, true) as WorkflowPhase[];

      const result = await phaseLoop.executeLoop(context, config, deps, sequence);

      expect(result.completed).toBe(true);

      const order = phaseStartOrder(deps);
      // SC-001: the resumed run begins at review — NOT the interrupted phase —
      // and no earlier phase (implement/tasks/…) is re-entered.
      expect(order[0]).toBe('review');
      expect(order).not.toContain('implement');
      // SC-004: the clean resolution review advances THROUGH validate. The
      // resolution is never allowed to bypass validation to ready/merge.
      expect(order).toEqual(['review', 'validate']);
    });
  }

  it('does not bypass validate: markReadyForReview fires but the loop still runs validate (SC-004)', async () => {
    const github = createGithubSpy();
    const deps = createMockDeps(github);
    deps.readFindingsArtifact = vi.fn().mockResolvedValue({ artifact: cleanArtifact(), round: 1 });
    const context = createResumedContext('speckit-feature', { baseSha: 'base123', headSha: 'head456' });
    const config = createConfig();
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    // Clean verdict marks the PR ready, but validation still runs afterward.
    expect(deps.prManager.markReadyForReview).toHaveBeenCalledTimes(1);
    expect(phaseStartOrder(deps)).toContain('validate');
  });
});

/**
 * #1164 T009 (SC-001 / FR-002) — scoped-review remediation converges.
 *
 * Defect 1: a merge-conflict re-arm pins `context.reviewScope`, and the
 * review executor used to honour that scope on EVERY round. A scoped round-1
 * `changes-required` → remediation commit that fixes the defect → round-2
 * review still pinned to the pre-remediation window → the fix is invisible →
 * the same finding re-reports until the remediation cap fires, with the defect
 * actually fixed. The FR-001 fix (`review-executor.ts`) reads `priorRound`
 * before the scope branch and only honours `reviewScope` on round 1; round 2+
 * falls back to the standard #1126 `lastReviewedCommitSha`..HEAD delta that
 * spans the remediation commits.
 *
 * The real-git round-2 window/SHA logic is unit-tested in
 * `review-executor.test.ts` (`#1131 resolution-scoped diff window`). This test
 * proves the LOOP-level consequence of the fix: from a scoped re-arm, a
 * `changes-required` → `clean` verdict sequence advances THROUGH `review` into
 * `validate` and never trips the `on-remediation-limit` cap gate. The verdict
 * is scripted via a stand-in review executor that writes the sidecar per round
 * (same lever as the #1132 convergence suite) so no real review logic runs.
 */
describe('#1164 T009 — scoped-review remediation converges (SC-001/FR-002)', () => {
  let checkoutPath: string;
  let phaseLoop: PhaseLoop;

  const WORKFLOW_ID = 'test/repo#1164';
  type Verdict = 'clean' | 'changes-required';

  /** A review executor that writes the sidecar per round from a verdict script. */
  function makeScriptedReviewExecutor(dir: string, verdicts: Verdict[]) {
    let call = 0;
    const execute = vi.fn(async (): Promise<PhaseResult> => {
      const prior = readReviewArtifactSync(dir, WORKFLOW_ID);
      const round = (prior?.round ?? 0) + 1;
      const verdict = verdicts[Math.min(call, verdicts.length - 1)]!;
      call++;
      const findings =
        verdict === 'changes-required'
          ? [
              {
                severity: 'critical' as const,
                file: 'src/a.ts',
                title: 'blocking finding',
                detail: 'must fix',
                round,
                status: 'open' as const,
              },
            ]
          : [];
      await writeReviewArtifact(dir, WORKFLOW_ID, {
        findings,
        verdict,
        round,
        lastReviewedCommitSha: `sha${round}`,
        remediationCount: prior?.remediationCount ?? 0,
      } as ReviewArtifact);
      return makeSuccessResult('review');
    });
    return { execute };
  }

  /** Reader seam mirroring the #1132 convergence suite shape. */
  function makeFindingsReader(dir: string) {
    return vi.fn(
      async (): Promise<{ artifact: ReviewArtifact; blockingSeverity: Severity } | null> => {
        const ra = readReviewArtifactSync(dir, WORKFLOW_ID);
        if (!ra) return null;
        return { artifact: ra, blockingSeverity: 'critical' };
      },
    );
  }

  /** Convergence-style deps: `checkGates` honours `config.gates`; cap gate armed. */
  function makeDeps(github: GitHubClient): PhaseLoopDeps {
    return {
      labelManager: {
        onPhaseStart: vi.fn().mockResolvedValue(undefined),
        onPhaseComplete: vi.fn().mockResolvedValue(undefined),
        onError: vi.fn().mockResolvedValue(undefined),
        onGateHit: vi.fn().mockResolvedValue(undefined),
        onRepeatedError: vi.fn().mockResolvedValue(undefined),
      } as any,
      stageCommentManager: {
        updateStageComment: vi.fn().mockResolvedValue(undefined),
        postFailureAlert: vi.fn().mockResolvedValue(undefined),
      } as any,
      gateChecker: {
        checkGates: vi.fn(
          (phase: WorkflowPhase, workflowName: string, cfg: WorkerConfig) =>
            (cfg.gates?.[workflowName] ?? []).filter((g: any) => g.phase === phase),
        ),
      } as any,
      cliSpawner: {
        spawnPhase: vi
          .fn()
          .mockImplementation(async (phase: WorkflowPhase) => makeSuccessResult(phase)),
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
        convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
        markReadyForReview: vi.fn().mockResolvedValue(undefined),
      } as any,
      reviewPoster: {
        postRound: vi.fn().mockResolvedValue(undefined),
        resolveResolvedThreads: vi.fn().mockResolvedValue(undefined),
      } as any,
    };
  }

  /** A resumed context shaped by the merge-conflict re-arm — carries `reviewScope`. */
  function makeScopedContext(workflowName: string, dir: string): WorkerContext {
    return {
      workerId: 'test-worker',
      item: {
        owner: 'test',
        repo: 'repo',
        issueNumber: 1164,
        workflowName,
      } as any,
      startPhase: 'review',
      resumeReason: 'merge-conflict-resolved',
      reviewScope: { baseSha: 'base123', headSha: 'head456', conflictedPaths: ['src/a.ts'] },
      github: {
        getDefaultBranch: vi.fn().mockResolvedValue('develop'),
        getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
        getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
        getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['src/a.ts']),
        getFilesChangedBetween: vi.fn().mockResolvedValue(['src/a.ts']),
        commitExistsInCheckout: vi.fn().mockResolvedValue(true),
        getIssue: vi.fn().mockResolvedValue({ labels: [], state: 'open' }),
      } as any,
      logger: mockLogger,
      signal: new AbortController().signal,
      checkoutPath: dir,
      issueUrl: 'https://github.com/test/repo/issues/1164',
      description: 'test',
    } as WorkerContext;
  }

  /** Config with the remediation-limit cap gate armed for both workflows. */
  function makeConfig(): WorkerConfig {
    const capGate = {
      phase: 'review',
      gateLabel: 'waiting-for:remediation-limit',
      condition: 'on-remediation-limit',
    };
    return {
      phaseTimeoutMs: 600_000,
      workspaceDir: '/tmp',
      shutdownGracePeriodMs: 5000,
      validateCommand: 'pnpm test && pnpm build',
      preValidateCommand: '',
      gates: { 'speckit-feature': [capGate], 'speckit-bugfix': [capGate] },
      maxImplementRetries: 0,
      reviewPhaseEnabled: true,
    } as unknown as WorkerConfig;
  }

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phaseloop-1164-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  for (const workflow of ['speckit-feature', 'speckit-bugfix'] as const) {
    it(`converges review→remediate→review→validate without tripping the cap (${workflow})`, async () => {
      const github = createGithubSpy();
      const deps = makeDeps(github);
      deps.reviewExecutor = makeScriptedReviewExecutor(checkoutPath, [
        'changes-required',
        'clean',
      ]) as any;
      const remediateExecute = vi.fn(async (): Promise<PhaseResult> => {
        await bumpRemediationCount(checkoutPath, WORKFLOW_ID);
        return makeSuccessResult('remediate');
      });
      deps.remediateExecutor = { execute: remediateExecute } as any;
      deps.remediateTrigger = (ctx) =>
        readReviewArtifactSync(ctx.checkoutPath, WORKFLOW_ID)?.verdict === 'changes-required';
      deps.readFindingsArtifact = makeFindingsReader(checkoutPath);

      const context = makeScopedContext(workflow, checkoutPath);
      const config = makeConfig();
      const sequence = getPhaseSequence(workflow, true) as WorkflowPhase[];

      const result = await phaseLoop.executeLoop(context, config, deps, sequence);

      expect(result.completed).toBe(true);
      expect(result.gateHit).toBe(false);

      // SC-001/FR-002: one remediation cycle, then a clean re-review advances
      // into validate — the loop is NOT starved into the remediation cap.
      expect(phaseStartOrder(deps)).toEqual(['review', 'remediate', 'review', 'validate']);
      expect(remediateExecute).toHaveBeenCalledTimes(1);

      const finalArtifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
      expect(finalArtifact?.remediationCount).toBe(1);
      expect(finalArtifact?.round).toBe(2);
      expect(finalArtifact?.verdict).toBe('clean');

      // The remediation-cap gate must never fire on a converging loop.
      expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
    });
  }
});
