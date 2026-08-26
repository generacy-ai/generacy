// #1130 (T014) — end-to-end address-pr-feedback route (SC-002/SC-004).
//
// Composes the REAL production modules the thin `address-pr-feedback` adapter
// wires together — the dual-source parser, the external-feedback seed sidecar,
// the SeedAwareReviewExecutor, and the phase loop — against a temp checkout and
// a mock GitHubClient. It proves the whole route without spinning up the worker:
//
//   1. A trusted external unresolved thread AND a trusted review body parse into
//      dual-source findings (a review-body-only finding survives with its
//      no-anchor prefix — FR-004).
//   2. The findings seed the loop; round-1 `review` consumes the seed, writes a
//      `changes-required` artifact WITHOUT spawning the review CLI, and deletes
//      the seed (consume-once).
//   3. `remediateTrigger` (the real synchronous `readReviewArtifactSync` verdict
//      probe) fires → off-sequence `remediate` runs → the loop backtracks.
//   4. The convergence `review` round finds no seed and DELEGATES to the real
//      executor, which converges to `clean` and the loop resumes to `validate`.
//
// The legacy fixer fix-CLI path is never taken (FR-003): no `cliSpawner.spawnPhase`
// is invoked for `review`/`remediate`, and the delegate is the sole convergence
// executor.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment, GitHubClient, Review } from '@generacy-ai/workflow-engine';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { Logger, PhaseResult, WorkerContext, WorkflowPhase } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import { SeedAwareReviewExecutor } from '../seed-aware-review-executor.js';
import type { ReviewExecutor } from '../review-executor.js';
import { parseExternalFeedback } from '../pr-feedback-parser.js';
import {
  readExternalFeedbackSeed,
  writeExternalFeedbackSeed,
} from '../external-feedback-seed.js';
import {
  readReviewArtifact,
  readReviewArtifactSync,
  writeReviewArtifact,
} from '../review-artifact.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

const OWNER = 'test';
const REPO = 'repo';
const ISSUE = 1130;
const PR = 99;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 100, output: [] };
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
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function createContext(checkoutPath: string): WorkerContext {
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
      getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      commitExistsInCheckout: vi.fn().mockResolvedValue(true),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}`,
    description: 'test',
  };
}

function createConfig(): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: '',
    gates: {},
    maxImplementRetries: 2,
    reviewPhaseEnabled: true,
  } as WorkerConfig;
}

/** A trusted (OWNER-tier) inline review comment anchored to a file+line. */
function trustedInlineComment(): Comment {
  const now = new Date().toISOString();
  return {
    id: 5001,
    body: 'Fix the null deref here',
    author: 'octocat',
    created_at: now,
    updated_at: now,
    viewerDidAuthor: false,
    authorAssociation: 'OWNER',
    path: 'src/a.ts',
    line: 12,
  } as Comment;
}

/** A trusted (OWNER-tier) top-level review body with no file anchor. */
function trustedReviewBody(): Review {
  const now = new Date().toISOString();
  return {
    id: 7001,
    user: { login: 'octocat' },
    body: 'Please rename this module for clarity across the codebase.',
    state: 'COMMENTED',
    submittedAt: now,
    authorAssociation: 'OWNER',
  } as unknown as Review;
}

/**
 * Mock GitHubClient serving the parser: one unresolved inline thread and one
 * top-level review body, both from a trusted author.
 */
function createParserGithub(): GitHubClient {
  return {
    getPRReviewThreads: vi.fn(async () => [
      { id: 'RT_1', rootCommentId: 5001, isResolved: false, comments: [trustedInlineComment()] },
    ]),
    listReviews: vi.fn(async () => [trustedReviewBody()] as Review[]),
  } as unknown as GitHubClient;
}

describe('address-pr-feedback end-to-end route (#1130 T014)', () => {
  let checkoutPath: string;
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;

  beforeEach(async () => {
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-feedback-route-'));
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('parses dual-source feedback → seeds → review consumes seed → remediate → convergence delegates, no fixer CLI', async () => {
    // ── Adapter step 1: parse trusted dual-source feedback. ──────────────────
    const parserGithub = createParserGithub();
    const findings = await parseExternalFeedback({
      github: parserGithub,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      checkoutPath,
      logger: mockLogger,
    });

    // Both an inline finding and a review-body-only finding survive (FR-004).
    expect(findings).toHaveLength(2);
    const inline = findings.find((f) => f.path === 'src/a.ts');
    expect(inline?.line).toBe(12);
    const bodyOnly = findings.find((f) => f.body.startsWith('review body (no file anchor):'));
    expect(bodyOnly).toBeDefined();
    expect(bodyOnly?.path).toBeUndefined();

    // ── Adapter step 2: seed the loop. ───────────────────────────────────────
    await writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, {
      version: 1,
      prNumber: PR,
      seededAt: new Date().toISOString(),
      findings,
    });
    // The review-body-only finding is present in the persisted seed.
    const seededBack = await readExternalFeedbackSeed(checkoutPath, WORKFLOW_ID);
    expect(
      seededBack?.findings.some((f) => f.body.startsWith('review body (no file anchor):')),
    ).toBe(true);

    // ── Convergence delegate: a spy standing in for the real ReviewExecutor. ─
    // On the seed-absent round it converges to a clean artifact so the trigger
    // stops firing. It is the SOLE executor invoked for the convergence round.
    const delegateExecute = vi.fn(async (): Promise<PhaseResult> => {
      await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
        findings: [],
        verdict: 'clean',
        round: 2,
        lastReviewedCommitSha: 'deadbeef',
      });
      return { phase: 'review', success: true, exitCode: 0, durationMs: 1, output: [] };
    });
    const delegate = { execute: delegateExecute } as unknown as ReviewExecutor;

    deps.reviewExecutor = new SeedAwareReviewExecutor({ delegate, logger: mockLogger });
    // Production trigger: synchronous verdict probe against the on-disk artifact.
    deps.remediateTrigger = (ctx) =>
      readReviewArtifactSync(ctx.checkoutPath, WORKFLOW_ID)?.verdict === 'changes-required';

    // ── Run the loop starting at `review` (as the worker does). ──────────────
    const context = createContext(checkoutPath);
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];
    const result = await phaseLoop.executeLoop(context, createConfig(), deps, sequence);

    expect(result.completed).toBe(true);

    // Phase order: review(seed) → remediate → review(convergence) → validate.
    const order = (deps.labelManager.onPhaseStart as any).mock.calls.map(
      (c: unknown[]) => c[0] as WorkflowPhase,
    );
    expect(order).toEqual(['review', 'remediate', 'review', 'validate']);

    // Round 1 consumed the seed (deleted, consume-once) without the delegate.
    expect(await readExternalFeedbackSeed(checkoutPath, WORKFLOW_ID)).toBeNull();

    // Convergence round (seed absent) delegated exactly once to the real executor.
    expect(delegateExecute).toHaveBeenCalledTimes(1);

    // FR-003: the legacy fixer fix-CLI path is never taken — no CLI spawn for
    // review or remediate.
    const spawned = (deps.cliSpawner.spawnPhase as any).mock.calls.map(
      (c: unknown[]) => c[0] as WorkflowPhase,
    );
    expect(spawned).not.toContain('review');
    expect(spawned).not.toContain('remediate');

    // Final artifact converged to clean.
    const finalArtifact = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(finalArtifact?.verdict).toBe('clean');
  });
});
