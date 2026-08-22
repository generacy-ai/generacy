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
import { execFileSync } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import { ReviewPoster } from '../review-poster.js';
import type { ReviewArtifact, Severity } from '../review-artifact.js';
import {
  bumpRemediationCount,
  deriveFindingId,
  readReviewArtifactSync,
  writeReviewArtifact,
} from '../review-artifact.js';
import type { GitHubClient, Review } from '@generacy-ai/workflow-engine';
import {
  createReviewCompositionHarness,
  type ReviewCompositionHarness,
} from './helpers/review-composition-harness.js';

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

function cleanArtifact(): ReviewArtifact {
  // Canonical #1161 shape; a `minor` finding is below the `critical` blocking
  // severity the reader pairs it with, so it renders as advisory.
  return {
    verdict: 'clean',
    findings: [
      { id: 'f-adv-1', severity: 'minor', file: 'src/nit.ts', title: 'nit', detail: 'nit', round: 1, status: 'open' },
    ],
    round: 1,
    lastReviewedCommitSha: 'head456',
    remediationCount: 0,
    markedReadyByEngine: false,
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
      deps.readFindingsArtifact = vi.fn().mockResolvedValue({ artifact: cleanArtifact(), blockingSeverity: 'critical' });
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
    deps.readFindingsArtifact = vi.fn().mockResolvedValue({ artifact: cleanArtifact(), blockingSeverity: 'critical' });
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

/**
 * #1164 T014 (SC-004 / FR-007) — post-resolution re-arm runs validate on the
 * merged tree.
 *
 * Defect 4: with `ciMergeGateEnabled=true` and `reviewPhaseEnabled=false`, a
 * post-approval conflict resolution re-arms `continue` at `validate`. The #1133
 * terminal short-circuit (`phase-loop.ts:366-387`) reads `completed:validate` +
 * `completed:implementation-review` fresh from the issue; if BOTH are present it
 * declares the run complete and marks the PR ready WITHOUT running `validate` on
 * the post-merge tree. The FR-007 fix removes those two labels in
 * `applySuccessDisposition` when it re-arms, so on the resumed `continue` the
 * issue no longer carries both markers → the short-circuit does not fire →
 * `validate` runs on the merged tree before mark-ready.
 *
 * This test drives `PhaseLoop.executeLoop` from the post-FR-007 world (labels
 * absent) and asserts `validate` actually runs; the contrast case (labels
 * present, the pre-fix state) proves the short-circuit is exactly what the
 * label removal disarms. The `applySuccessDisposition` label removal itself is
 * unit-tested in `merge-conflict-handler.success-disposition.test.ts`.
 */
describe('#1164 T014 — post-resolution re-arm runs validate on merged tree (SC-004/FR-007)', () => {
  let phaseLoop: PhaseLoop;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    vi.clearAllMocks();
  });

  /** Deps whose validate path completes cleanly under the CI merge gate. */
  function makeCiGateDeps(): PhaseLoopDeps {
    const github = createGithubSpy();
    const deps = createMockDeps(github);
    // `prManager.getPrNumber` already returns 42; markReadyForReview resolves.
    return deps;
  }

  /**
   * Resumed `continue` context at `validate`, shaped by the merge-conflict
   * re-arm under the flag-OFF review / flag-ON CI gate world.
   */
  function makeCiGateContext(resumeLabels: string[]): WorkerContext {
    return {
      workerId: 'test-worker',
      item: {
        owner: 'test',
        repo: 'repo',
        issueNumber: 1164,
        workflowName: 'speckit-feature',
        command: 'continue',
      } as any,
      startPhase: 'validate',
      resumeReason: 'merge-conflict-resolved',
      github: {
        getIssue: vi.fn().mockResolvedValue({
          labels: resumeLabels.map((name) => ({ name })),
          state: 'open',
        }),
        getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
        getCiRunsForSha: vi.fn().mockResolvedValue({
          runs: [{ status: 'completed', conclusion: 'success' }],
          source: 'check-runs',
        }),
        getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      } as any,
      logger: mockLogger,
      signal: new AbortController().signal,
      // branch intentionally unset so the #1051 phase-start push guard is skipped.
      checkoutPath: '/tmp/repo',
      issueUrl: 'https://github.com/test/repo/issues/1164',
      description: 'test',
    } as WorkerContext;
  }

  function ciGateConfig(): WorkerConfig {
    return {
      phaseTimeoutMs: 600_000,
      workspaceDir: '/tmp',
      shutdownGracePeriodMs: 5000,
      validateCommand: 'pnpm test && pnpm build',
      preValidateCommand: '',
      gates: {},
      maxImplementRetries: 2,
      reviewPhaseEnabled: false,
      ciMergeGateEnabled: true,
    } as unknown as WorkerConfig;
  }

  it('runs validate on the merged tree when the completion labels are absent (post-FR-007)', async () => {
    const deps = makeCiGateDeps();
    // FR-007: applySuccessDisposition stripped both completion markers on re-arm.
    const context = makeCiGateContext(['agent:in-progress']);
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, ciGateConfig(), deps, sequence);

    expect(result.completed).toBe(true);
    // The terminal short-circuit did NOT fire — validate ran on the merged tree.
    expect(phaseStartOrder(deps)).toContain('validate');
    expect(deps.cliSpawner.runValidatePhase).toHaveBeenCalledTimes(1);
    // CI merge gate marked the PR ready only after validate ran.
    expect(deps.prManager.markReadyForReview).toHaveBeenCalledTimes(1);
  });

  it('short-circuits (skips validate) when both completion labels are present (pre-FR-007 contrast)', async () => {
    const deps = makeCiGateDeps();
    // Pre-fix state: disposition left both markers on the issue.
    const context = makeCiGateContext([
      'completed:validate',
      'completed:implementation-review',
    ]);
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, ciGateConfig(), deps, sequence);

    expect(result.completed).toBe(true);
    // The short-circuit fired: validate never ran, proving FR-007's label
    // removal is exactly what re-enables validation on the merged tree.
    expect(phaseStartOrder(deps)).not.toContain('validate');
    expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
    expect(deps.prManager.markReadyForReview).not.toHaveBeenCalled();
  });
});

/**
 * Scope consumption through the REAL `ReviewExecutor` with a prior artifact.
 *
 * Defect: `review-executor.ts` gated the resolution scope on `!priorRound`.
 * On the real path conflicts surface at validate entry — AFTER round 1
 * persisted the sidecar — so the scoped review NEVER ran: the re-review was a
 * verification pass whose delta (`lastReviewedCommitSha`..HEAD) spanned the
 * whole upstream base merge. The scripted stand-in above (#1164 T009) writes
 * the sidecar itself and cannot observe that. This suite composes the real
 * executor (via `review-composition-harness`) with a prior artifact on disk
 * and asserts: the scope is applied once (conflicted-path charter + still-open
 * prior findings), its consumption is persisted, and the following round
 * falls back to the remediation delta so the loop still converges.
 */
describe('scoped review with a prior artifact — real ReviewExecutor applies the scope once', () => {
  let harness: ReviewCompositionHarness;

  beforeEach(async () => {
    harness = await createReviewCompositionHarness({ issueNumber: 1171 });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  /** Two real commits so `isEmptyWindow`'s `git diff base..head` is non-empty. */
  function commitTwice(dir: string): { base: string; head: string } {
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir }).toString().trim();
    writeFileSync(path.join(dir, 'src-a.txt'), 'one');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'c0']);
    const base = git(['rev-parse', '--short', 'HEAD']);
    writeFileSync(path.join(dir, 'src-a.txt'), 'two');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'c1 (merge resolution)']);
    const head = git(['rev-parse', '--short', 'HEAD']);
    return { base, head };
  }

  it('applies the conflicted-path scope on round 2 (prior artifact present), persists consumption, then converges on the delta', async () => {
    const { base, head } = commitTwice(harness.checkoutPath);

    // Round 1 already happened before the validate-entry conflict: a clean
    // artifact with one open sub-blocking finding still to confirm.
    await writeReviewArtifact(harness.checkoutPath, harness.workflowId, {
      findings: [
        {
          id: deriveFindingId('src/a.ts', 'Nit from round 1'),
          severity: 'minor',
          file: 'src/a.ts',
          title: 'Nit from round 1',
          detail: 'advisory',
          round: 1,
          status: 'open',
        },
      ],
      verdict: 'clean',
      round: 1,
      lastReviewedCommitSha: 'r1sha',
      remediationCount: 0,
      markedReadyByEngine: false,
    });

    // Round 2 (scoped): the resolution introduced a blocking defect in the
    // conflicted path. Round 3 (delta): the remediation fixed it.
    const inner = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJsonByRound: {
        2: JSON.stringify({
          findings: [
            {
              severity: 'critical',
              file: 'src/a.ts',
              title: 'Resolution dropped the null guard',
              detail: 'must fix',
              status: 'open',
            },
          ],
        }),
        3: JSON.stringify({
          findings: [
            {
              severity: 'critical',
              file: 'src/a.ts',
              title: 'Resolution dropped the null guard',
              detail: 'restored',
              status: 'resolved',
            },
          ],
        }),
      },
    });
    const prompts: string[] = [];
    const agentLauncher = {
      launch: vi.fn(async (req: { intent: { prompt: string } }) => {
        prompts.push(req.intent.prompt);
        return inner.launch(req as never);
      }),
    } as unknown as typeof inner;

    // Parent-1 diff of the merge commit brings upstream-only files along; the
    // remediation delta (round 3) touches only the conflicted file.
    const getFilesChangedBetween = harness.github.getFilesChangedBetween as ReturnType<typeof vi.fn>;
    getFilesChangedBetween.mockImplementation(async (b: string, h: string) =>
      b === base && h === head ? ['upstream/only.ts', 'src/a.ts'] : ['src/a.ts'],
    );

    const remediateExecute = vi.fn(async (): Promise<PhaseResult> => {
      await bumpRemediationCount(harness.checkoutPath, harness.workflowId);
      return makeSuccessResult('remediate');
    });
    const { context, config, deps } = harness.build({
      agentLauncher,
      startPhase: 'review',
      extraDeps: {
        remediateExecutor: { execute: remediateExecute } as never,
        remediateTrigger: (ctx: WorkerContext) =>
          readReviewArtifactSync(ctx.checkoutPath, harness.workflowId)?.verdict ===
          'changes-required',
        gateChecker: {
          checkGates: vi.fn(
            (phase: WorkflowPhase, workflowName: string, cfg: WorkerConfig) =>
              (cfg.gates?.[workflowName] ?? []).filter((g) => g.phase === phase),
          ),
        } as never,
      },
    });
    config.gates = {
      [harness.workflowName]: [
        {
          phase: 'review',
          gateLabel: 'waiting-for:remediation-limit',
          condition: 'on-remediation-limit',
        },
      ],
    } as WorkerConfig['gates'];
    // Shaped exactly as the worker builds it after a merge-conflict re-arm.
    context.resumeReason = 'merge-conflict-resolved';
    context.reviewScope = { baseSha: base, headSha: head, conflictedPaths: ['src/a.ts'] };

    const result = await harness.phaseLoop.executeLoop(context, config, deps, [
      'review',
      'validate',
    ]);

    expect(result.completed).toBe(true);
    expect(result.gateHit).toBe(false);
    expect(phaseStartOrder(deps)).toEqual(['review', 'remediate', 'review', 'validate']);
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();

    // Round 2 charter: scoped to the conflicted path (upstream-only files
    // excluded) AND a verification pass carrying the still-open prior finding.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Conflicted paths:');
    expect(prompts[0]).toContain('- src/a.ts');
    expect(prompts[0]).not.toContain('upstream/only.ts');
    expect(prompts[0]).toContain('Nit from round 1');
    expect(prompts[0]).toContain('## Confirming an addressed finding');
    expect(getFilesChangedBetween).toHaveBeenCalledWith(base, head);
    expect(getFilesChangedBetween).not.toHaveBeenCalledWith('r1sha', expect.anything());

    // Round 3 charter: the scope was consumed — plain delta verification pass
    // over the remediation commits, never re-spanning the upstream merge.
    expect(prompts[1]).not.toContain('Conflicted paths:');
    expect(prompts[1]).not.toContain(`${base}..${head}`);
    expect(prompts[1]).toContain('Resolution dropped the null guard');

    const finalArtifact = readReviewArtifactSync(harness.checkoutPath, harness.workflowId);
    expect(finalArtifact?.round).toBe(3);
    expect(finalArtifact?.verdict).toBe('clean');
    expect(finalArtifact?.remediationCount).toBe(1);
    expect(finalArtifact?.consumedReviewScopeHeadSha).toBe(head);
    const defect = finalArtifact?.findings.find((f) => f.title === 'Resolution dropped the null guard');
    expect(defect?.status).toBe('resolved');
    // The round-2 lastReviewedCommitSha (merge HEAD) was the round-3 delta base.
    const round2Head = getFilesChangedBetween.mock.calls.at(-1)?.[0];
    expect(round2Head).not.toBe('r1sha');
    expect(round2Head).not.toBe(base);
  });
});
