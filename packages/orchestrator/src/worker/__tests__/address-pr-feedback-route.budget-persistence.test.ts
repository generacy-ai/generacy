// #1159 (T007) — SC-001: the remediation budget is bounded ACROSS re-entries.
//
// The #883-class runaway reproduces when every `address-pr-feedback` re-entry
// resets the remediation budget: repeated same-feedback re-entries each derive a
// fresh `remediationCount = 0`, so the `on-remediation-limit` gate is never
// globally reachable and the review↔remediate loop churns forever.
//
// The #1159 fix keeps the budget per-issue-lifecycle rather than per-entry: a
// surviving checkout-local review artifact preserves `remediationCount`
// (seed-aware-review-executor.ts:102 and review-executor.ts). The monitor's
// blanket `failed:*` skip (T001) ensures `clearReviewArtifact`
// (claude-cli-worker.ts:593) is reached only on the two legitimate reset
// occasions (operator-resume / genuinely-new review), so a repeated re-entry on
// the SAME feedback re-seeds ON TOP of the surviving artifact and the budget
// keeps climbing.
//
// This test drives N > maxRemediations `address-pr-feedback` re-entries as N
// separate `PhaseLoop.executeLoop` runs against ONE surviving checkout artifact
// (re-seeding each entry WITHOUT clearing — the runaway condition). It asserts:
//   - `remediationCount` is monotonic across entries (never resets), and
//   - the total remediate executions across all entries is bounded by
//     `maxRemediations` (NOT `maxRemediations` per entry), and
//   - the run parks at `waiting-for:remediation-limit` within that budget.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { OrchestratorSettings } from '@generacy-ai/config';
import type { ReviewExecutor } from '../review-executor.js';
import { SeedAwareReviewExecutor } from '../seed-aware-review-executor.js';
import { writeExternalFeedbackSeed } from '../external-feedback-seed.js';
import {
  bumpRemediationCount,
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
const ISSUE = 1159;
const PR = 77;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;
const MAX_REMEDIATIONS = 3;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
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
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
      listPrCommentBodies: vi.fn().mockResolvedValue([]),
      addIssueComment: vi.fn().mockResolvedValue(undefined),
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
    gates: {
      'speckit-feature': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
    },
    maxImplementRetries: 2,
    reviewPhaseEnabled: true,
  } as WorkerConfig;
}

/**
 * Convergence-round delegate: after a remediate the loop re-reviews; here the
 * (stubbed) fix is accepted so the entry converges to `clean` and proceeds to
 * validate. Critically it PRESERVES `remediationCount` (mirroring the real
 * ReviewExecutor #1128) so the surviving artifact carries the budget forward to
 * the next re-entry.
 */
function makeConvergeCleanDelegate(checkoutPath: string): ReviewExecutor {
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

function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

/**
 * Seed the SAME feedback the monitor would re-enqueue on every poll — the exact
 * repeated-same-feedback condition that produced the #883 runaway.
 */
async function seedSameFeedback(checkoutPath: string): Promise<void> {
  await writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, {
    version: 1,
    prNumber: PR,
    seededAt: new Date().toISOString(),
    findings: [
      {
        id: 'RT_same',
        body: 'the same unresolved review comment, re-surfaced every poll',
        author: 'reviewer',
      },
    ],
  });
}

describe('#1159 T007 — remediation budget is bounded ACROSS address-pr-feedback re-entries (SC-001)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'pr-feedback-budget-'));

    deps.reviewExecutor = new SeedAwareReviewExecutor({
      delegate: makeConvergeCleanDelegate(checkoutPath),
      logger: mockLogger,
    });
    deps.remediateTrigger = (ctx) =>
      readReviewArtifactSync(ctx.checkoutPath, WORKFLOW_ID)?.verdict === 'changes-required';
    deps.remediateExecutor = {
      execute: vi.fn(async (): Promise<PhaseResult> => {
        await bumpRemediationCount(checkoutPath, WORKFLOW_ID);
        return makeSuccessResult('remediate');
      }),
    } as any;
    const settings: OrchestratorSettings = {
      workflows: { 'speckit-feature': { maxRemediations: MAX_REMEDIATIONS } },
    };
    deps.settings = settings;
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('N > maxRemediations re-entries preserve remediationCount and park within maxRemediations total remediate executions', async () => {
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];
    const N = MAX_REMEDIATIONS + 2; // 5 re-entries against a 3-remediation budget.

    const remediationCountsAtEntryStart: (number | undefined)[] = [];
    const results: { completed: boolean; gateHit: boolean }[] = [];

    for (let entry = 0; entry < N; entry++) {
      // Every re-entry re-seeds the SAME feedback WITHOUT clearing the surviving
      // artifact — the runaway condition. A per-entry reset would zero the budget
      // here; the #1159 fix must not.
      remediationCountsAtEntryStart.push(
        readReviewArtifactSync(checkoutPath, WORKFLOW_ID)?.remediationCount,
      );
      await seedSameFeedback(checkoutPath);

      const result = await phaseLoop.executeLoop(
        createContext(checkoutPath),
        createConfig(),
        deps,
        sequence,
      );
      results.push({ completed: result.completed, gateHit: result.gateHit ?? false });

      // Once the gate fires we stop re-entering (the issue is now parked at
      // waiting-for:remediation-limit + agent:paused awaiting an operator).
      if (result.gateHit) break;
    }

    // The budget observed at the start of each entry is monotonically
    // non-decreasing — no re-entry ever reset it (entry 0 starts undefined).
    const observed = remediationCountsAtEntryStart.map((c) => c ?? 0);
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]).toBeGreaterThanOrEqual(observed[i - 1]);
    }

    // Total remediate executions across ALL entries is bounded by the budget,
    // NOT maxRemediations-per-entry (which would be N * maxRemediations).
    const totalRemediateExecutions = (deps.remediateExecutor!.execute as any).mock.calls.length;
    expect(totalRemediateExecutions).toBe(MAX_REMEDIATIONS);

    // The final entry parked at the cap rather than completing.
    const last = results[results.length - 1];
    expect(last.completed).toBe(false);
    expect(last.gateHit).toBe(true);

    // The disposition is the remediation-limit gate — and ONLY that. The legacy
    // blocked:stuck-feedback-loop dead-end is never applied on this flag-ON route.
    const gateLabels = (deps.labelManager.onGateHit as any).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );
    expect(gateLabels).toContain('waiting-for:remediation-limit');
    expect(gateLabels).not.toContain('blocked:stuck-feedback-loop');

    // The surviving artifact hit exactly the budget.
    const finalArtifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
    expect(finalArtifact.remediationCount).toBe(MAX_REMEDIATIONS);
    expect(finalArtifact.verdict).toBe('changes-required');

    // We needed strictly fewer than N entries to exhaust the budget — proving the
    // cap is globally reachable (the whole point of the #1159 fix).
    expect(results.length).toBeLessThanOrEqual(MAX_REMEDIATIONS + 1);
  });
});
