// #1132 US3 (T030–T033) — external feedback re-entry + engine-thread exclusion,
// end-to-end.
//
// Composes the two halves of the external-feedback path that must interlock:
//
//   (1) Detection — the REAL `PrFeedbackMonitorService.processPrReviewEvent`
//       (Q3=A: no monitor double, no standalone marker-match helper). A genuinely
//       external human review thread routes work into the queue; an engine-authored
//       marker-carrying thread (#1130) is excluded and never re-enters.
//   (2) Convergence — the REAL `PhaseLoop.executeLoop` on the `address-pr-feedback`
//       route, seeded exactly as the thin adapter seeds it (SeedAwareReviewExecutor
//       + external-feedback seed). The blocking round-1 verdict routes off-sequence
//       into `remediate`, converts the engine-ready PR back to draft, and after a
//       clean re-review re-marks the PR ready and terminates forward.
//
//   AC1 (T031): the external human thread routes back into `remediate` and the PR
//     is converted back to draft.
//   AC2 / SC-004 (T032): the engine-authored marker-carrying thread is NOT treated
//     as external feedback — no enqueue, no re-entry (the engine never races its
//     own review loop).
//   AC3 (T033): after remediating the external feedback, a clean re-review re-marks
//     the PR ready and the loop converges.
//
// FR-008 scope guard: this suite drives the real monitor + real phase loop; it
// adds no product behavior beyond what #1128–#1131 shipped.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
// --- Detection half: the real PR-feedback monitor -------------------------
import { PrFeedbackMonitorService } from '../services/pr-feedback-monitor-service.js';
import { InMemoryQueueAdapter } from '../services/in-memory-queue-adapter.js';
import type { QueueManager, PrReviewEvent } from '../types/monitor.js';
import type { PrMonitorConfig, RepositoryConfig } from '../config/schema.js';
// --- Convergence half: the real phase loop --------------------------------
import { PhaseLoop } from '../worker/phase-loop.js';
import type { PhaseLoopDeps } from '../worker/phase-loop.js';
import type { WorkerContext, Logger, WorkflowPhase, PhaseResult } from '../worker/types.js';
import { getPhaseSequence } from '../worker/types.js';
import type { WorkerConfig } from '../worker/config.js';
import type { ReviewExecutor } from '../worker/review-executor.js';
import type { ReviewArtifact, Severity } from '../worker/review-artifact.js';
import { SeedAwareReviewExecutor } from '../worker/seed-aware-review-executor.js';
import { writeExternalFeedbackSeed } from '../worker/external-feedback-seed.js';
import {
  bumpRemediationCount,
  readReviewArtifactSync,
  writeReviewArtifact,
} from '../worker/review-artifact.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

const OWNER = 'test-org';
const REPO = 'test-repo';
const ISSUE = 42;
const PR = 10;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

// ===========================================================================
// Detection half — real PrFeedbackMonitorService factories
// ===========================================================================

function createInMemoryQueueManager(): QueueManager & {
  spies: {
    enqueueIfAbsent: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };
} {
  const noopLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const adapter = new InMemoryQueueAdapter(noopLogger);
  const enqueueIfAbsentSpy = vi.spyOn(adapter, 'enqueueIfAbsent');
  const enqueueSpy = vi.spyOn(adapter, 'enqueue');
  return Object.assign(adapter, {
    spies: {
      enqueueIfAbsent: enqueueIfAbsentSpy as unknown as ReturnType<typeof vi.fn>,
      enqueue: enqueueSpy as unknown as ReturnType<typeof vi.fn>,
    },
  }) as QueueManager & {
    spies: {
      enqueueIfAbsent: ReturnType<typeof vi.fn>;
      enqueue: ReturnType<typeof vi.fn>;
    };
  };
}

function createMockGitHubClient(overrides: Record<string, unknown> = {}) {
  return {
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    listIssuesWithLabel: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue({
      number: ISSUE,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [{ name: 'agent:in-progress', color: '' }],
      assignees: [],
      created_at: '',
      updated_at: '',
    }),
    getIssueLabels: vi.fn().mockResolvedValue([]),
    getPRReviewThreads: vi.fn().mockResolvedValue([]),
    listOpenPullRequests: vi.fn().mockResolvedValue([]),
    replyToPRComment: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
}

const monitorConfig: PrMonitorConfig = {
  enabled: true,
  pollIntervalMs: 60000,
  adaptivePolling: true,
  maxConcurrentPolls: 3,
};

const monitorRepos: RepositoryConfig[] = [{ owner: OWNER, repo: REPO }];

function createPrReviewEvent(overrides: Partial<PrReviewEvent> = {}): PrReviewEvent {
  return {
    owner: OWNER,
    repo: REPO,
    prNumber: PR,
    prBody: `Fixes #${ISSUE}`,
    branchName: `${ISSUE}-feature-branch`,
    source: 'webhook',
    prMerged: false,
    ...overrides,
  };
}

/** A genuinely external human review thread (trusted MEMBER, no engine marker). */
const EXTERNAL_HUMAN_THREAD = {
  rootCommentId: 201,
  isResolved: false,
  comments: [
    {
      id: 201,
      body: 'Please rename `foo` to `bar` in src/app.ts.',
      author: 'maintainer',
      authorAssociation: 'MEMBER',
      created_at: '',
      updated_at: '',
      path: 'src/app.ts',
      line: 10,
    },
  ],
};

/** An engine-authored thread carrying the P2 round marker (#1130 exclusion). */
const ENGINE_AUTHORED_THREAD = {
  rootCommentId: 501,
  isResolved: false,
  comments: [
    {
      id: 501,
      body: '<!-- generacy-engine-review round=1 -->\n\nEngine finding text',
      author: 'cluster-bot',
      authorAssociation: 'MEMBER',
      created_at: '',
      updated_at: '',
    },
  ],
};

// ===========================================================================
// Convergence half — real PhaseLoop on the address-pr-feedback route
// ===========================================================================

function baseDeps(): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onPhaseExecutedWithoutCompletion: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      onRepeatedError: vi.fn().mockResolvedValue(undefined),
      onGateHit: vi.fn().mockResolvedValue(undefined),
    } as any,
    stageCommentManager: {
      updateStageComment: vi.fn().mockResolvedValue(undefined),
      postFailureAlert: vi.fn().mockResolvedValue(undefined),
    } as any,
    gateChecker: {
      checkGates: vi.fn((phase: WorkflowPhase, workflowName: string, config: WorkerConfig) =>
        (config.gates[workflowName] ?? []).filter((g) => g.phase === phase),
      ),
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
      getPrNumber: vi.fn().mockReturnValue(PR),
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

/**
 * Convergence-round delegate: mirrors the real executor's write contract and
 * returns a CLEAN verdict — i.e. the remediation fixed the external finding, so
 * the re-review has nothing left to block on and the loop advances forward.
 */
function makeCleanDelegate(checkoutPath: string): ReviewExecutor {
  const execute = vi.fn(async (): Promise<PhaseResult> => {
    const prior = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    const round = (prior?.round ?? 0) + 1;
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [],
      verdict: 'clean',
      round,
      lastReviewedCommitSha: `sha${round}`,
      remediationCount: prior?.remediationCount ?? 0,
    });
    return makeSuccessResult('review');
  });
  return { execute } as unknown as ReviewExecutor;
}

function makeFindingsReader(
  checkoutPath: string,
): (context: WorkerContext) => Promise<{ artifact: ReviewArtifact; blockingSeverity: Severity } | null> {
  return async () => {
    const ra = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    if (!ra) return null;
    // Live seam shape (#1161): the canonical artifact (round lives in `ra.round`)
    // plus the blocking severity used for the poster's render projection.
    return { artifact: ra, blockingSeverity: 'critical' };
  };
}

function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

function routeContext(checkoutPath: string): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback',
    } as any,
    startPhase: 'review',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
      getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      commitExistsInCheckout: vi.fn().mockResolvedValue(true),
      getIssue: vi.fn().mockResolvedValue({ labels: [], state: 'open' }),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}`,
    description: 'test',
  };
}

function routeConfig(): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: '',
    // Configure the cap gate so the test proves convergence does NOT trip it.
    gates: {
      'speckit-feature': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
    },
    maxImplementRetries: 0,
    reviewPhaseEnabled: true,
  } as WorkerConfig;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('#1132 US3 — external feedback re-entry + engine-thread exclusion', () => {
  describe('detection (real PrFeedbackMonitorService)', () => {
    let queueManager: ReturnType<typeof createInMemoryQueueManager>;

    beforeEach(() => {
      queueManager = createInMemoryQueueManager();
    });

    it('T031/AC1: an external human review thread on a ready PR routes into remediation (enqueue + waiting-for label)', async () => {
      const client = createMockGitHubClient({
        getPRReviewThreads: vi.fn().mockResolvedValue([EXTERNAL_HUMAN_THREAD]),
      });
      const service = new PrFeedbackMonitorService(
        mockLogger,
        vi.fn().mockReturnValue(client),
        queueManager,
        monitorConfig,
        monitorRepos,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );

      const result = await service.processPrReviewEvent(createPrReviewEvent());

      expect(result).toBe(true);
      // The waiting-for label is applied BEFORE enqueue (#879 FR-010) — this is
      // the routing signal the phase loop's address-pr-feedback re-entry keys on.
      expect(client.addLabels).toHaveBeenCalledWith(OWNER, REPO, ISSUE, [
        'waiting-for:address-pr-feedback',
      ]);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          issueNumber: ISSUE,
          command: 'address-pr-feedback',
          metadata: expect.objectContaining({
            prNumber: PR,
            reviewThreadIds: [201],
          }),
        }),
      );
    });

    it('T032/AC2/SC-004: an engine-authored marker-carrying thread is excluded — no enqueue, no re-entry', async () => {
      const client = createMockGitHubClient({
        getPRReviewThreads: vi.fn().mockResolvedValue([ENGINE_AUTHORED_THREAD]),
      });
      const service = new PrFeedbackMonitorService(
        mockLogger,
        vi.fn().mockReturnValue(client),
        queueManager,
        monitorConfig,
        monitorRepos,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );

      const result = await service.processPrReviewEvent(createPrReviewEvent());

      // The engine never races its own review loop: the marker-carrying thread
      // contributes 0 to the trusted-unresolved count, so nothing is enqueued and
      // no `waiting-for:address-pr-feedback` label is applied.
      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      expect(client.addLabels).not.toHaveBeenCalledWith(OWNER, REPO, ISSUE, [
        'waiting-for:address-pr-feedback',
      ]);
    });

    it('T032: a thread mixing an engine marker with a genuine external comment still re-enters (exclusion is all-or-nothing)', async () => {
      const mixedThread = {
        rootCommentId: 601,
        isResolved: false,
        comments: [
          {
            id: 601,
            body: '<!-- generacy-finding:abc123 -->\n\nEngine inline finding',
            author: 'cluster-bot',
            authorAssociation: 'MEMBER',
            created_at: '',
            updated_at: '',
          },
          {
            id: 602,
            body: 'Human reviewer: please also handle the null case',
            author: 'maintainer',
            authorAssociation: 'MEMBER',
            created_at: '',
            updated_at: '',
          },
        ],
      };
      const client = createMockGitHubClient({
        getPRReviewThreads: vi.fn().mockResolvedValue([mixedThread]),
      });
      const service = new PrFeedbackMonitorService(
        mockLogger,
        vi.fn().mockReturnValue(client),
        queueManager,
        monitorConfig,
        monitorRepos,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );

      const result = await service.processPrReviewEvent(createPrReviewEvent());

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'address-pr-feedback',
          metadata: expect.objectContaining({ reviewThreadIds: [601] }),
        }),
      );
    });
  });

  describe('convergence (real PhaseLoop on the address-pr-feedback route)', () => {
    let phaseLoop: PhaseLoop;
    let checkoutPath: string;

    beforeEach(async () => {
      phaseLoop = new PhaseLoop(mockLogger);
      checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-ext-remediate-'));
    });

    afterEach(async () => {
      await fs.rm(checkoutPath, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it('T031/T033/AC1/AC3: external feedback → draft → remediate → clean re-review → ready → converge', async () => {
      // The thin adapter seeds the external feedback exactly as the monitor's
      // enqueue drives it: a body-only finding on the PR.
      await writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, {
        version: 1,
        prNumber: PR,
        seededAt: new Date().toISOString(),
        findings: [
          {
            id: 'RT_201',
            body: 'review body (no file anchor):\n\nplease rename this module',
            author: 'maintainer',
          },
        ],
      });

      const deps = baseDeps();
      // Round 1 consumes the seed → changes-required; convergence round delegates
      // to the clean executor.
      deps.reviewExecutor = new SeedAwareReviewExecutor({
        delegate: makeCleanDelegate(checkoutPath),
        logger: mockLogger,
      }) as any;
      deps.remediateTrigger = (ctx) =>
        readReviewArtifactSync(ctx.checkoutPath, WORKFLOW_ID)?.verdict === 'changes-required';
      const remediateExecute = vi.fn(async (): Promise<PhaseResult> => {
        await bumpRemediationCount(checkoutPath, WORKFLOW_ID);
        return makeSuccessResult('remediate');
      });
      deps.remediateExecutor = { execute: remediateExecute } as any;
      deps.readFindingsArtifact = makeFindingsReader(checkoutPath);
      deps.reviewPoster = {
        postRound: vi.fn().mockResolvedValue(undefined),
        resolveResolvedThreads: vi.fn().mockResolvedValue(undefined),
      } as any;
      deps.settings = { workflows: { 'speckit-feature': { maxRemediations: 3 } } } as any;

      const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];
      const result = await phaseLoop.executeLoop(
        routeContext(checkoutPath),
        routeConfig(),
        deps,
        sequence,
      );

      // AC3: a clean re-review terminates the loop forward into validate.
      expect(result.completed).toBe(true);
      expect(result.gateHit).toBe(false);
      expect(result.lastPhase).toBe('validate');

      // AC1: the seeded blocking round routes off-sequence into `remediate`, then
      // the clean re-review advances into `validate`.
      expect(phaseStartOrder(deps)).toEqual(['review', 'remediate', 'review', 'validate']);

      // AC1 (T031): the single remediate entry converts the engine-ready PR back
      // to draft.
      expect(deps.prManager.convertToDraftIfEngineMarkedReady).toHaveBeenCalledTimes(1);
      // AC3 (T033): the clean re-review re-marks the PR ready.
      expect(deps.prManager.markReadyForReview).toHaveBeenCalledTimes(1);

      // One remediation round drove the fix; convergence never trips the cap gate.
      expect(remediateExecute).toHaveBeenCalledTimes(1);
      expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();

      const finalArtifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
      expect(finalArtifact.verdict).toBe('clean');
      expect(finalArtifact.remediationCount).toBe(1);
    });
  });
});
