/**
 * US1 (#1127, FR-001 / FR-002 / FR-003) — the clean-review happy path,
 * end-to-end through the REAL posting + lifecycle production code.
 *
 * Drives `PhaseLoop.executeLoop` with `reviewPhaseEnabled: true` so `review`
 * is in the effective sequence. The verdict is steered — not re-implemented
 * (FR-008 / research.md Decision 2) — by injecting `readFindingsArtifact` to
 * return a CLEAN `FindingsArtifact`. Posting runs through the real
 * `ReviewPoster` (#1125) against a mocked `GitHubClient` capturing spy, so the
 * suite asserts the actual wire behavior:
 *   - exactly one COMMENT review, zero REQUEST_CHANGES (SC-003);
 *   - the posted body carries the engine-authored marker (via the FR-005
 *     match helper, never a raw literal — the suite cannot drift);
 *   - `markReadyForReview` on clean → the loop advances into `validate`.
 *
 * The review executor is left as the #1121 stub (no CLI spawn): the findings
 * artifact is the steering lever, so no real review logic runs (FR-008).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import {
  ReviewPoster,
  matchEngineAuthoredReviewMarker,
} from '../review-poster.js';
import type { FindingsArtifact } from '../review-findings-artifact.js';
import type {
  GitHubClient,
  CreateReviewInput,
  Review,
} from '@generacy-ai/workflow-engine';

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

/**
 * Capturing GitHubClient spy for the real ReviewPoster. `listReviews` /
 * `listPullRequestFiles` / `getPRReviewThreads` return empty so posting takes
 * the simple body-only path; `createReview` captures the submitted input.
 */
function createGithubSpy() {
  const createReview = vi.fn(async (): Promise<Review> => ({
    id: 1,
    user: { login: 'generacy[bot]' },
    body: '',
    state: 'COMMENTED',
    submittedAt: new Date().toISOString(),
  }));
  return {
    listReviews: vi.fn(async () => [] as Review[]),
    listPullRequestFiles: vi.fn(async () => []),
    getPRReviewThreads: vi.fn(async () => []),
    resolveReviewThread: vi.fn(async () => undefined),
    createReview,
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

function createMockContext(
  workflowName: string,
  startPhase: WorkflowPhase = 'implement',
): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: 'test',
      repo: 'repo',
      issueNumber: 1127,
      workflowName,
    } as any,
    startPhase,
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/test/repo/issues/1127',
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
  } as WorkerConfig;
}

/** Phases in the order the loop marked them active (via labelManager.onPhaseStart). */
function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

/** A clean verdict with one advisory (at/below blockingSeverity) finding. */
function cleanArtifact(): FindingsArtifact {
  return {
    verdict: 'clean',
    findings: [{ marker: 'f-adv-1', text: 'consider renaming', severity: 'advisory' }],
  };
}

describe('US1 (#1127) — clean-review happy path, real posting + lifecycle', () => {
  let phaseLoop: PhaseLoop;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
  });

  // T012 — parameterized across both speckit workflows (SC-002).
  for (const workflow of ['speckit-feature', 'speckit-bugfix'] as const) {
    it(`traverses implement → review → validate with review immediately after implement (${workflow}, FR-001/SC-002)`, async () => {
      const github = createGithubSpy();
      const deps = createMockDeps(github);
      deps.readFindingsArtifact = vi.fn().mockResolvedValue({ artifact: cleanArtifact(), round: 1 });
      const context = createMockContext(workflow, 'implement');
      const config = createConfig({ reviewPhaseEnabled: true });
      const sequence = getPhaseSequence(workflow, true) as WorkflowPhase[];

      const result = await phaseLoop.executeLoop(context, config, deps, sequence);

      expect(result.completed).toBe(true);
      const order = phaseStartOrder(deps);
      expect(order).toEqual(['implement', 'review', 'validate']);
      expect(order.indexOf('review')).toBe(order.indexOf('implement') + 1);
    });
  }

  // T013 — exactly one COMMENT review, zero REQUEST_CHANGES on the own PR (FR-002 / SC-003).
  it('posts exactly one COMMENT review with zero REQUEST_CHANGES (FR-002 / SC-003)', async () => {
    const github = createGithubSpy();
    const deps = createMockDeps(github);
    deps.readFindingsArtifact = vi.fn().mockResolvedValue({ artifact: cleanArtifact(), round: 1 });
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    const createReview = github.createReview as unknown as ReturnType<typeof vi.fn>;
    expect(createReview).toHaveBeenCalledTimes(1);
    const inputs = createReview.mock.calls.map((c) => c[3] as CreateReviewInput);
    expect(inputs.map((i) => i.event)).toEqual(['COMMENT']);
    expect(inputs.some((i) => i.event === 'REQUEST_CHANGES')).toBe(false);
  });

  // T014 — the posted body carries the engine-authored marker (via the FR-005
  // match helper, not a raw string literal, so the suite cannot drift).
  it('stamps the engine-authored marker on the review body (FR-005 helper, T014)', async () => {
    const github = createGithubSpy();
    const deps = createMockDeps(github);
    deps.readFindingsArtifact = vi.fn().mockResolvedValue({ artifact: cleanArtifact(), round: 1 });
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    const createReview = github.createReview as unknown as ReturnType<typeof vi.fn>;
    const input = createReview.mock.calls[0]![3] as CreateReviewInput;
    expect(matchEngineAuthoredReviewMarker(input.body)).toBeDefined();
  });

  // T015 — markReadyForReview on clean verdict; the loop advances into validate.
  it('marks the PR ready on clean verdict and advances into validate (FR-003)', async () => {
    const github = createGithubSpy();
    const deps = createMockDeps(github);
    deps.readFindingsArtifact = vi.fn().mockResolvedValue({ artifact: cleanArtifact(), round: 1 });
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(deps.prManager.markReadyForReview).toHaveBeenCalledTimes(1);
    // convert-to-draft is a remediate-entry side effect — never on a clean pass.
    expect(deps.prManager.convertToDraftIfEngineMarkedReady).not.toHaveBeenCalled();
    expect(phaseStartOrder(deps)).toContain('validate');
  });
});
