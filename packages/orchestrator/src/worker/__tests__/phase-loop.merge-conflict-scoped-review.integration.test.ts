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
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import { ReviewPoster } from '../review-poster.js';
import type { FindingsArtifact } from '../review-findings-artifact.js';
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
