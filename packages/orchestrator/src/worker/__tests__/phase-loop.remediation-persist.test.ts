// #1162 T007 (SC-003, FR-003) — Redis-backed remediation-counter persistence.
//
// Once the engine sidecar stops being committed to the PR branch (the FR-001
// staging filter), a worker restart / fresh re-clone loses the on-disk
// `remediationCount`. The phase loop mirrors the post-bump count to a durable
// Redis key `remediation-count:<owner>:<repo>:<issue>:<branch>` and reconciles
// disk := max(disk, redis) at the top of the `on-remediation-limit` gate check,
// so the synchronous gate reader observes the spent budget and the cap still
// fires at the same effective attempt.
//
// Pins three behaviours by driving PhaseLoop.executeLoop through the real gate
// path in phase-loop.ts:
//   G1 — disk absent (re-clone) but Redis holds N ⇒ reconcile seeds disk to N,
//        the cap fires immediately (no extra remediate loop).
//   G3 — Redis down (`getValueRaw` returns null) ⇒ reconcile is skipped, the
//        gate falls back to the disk value, and nothing crashes.
//   reset — a `completed:remediation-limit` resume resets disk to 0 AND clears
//        the durable Redis mirror via `clearRaw`.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, WorkflowPhase, PhaseResult } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { OrchestratorSettings } from '@generacy-ai/config';
import { readReviewArtifactSync, writeReviewArtifact } from '../review-artifact.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

const OWNER = 'christrudelpw';
const REPO = 'snappoll';
const ISSUE = 1162;
const PR_NUMBER = 4242;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;
const WORKFLOW = 'speckit-feature';
const MAX = 3;
const REMEDIATION_COUNT_KEY = `remediation-count:${OWNER}:${REPO}:${ISSUE}:no-branch`;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

// A scripted review executor that always finds an unresolved blocker (verdict
// `changes-required`), preserving whatever `remediationCount` the prior round
// left on disk (0 on a fresh re-clone).
function makeScriptedReviewExecutor(checkoutPath: string) {
  const execute = vi.fn(async (): Promise<PhaseResult> => {
    const prior = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    const round = (prior?.round ?? 0) + 1;
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [
        {
          severity: 'critical' as const,
          file: 'src/cap.ts',
          line: 12,
          title: 'unresolved blocker',
          detail: 'must fix before ready',
          round,
          status: 'open' as const,
        },
      ],
      verdict: 'changes-required',
      round,
      lastReviewedCommitSha: `sha${round}`,
      remediationCount: prior?.remediationCount ?? 0,
    });
    return makeSuccessResult('review');
  });
  return { execute };
}

// Map-backed PhaseTracker double (Redis up). Keys for phase-start-ref,
// review-findings, and remediation-count share the store but never collide.
function makeTracker(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    getValueRaw: vi.fn(async (k: string) => store.get(k) ?? null),
    setValueRaw: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    clearRaw: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  };
}

// Redis-down double: every read returns null; writes/clears are no-ops.
function makeNullTracker() {
  return {
    getValueRaw: vi.fn(async () => null),
    setValueRaw: vi.fn(async () => {}),
    clearRaw: vi.fn(async () => {}),
  };
}

function baseDeps(): PhaseLoopDeps {
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
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
      getPrNumber: vi.fn().mockReturnValue(PR_NUMBER),
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function capContext(checkoutPath: string, labels: string[] = []): WorkerContext {
  const labelSet = [...labels];
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: {
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      workflowName: WORKFLOW,
    } as any,
    startPhase: 'review',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
      getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      commitExistsInCheckout: vi.fn().mockResolvedValue(true),
      getIssue: vi.fn().mockImplementation(async () => ({ labels: [...labelSet], state: 'open' })),
      getIssueLabels: vi.fn().mockImplementation(async () => [...labelSet]),
      addIssueComment: vi.fn().mockResolvedValue(undefined),
      removeLabels: vi.fn().mockImplementation(async (_o: string, _r: string, _n: number, toRemove: string[]) => {
        for (const l of toRemove) {
          const idx = labelSet.indexOf(l);
          if (idx >= 0) labelSet.splice(idx, 1);
        }
      }),
      listPrCommentBodies: vi.fn().mockResolvedValue([]),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}`,
    description: 'test',
  };
}

function capConfig(): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: '',
    gates: {
      'speckit-feature': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
    },
    maxImplementRetries: 0,
    reviewPhaseEnabled: true,
  } as WorkerConfig;
}

// Prior run already spent the full remediation budget: rc === MAX, still
// changes-required, round past the cap.
async function seedCappedState(checkoutPath: string): Promise<void> {
  await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
    findings: [
      { severity: 'critical', file: 'src/cap.ts', line: 12, title: 'unresolved blocker', detail: 'x', round: MAX + 1, status: 'open' },
    ],
    verdict: 'changes-required',
    round: MAX + 1,
    lastReviewedCommitSha: 'capped',
    remediationCount: MAX,
  });
}

const CAPPED_SETTINGS = {
  workflows: { [WORKFLOW]: { maxRemediations: MAX } },
} as OrchestratorSettings;

describe('PhaseLoop remediation-count persistence (#1162 SC-003 / FR-003)', () => {
  let phaseLoop: PhaseLoop;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phaseloop-persist-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('G1: reconciles from the Redis mirror after a re-clone and the cap fires at the same attempt', async () => {
    // Simulate a fresh re-clone: no disk sidecar. Redis still holds the spent
    // budget from before the restart.
    const tracker = makeTracker({ [REMEDIATION_COUNT_KEY]: String(MAX) });
    const deps = baseDeps();
    deps.phaseTracker = tracker as any;
    deps.settings = CAPPED_SETTINGS;
    const reviewExecutor = makeScriptedReviewExecutor(checkoutPath);
    deps.reviewExecutor = reviewExecutor as any;

    const ctx = capContext(checkoutPath);
    const sequence = getPhaseSequence(WORKFLOW, true) as WorkflowPhase[];
    const result = await phaseLoop.executeLoop(ctx, capConfig(), deps, sequence);

    // Cap fired on the first review pass — no remediate loop was needed.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    expect(reviewExecutor.execute).toHaveBeenCalledTimes(1);
    // The durable mirror was consulted, and the disk sidecar was reconciled
    // up to the spent budget so the synchronous gate reader saw the cap.
    expect(tracker.getValueRaw).toHaveBeenCalledWith(REMEDIATION_COUNT_KEY);
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)?.remediationCount).toBe(MAX);
  });

  it('G3: with Redis down the gate falls back to the disk value and does not crash', async () => {
    await seedCappedState(checkoutPath);
    const tracker = makeNullTracker();
    const deps = baseDeps();
    deps.phaseTracker = tracker as any;
    deps.settings = CAPPED_SETTINGS;
    const reviewExecutor = makeScriptedReviewExecutor(checkoutPath);
    deps.reviewExecutor = reviewExecutor as any;

    const ctx = capContext(checkoutPath);
    const sequence = getPhaseSequence(WORKFLOW, true) as WorkflowPhase[];
    const result = await phaseLoop.executeLoop(ctx, capConfig(), deps, sequence);

    // Gate still fired — sourced entirely from the disk sidecar.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    expect(tracker.getValueRaw).toHaveBeenCalledWith(REMEDIATION_COUNT_KEY);
    // getValueRaw returned null, so no seed was attempted; disk stays capped.
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)?.remediationCount).toBe(MAX);
  });

  it('reset: a completed:remediation-limit resume zeroes disk and clears the Redis mirror', async () => {
    await seedCappedState(checkoutPath);
    const tracker = makeTracker({ [REMEDIATION_COUNT_KEY]: String(MAX) });
    const deps = baseDeps();
    deps.phaseTracker = tracker as any;
    deps.settings = CAPPED_SETTINGS;
    // No review executor (inert stub) so the seeded capped disk is unchanged
    // at gate time; no remediate trigger so the loop terminates after reset.

    const ctx = capContext(checkoutPath, ['completed:remediation-limit']);
    // Bound the loop to the review phase — the reset resumes past the gate and
    // we assert the reset side effects without dragging in the validate cycle.
    const result = await phaseLoop.executeLoop(ctx, capConfig(), deps, ['review'] as WorkflowPhase[]);

    // Gate satisfied by the operator label → resumed, not paused.
    expect(result.completed).toBe(true);
    // Disk counter reset to a fresh budget.
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)?.remediationCount).toBe(0);
    // Durable mirror cleared so the reset also clears the persisted count.
    expect(tracker.clearRaw).toHaveBeenCalledWith(REMEDIATION_COUNT_KEY);
    // Operator label consumed to re-arm the gate.
    expect(ctx.github.removeLabels).toHaveBeenCalledWith(
      OWNER,
      REPO,
      ISSUE,
      ['completed:remediation-limit'],
    );
  });
});
