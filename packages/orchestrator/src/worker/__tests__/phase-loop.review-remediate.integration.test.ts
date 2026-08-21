/**
 * US1 (#1123) — the phase loop traverses `review` and reaches `remediate`
 * off-sequence, then backtracks to a re-`review` pass. Also proves per-workflow
 * config is observable in-loop via the `worker/config.ts` resolver.
 *
 * This suite asserts the *behavior* pinned by
 * `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md`
 * against the **stub** review/remediate executors shipped by #1121. It ships no
 * real review/remediation logic (FR-008) — the stubs are test-only doubles
 * injected through the existing `PhaseLoopDeps` seam (research.md Decision 1).
 *
 * The #1121 loop-control mechanism is a `PhaseLoopDeps.remediateTrigger`
 * predicate + an `i--; continue;` backtrack (NOT a `{ next: <phase> }` step
 * outcome). Entry to `remediate` is therefore steered by injecting the trigger;
 * `review` is gated into the effective sequence by `reviewPhaseEnabled: true`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { getPhaseSequence } from '../types.js';
import { resolveWorkflowOverrides } from '../config.js';
import type { WorkerConfig } from '../config.js';
import type { OrchestratorSettings } from '@generacy-ai/config';
import { ReviewPoster, matchEngineAuthoredReviewMarker, findingMarker } from '../review-poster.js';
import type { FindingsArtifact, ReviewVerdict } from '../review-findings-artifact.js';
import { advanceArtifact } from '../review/index.js';
import type {
  FindingsArtifact as ConvergenceFindingsArtifact,
  ReviewDelta,
} from '../review/index.js';
import type { PhaseTracker } from '../../types/index.js';
import type {
  GitHubClient,
  CreateReviewInput,
  Review,
  ReviewThread,
} from '@generacy-ai/workflow-engine';

// ---------------------------------------------------------------------------
// Harness — mirrors phase-loop.test.ts:42-116 (createMockDeps / createMockContext
// / createConfig). The stub review/remediate executors are internal to
// PhaseLoop.runStubPhase; the only injection this suite adds is remediateTrigger.
// ---------------------------------------------------------------------------
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
      getPrNumber: vi.fn().mockReturnValue(undefined),
      // #1125: remediate entry calls this to convert the PR back to draft.
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
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
      issueNumber: 1123,
      workflowName,
    } as any,
    startPhase,
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      getFilesChangedByOwnCommits: vi
        .fn()
        .mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath: '/tmp/repo',
    issueUrl: 'https://github.com/test/repo/issues/1123',
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

/** Fire-once-then-false predicate — drives exactly one off-sequence remediate. */
function fireOnceTrigger(): PhaseLoopDeps['remediateTrigger'] {
  let fired = false;
  return () => {
    if (fired) return false;
    fired = true;
    return true;
  };
}

/** Phases in the order the loop marked them active (via labelManager.onPhaseStart). */
function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map((c: unknown[]) => c[0] as WorkflowPhase);
}

describe('US1 — loop traverses review and remediate', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  // T007 — speckit-feature schedules review immediately after implement.
  it('schedules review immediately after implement for speckit-feature (FR-002, SC-002)', async () => {
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(result.completed).toBe(true);
    const order = phaseStartOrder(deps);
    expect(order).toEqual(['implement', 'review', 'validate']);
    expect(order.indexOf('review')).toBe(order.indexOf('implement') + 1);
  });

  // T008 — speckit-bugfix schedules review immediately after implement.
  it('schedules review immediately after implement for speckit-bugfix (FR-002, SC-002)', async () => {
    const context = createMockContext('speckit-bugfix', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-bugfix', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(result.completed).toBe(true);
    const order = phaseStartOrder(deps);
    expect(order).toEqual(['implement', 'review', 'validate']);
    expect(order.indexOf('review')).toBe(order.indexOf('implement') + 1);
  });

  // T009 — remediate is reachable ONLY off the linear sequence, via loop control,
  // and always backtracks to a review pass (never the next linear phase).
  it('reaches remediate off-sequence and returns control to review, not the next linear phase (FR-003, SC-002)', async () => {
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];
    deps.remediateTrigger = fireOnceTrigger();

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(result.completed).toBe(true);
    const order = phaseStartOrder(deps);
    // implement → review → remediate → (backtrack) review → validate
    expect(order).toEqual(['implement', 'review', 'remediate', 'review', 'validate']);

    // Invariant 1 (entry): remediate never appears in the linear sequence — it is
    // reached only because the trigger fired.
    expect(sequence).not.toContain('remediate');

    // Invariant 2 (backtrack): the phase immediately after remediate is review,
    // NOT validate/merge.
    const remediateIdx = order.indexOf('remediate');
    expect(order[remediateIdx + 1]).toBe('review');

    // remediate completed symmetrically.
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('remediate');
  });

  // T009 (negative half of the invariant) — with no trigger, remediate is never
  // entered; the loop advances review → validate directly.
  it('never enters remediate when the loop-control trigger does not fire', async () => {
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];
    // deps.remediateTrigger left undefined — production default.

    await phaseLoop.executeLoop(context, config, deps, sequence);

    const order = phaseStartOrder(deps);
    expect(order).not.toContain('remediate');
    expect(deps.labelManager.onPhaseStart).not.toHaveBeenCalledWith('remediate');
  });

  // T010 — per-workflow config (maxRemediations + review profile) is observable
  // through the worker/config.ts resolver, NOT a WorkerConfig field and NOT an
  // injected loop dependency (Q4=B, SC-003).
  it('surfaces per-workflow maxRemediations + review profile via resolveWorkflowOverrides, differing per workflow (FR-004)', () => {
    const config = createConfig({ reviewPhaseEnabled: true });
    const settings: OrchestratorSettings = {
      workflows: {
        'speckit-feature': {
          maxRemediations: 3,
          review: { profile: 'verification' },
        },
        'speckit-bugfix': {
          maxRemediations: 2,
          review: { profile: 'standard' },
        },
      },
    };

    const feature = resolveWorkflowOverrides(config, settings, 'speckit-feature');
    const bugfix = resolveWorkflowOverrides(config, settings, 'speckit-bugfix');

    // Values are readable through the held config object + resolver.
    expect(feature.maxRemediations).toBe(3);
    expect(bugfix.maxRemediations).toBe(2);
    expect(feature.review.profile).toBe('verification');
    expect(bugfix.review.profile).toBe('standard');

    // …and they differ per workflow.
    expect(feature.maxRemediations).not.toBe(bugfix.maxRemediations);
    expect(feature.review.profile).not.toBe(bugfix.review.profile);

    // Q4=B: NOT a WorkerConfig field, NOT an injected loop dep.
    expect('maxRemediations' in config).toBe(false);
    expect('review' in config).toBe(false);
    expect('maxRemediations' in createMockDeps()).toBe(false);
    expect('remediateConfig' in createMockDeps()).toBe(false);
  });

  // T011 — negative scope (FR-008): the stubs exercise no real behavior. No CLI
  // spawn for review/remediate, no PR posting beyond the normal per-phase commit,
  // no severity gating, no CI/validate orchestration driven by the stubs.
  it('exercises no real review/remediation behavior — stubs only (FR-008)', async () => {
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];
    deps.remediateTrigger = fireOnceTrigger();

    await phaseLoop.executeLoop(context, config, deps, sequence);

    // No CLI process is ever spawned for the stub phases.
    const spawnedPhases = (deps.cliSpawner.spawnPhase as any).mock.calls.map(
      (c: unknown[]) => c[0] as WorkflowPhase,
    );
    expect(spawnedPhases).not.toContain('review');
    expect(spawnedPhases).not.toContain('remediate');

    // runValidatePhase runs for the validate phase only — never smuggled into
    // review/remediate (no CI/validate orchestration from the stubs).
    expect(deps.cliSpawner.runValidatePhase).toHaveBeenCalledTimes(1);

    // No severity gating / gate-driven remediation: gateChecker returns [] and
    // remediate entry came purely from the injected trigger, not a gate.
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// US2 (#1127) — changes-required verdict routes off-sequence to remediate,
// converts the PR back to draft, backtracks to a delta-scoped re-review, and
// re-marks ready on the clean re-review. Exercises the REAL posting +
// lifecycle production code (#1125) with the verdict steered — not
// re-implemented (FR-008) — through the `readFindingsArtifact` seam.
//
// The trigger mirrors production: `remediateTrigger` reads the same verdict the
// review side-effect block just observed (in prod: `readReviewArtifactSync`),
// so round 1 (changes-required) drives one remediate round-trip and round 2
// (clean) resumes forward.
// ===========================================================================

/** Capturing GitHubClient spy for the real ReviewPoster (body-only path). */
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

describe('US2 (#1127) — changes-required → remediate → re-review, real lifecycle', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;
  let github: GitHubClient;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
    github = createGithubSpy();
    deps.reviewPoster = new ReviewPoster({
      github,
      owner: 'test',
      repo: 'repo',
      getPrNumber: () => 42,
      logger: mockLogger,
    });

    // Round 1 → changes-required (one blocking finding); round 2+ → clean.
    // The round is now authoritative from the sidecar (FR-005), so the reader
    // tracks its own monotonic round exactly as the persisted artifact would.
    let callRound = 0;
    let lastVerdict: ReviewVerdict | null = null;
    deps.readFindingsArtifact = vi.fn(
      async (_ctx): Promise<{ artifact: FindingsArtifact; round: number } | null> => {
        callRound += 1;
        const artifact: FindingsArtifact =
          callRound === 1
            ? {
                verdict: 'changes-required',
                findings: [{ marker: 'f-block-1', text: 'must fix', severity: 'blocking' }],
              }
            : { verdict: 'clean', findings: [] };
        lastVerdict = artifact.verdict;
        return { artifact, round: callRound };
      },
    );
    deps.remediateTrigger = () => lastVerdict === 'changes-required';
  });

  // T022 — the blocking verdict routes the loop off-sequence toward remediate,
  // not to the next linear phase.
  it('routes the blocking verdict off-sequence to remediate, then back to review (FR-004)', async () => {
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(result.completed).toBe(true);
    const order = phaseStartOrder(deps);
    // implement → review(1) → remediate → review(2) → validate
    expect(order).toEqual(['implement', 'review', 'remediate', 'review', 'validate']);
    expect(sequence).not.toContain('remediate');
    // T024 — after the stub remediate, control backtracks to review (delta-scoped),
    // never to the next linear phase.
    const remediateIdx = order.indexOf('remediate');
    expect(order[remediateIdx + 1]).toBe('review');
  });

  // T023 — entering remediate calls the ready→draft conversion (SC-004).
  it('converts the PR back to draft on remediate entry (ready→draft, SC-004)', async () => {
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(deps.prManager.convertToDraftIfEngineMarkedReady).toHaveBeenCalledTimes(1);
  });

  // T025 — the clean re-review re-marks ready and the loop resumes forward
  // (SC-004 — exactly one round-trip). One COMMENT review per round, marker on each.
  it('re-marks ready on the clean re-review and resumes forward (SC-004)', async () => {
    const context = createMockContext('speckit-feature', 'implement');
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    // markReadyForReview fires only on the round-2 clean verdict (not round 1).
    expect(deps.prManager.markReadyForReview).toHaveBeenCalledTimes(1);

    // One COMMENT review per round (rounds 1 + 2); each body carries the marker.
    const createReview = github.createReview as unknown as ReturnType<typeof vi.fn>;
    expect(createReview).toHaveBeenCalledTimes(2);
    const inputs = createReview.mock.calls.map((c) => c[3] as CreateReviewInput);
    expect(inputs.map((i) => i.event)).toEqual(['COMMENT', 'COMMENT']);
    for (const input of inputs) {
      expect(matchEngineAuthoredReviewMarker(input.body)).toBeDefined();
    }

    // Loop resumed forward into validate.
    expect(phaseStartOrder(deps)).toContain('validate');
  });
});

// ===========================================================================
// US4 (#1127) — the finding-identity ⇄ marker ⇄ status correlation: the
// distinctive job this integration issue exists to prove. The earlier US2 suite
// shows the lifecycle *shape* (route → draft → re-review → ready) but ships
// `findings: []` on the re-review, so no finding is carried across rounds — the
// operator flagged that (a) #1125's marker-based thread resolution and (b)
// #1126's `open → resolved` status transition were never actually exercised.
//
// Here round 1 raises a blocking finding with a stable `marker` + `anchor`, and
// round 2 re-emits the SAME marker as `resolved: true`. That single identity —
// `f-block-1` — stitches the two boundaries together and is asserted against the
// merged production code (only the permitted `remediateTrigger` /
// `readFindingsArtifact` doubles injected):
//
//   #1125 (marker → thread): `ReviewPoster.resolveResolvedThreads` correlates the
//     re-emitted marker back to its GitHub review thread and resolves exactly it.
//   #1126 (status machine): `advanceArtifact` carries the finding across rounds
//     and flips it `open → resolved` when the reviewer reports it addressed —
//     the ReviewArtifact→FindingsArtifact bridge phase-loop.ts:520-530 defers
//     "to #1127". This suite proves the convergence primitive that bridge calls,
//     plus that `runReviewConvergence` is no longer inert once a `phaseTracker`
//     is wired (it loads + persists an advancing artifact).
// ===========================================================================

/** Shared finding identity threading #1125 (marker) to #1126 (finding id). */
const FINDING_ID = 'f-block-1';
const ANCHOR_FILE = 'packages/orchestrator/src/foo.ts';
const ANCHOR_LINE = 10;
/** GraphQL thread node id `resolveReviewThread` is expected to be called with. */
const THREAD_ID = 'RT_thread-f-block-1';

/** In-memory PhaseTracker so `runReviewConvergence` actually loads + persists. */
function createFakePhaseTracker(): { tracker: PhaseTracker; store: Map<string, string> } {
  const store = new Map<string, string>();
  const tracker = {
    getValueRaw: vi.fn(async (key: string) => store.get(key) ?? null),
    setValueRaw: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    clearRaw: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    // Remaining PhaseTracker surface — unused by these paths.
    isDuplicate: vi.fn(async () => false),
    markProcessed: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    tryMarkProcessed: vi.fn(async () => true),
    isDuplicateRaw: vi.fn(async () => false),
    markProcessedRaw: vi.fn(async () => undefined),
  } as unknown as PhaseTracker;
  return { tracker, store };
}

/**
 * GitHubClient spy for the correlation scenario. `listPullRequestFiles` returns
 * a hunk covering `ANCHOR_LINE`, so round 1 posts `f-block-1` as a real inline
 * COMMENT whose body carries `findingMarker('f-block-1')`. `getPRReviewThreads`
 * returns that thread (unresolved) so round 2's marker match has a target.
 */
function createCorrelationGithubSpy(): GitHubClient {
  const patch = [
    '@@ -0,0 +1,12 @@',
    ...Array.from({ length: 12 }, (_, i) => `+line ${i + 1}`),
  ].join('\n');
  const now = new Date().toISOString();
  const thread: ReviewThread = {
    id: THREAD_ID,
    rootCommentId: 1,
    isResolved: false,
    comments: [
      {
        id: 1,
        body: `${findingMarker(FINDING_ID)}\n🔴 Blocking: must fix`,
        author: 'generacy[bot]',
        created_at: now,
        updated_at: now,
      },
    ],
  };
  return {
    listReviews: vi.fn(async () => [] as Review[]),
    listPullRequestFiles: vi.fn(async () => [
      { filename: ANCHOR_FILE, status: 'modified', patch },
    ]),
    getPRReviewThreads: vi.fn(async () => [thread]),
    resolveReviewThread: vi.fn(async () => undefined),
    createReview: vi.fn(
      async (): Promise<Review> => ({
        id: 1,
        user: { login: 'generacy[bot]' },
        body: '',
        state: 'COMMENTED',
        submittedAt: now,
      }),
    ),
  } as unknown as GitHubClient;
}

/** Context whose github can resolve the last-reviewed SHA (verification mode). */
function createCorrelationContext(): WorkerContext {
  const context = createMockContext('speckit-feature', 'implement');
  (context.github as any).commitExistsInCheckout = vi.fn().mockResolvedValue(true);
  return context;
}

describe('US4 (#1127) — finding-identity ⇄ marker ⇄ status correlation', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;
  let github: GitHubClient;

  beforeEach(() => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
    github = createCorrelationGithubSpy();
    deps.reviewPoster = new ReviewPoster({
      github,
      owner: 'test',
      repo: 'repo',
      getPrNumber: () => 42,
      logger: mockLogger,
    });

    // Round 1 raises `f-block-1` (blocking, anchored); round 2 re-emits the SAME
    // marker as resolved. The round is authoritative from the sidecar (FR-005),
    // so the reader tracks its own monotonic round like the persisted artifact.
    let callRound = 0;
    let lastVerdict: ReviewVerdict | null = null;
    deps.readFindingsArtifact = vi.fn(
      async (_ctx): Promise<{ artifact: FindingsArtifact; round: number } | null> => {
        callRound += 1;
        const artifact: FindingsArtifact =
          callRound === 1
            ? {
              verdict: 'changes-required',
              findings: [
                {
                  marker: FINDING_ID,
                  text: 'must fix',
                  severity: 'blocking',
                  anchor: { file: ANCHOR_FILE, line: ANCHOR_LINE },
                },
              ],
            }
          : {
              verdict: 'clean',
              findings: [
                {
                  marker: FINDING_ID,
                  text: 'addressed',
                  severity: 'blocking',
                  anchor: { file: ANCHOR_FILE, line: ANCHOR_LINE },
                  resolved: true,
                },
              ],
            };
        lastVerdict = artifact.verdict;
        return { artifact, round: callRound };
      },
    );
    deps.remediateTrigger = () => lastVerdict === 'changes-required';
  });

  // #1125 — the re-emitted marker is correlated back to its round-1 thread and
  // that exact thread is resolved.
  it('resolves the round-1 finding thread by its stable marker on re-review (#1125 marker → thread)', async () => {
    const context = createCorrelationContext();
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    // Round 1 posted the blocking finding as an inline COMMENT carrying its
    // per-finding marker (the identity round 2 matches on).
    const createReview = github.createReview as unknown as ReturnType<typeof vi.fn>;
    const round1 = createReview.mock.calls[0]![3] as CreateReviewInput;
    expect(
      round1.comments?.some((c) => c.body.includes(findingMarker(FINDING_ID))),
    ).toBe(true);

    // Round 2 (re-review) fetched threads and resolved exactly the thread whose
    // body carries `findingMarker('f-block-1')` — marker-based correlation, not
    // path+line (FR-009).
    const resolve = github.resolveReviewThread as unknown as ReturnType<typeof vi.fn>;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(THREAD_ID);
  });

  // #1126 — the same finding identity transitions `open → resolved` across
  // rounds. The ReviewArtifact→FindingsArtifact bridge that would feed
  // reviewer-addressed ids into `runReviewConvergence` is deferred by
  // phase-loop.ts (both hardcoded `[]` today), so #1127 proves the convergence
  // primitive that bridge will call — with the SAME `f-block-1` identity #1125
  // resolves as a thread above.
  it('flips the finding open → resolved when the reviewer reports it addressed (#1126 convergence)', () => {
    const seeded: ConvergenceFindingsArtifact = {
      round: 1,
      findings: [
        {
          id: FINDING_ID, // same identity as the #1125 per-finding marker
          severity: 'critical',
          file: ANCHOR_FILE,
          line: ANCHOR_LINE,
          title: 'must fix',
          detail: 'blocking finding raised in round 1',
          round: 1,
          status: 'open',
        },
      ],
      lastReviewedSha: 'a1b2c3d4',
      verdict: 'changes-required',
    };
    const delta: ReviewDelta = {
      base: { source: 'last-reviewed', base: 'a1b2c3d4', head: 'e5f6a7b8' },
      files: [ANCHOR_FILE], // remediation touched the finding's file
      round: 2,
    };

    const { artifact: next, verdict } = advanceArtifact({
      artifact: seeded,
      delta,
      reviewerAddressed: [FINDING_ID], // non-empty — the reviewer addressed it
      reviewerNewFindings: [],
      blockingSeverity: 'major',
    });

    const carried = next.findings.find((f) => f.id === FINDING_ID);
    expect(carried?.status).toBe('resolved'); // open → resolved (Q1 terminal)
    expect(next.round).toBe(2); // round advanced across the transition
    expect(verdict).toBe('clean'); // no open blocking finding remains
  });

  // #1126 — with a phaseTracker wired, `runReviewConvergence` is no longer inert:
  // it loads the prior artifact and persists an advancing one (round 0 → 1 → 2
  // across the two review passes). Closes concern (b): "the mock deps provide no
  // phaseTracker, so it loads/persists nothing."
  it('loads and persists an advancing convergence artifact once a phaseTracker is wired (#1126 not inert)', async () => {
    const { tracker, store } = createFakePhaseTracker();
    deps.phaseTracker = tracker;
    const context = createCorrelationContext();
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    // The convergence artifact was written under its own key (distinct from the
    // #1107 phase-start-ref key that shares the store).
    const convergenceKey = [...store.keys()].find((k) => k.startsWith('review-findings:'));
    expect(convergenceKey).toBeDefined();
    expect(tracker.setValueRaw).toHaveBeenCalled();

    // Persisted shape is the #1126 convergence artifact (round + lastReviewedSha),
    // NOT the #1125 poster artifact — and the round advanced across both passes.
    const persisted = JSON.parse(store.get(convergenceKey!)!) as ConvergenceFindingsArtifact;
    expect(persisted.round).toBe(2);
    expect(persisted.lastReviewedSha).toBeDefined();
  });
});
