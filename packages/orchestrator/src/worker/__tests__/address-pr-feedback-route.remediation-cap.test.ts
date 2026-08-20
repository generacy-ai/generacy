// #1130 (T017/T018) — external-feedback route: remediation cap + budget reset.
//
// T017 (SC-005): an external-feedback route that keeps producing
// `changes-required` (the stubbed `remediate` never fixes the diff) must land on
// the `waiting-for:remediation-limit` gate. On this flag-ON route the legacy
// `blocked:stuck-feedback-loop` dead-end is NEVER applied — the phase loop's
// remediation-limit gate is this path's bounded stop (FR-005/FR-007/FR-008).
// (The legacy label remains the bounded stop on the flag-OFF handler path;
// see PR #1145 review.) The route is
// seeded exactly as the thin adapter seeds it: a `SeedAwareReviewExecutor` wraps
// the real executor, round 1 consumes the seed, and convergence rounds delegate.
//
// T018 (FR-006, plan D-2): the remediation budget resets ONLY when the adapter
// re-runs and clears the artifact. A fresh seed after `clearReviewArtifact`
// derives `round = 1`; a seed left on top of a surviving artifact keeps climbing
// (thread-resolution / gate-label removal alone must NOT reset the budget).
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
  clearReviewArtifact,
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
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
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
      // Real filter semantics: return the gates configured for this phase.
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
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
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
    // The remediation-limit gate on `review` is the sole gate — this is the
    // disposition the external-feedback route must reach on exhaustion.
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
 * Convergence-round delegate: mirrors the real executor's contract by reading the
 * prior artifact round, incrementing, and re-asserting `changes-required` — i.e.
 * the stubbed `remediate` never satisfied the finding, so the loop keeps
 * re-reviewing until the cap breaks it.
 */
function makeChangesRequiredDelegate(checkoutPath: string): {
  executor: ReviewExecutor;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (): Promise<PhaseResult> => {
    const prior = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    const round = (prior?.round ?? 0) + 1;
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [
        { severity: 'critical', file: 'src/a.ts', title: 'x', detail: 'y', round, status: 'open' },
      ],
      verdict: 'changes-required',
      round,
      lastReviewedCommitSha: `sha${round}`,
      // Mirror the real ReviewExecutor (#1128): a review write preserves the
      // remediation budget rather than resetting it (review-executor.ts).
      remediationCount: prior?.remediationCount ?? 0,
    });
    return makeSuccessResult('review');
  });
  return { executor: { execute } as unknown as ReviewExecutor, execute };
}

function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

async function seedRoute(checkoutPath: string): Promise<void> {
  await writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, {
    version: 1,
    prNumber: PR,
    seededAt: new Date().toISOString(),
    findings: [
      {
        id: 'RT_1',
        body: 'review body (no file anchor):\n\nplease rename this module',
        author: 'octocat',
      },
    ],
  });
}

describe('#1130 external-feedback route — remediation cap & budget reset', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'pr-feedback-cap-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('T017/SC-005: exhausting the cap lands on waiting-for:remediation-limit, never blocked:stuck-feedback-loop', async () => {
    await seedRoute(checkoutPath);

    const { executor: delegate } = makeChangesRequiredDelegate(checkoutPath);
    deps.reviewExecutor = new SeedAwareReviewExecutor({ delegate, logger: mockLogger });
    deps.remediateTrigger = (ctx) =>
      readReviewArtifactSync(ctx.checkoutPath, WORKFLOW_ID)?.verdict === 'changes-required';
    // #1128: the cap is driven by `remediationCount`, bumped once per remediate
    // execution — mirror the real RemediateExecutor here (a stubbed remediate
    // never fixes the diff, so the loop keeps climbing until the count hits the
    // cap). Without a bumping executor the rc-based gate could never fire.
    deps.remediateExecutor = {
      execute: vi.fn(async (): Promise<PhaseResult> => {
        await bumpRemediationCount(checkoutPath, WORKFLOW_ID);
        return makeSuccessResult('remediate');
      }),
    } as any;
    const settings: OrchestratorSettings = {
      workflows: { 'speckit-feature': { maxRemediations: 2 } },
    };
    deps.settings = settings;

    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];
    const result = await phaseLoop.executeLoop(createContext(checkoutPath), createConfig(), deps, sequence);

    // Paused at the cap rather than looping forever against the stub remediate.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);

    // #1128 rc-based cap (maxRemediations=2): review(seed, rc=0) → remediate(rc→1)
    // → review(rc=1) → remediate(rc→2) → review(rc=2) → gate fires (rc >= 2).
    expect(phaseStartOrder(deps)).toEqual(['review', 'remediate', 'review', 'remediate', 'review']);

    // The disposition is the remediation-limit gate — and ONLY that.
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith('review', 'waiting-for:remediation-limit');
    const gateLabels = (deps.labelManager.onGateHit as any).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );
    expect(gateLabels).toEqual(['waiting-for:remediation-limit']);
    // The legacy dead-end label is never applied on this flag-ON route — the
    // remediation-limit gate is this path's bounded stop (FR-007/FR-008).
    expect(gateLabels).not.toContain('blocked:stuck-feedback-loop');

    const finalArtifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
    expect(finalArtifact.remediationCount).toBe(2);
    expect(finalArtifact.round).toBe(3);
  });

  it('T018/FR-006: a fresh seed after clearReviewArtifact derives round = 1 (budget reset)', async () => {
    // Simulate a prior capped state: an artifact at the cap round survives.
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [{ severity: 'critical', file: 'src/a.ts', title: 'x', detail: 'y', round: 2, status: 'open' }],
      verdict: 'changes-required',
      round: 2,
      lastReviewedCommitSha: 'old',
    });

    // The adapter re-run on new trusted feedback clears the artifact (D-2) THEN seeds.
    await clearReviewArtifact(checkoutPath, WORKFLOW_ID);
    await seedRoute(checkoutPath);

    // Delegate must never be reached on a seeded round.
    const delegate = {
      execute: vi.fn(async () => {
        throw new Error('delegate must not run on a seeded round');
      }),
    } as unknown as ReviewExecutor;
    const wrapper = new SeedAwareReviewExecutor({ delegate, logger: mockLogger });

    await wrapper.execute(createContext(checkoutPath));

    const artifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
    expect(artifact.round).toBe(1);
    expect(artifact.verdict).toBe('changes-required');
  });

  it('T018/FR-006: a seed left on a surviving artifact keeps climbing — resolution/gate-removal alone does NOT reset the budget', async () => {
    // Prior artifact at round 2 is NOT cleared (only thread-resolution / label
    // removal happened, which must not touch the checkout-local artifact).
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [{ severity: 'critical', file: 'src/a.ts', title: 'x', detail: 'y', round: 2, status: 'open' }],
      verdict: 'changes-required',
      round: 2,
      lastReviewedCommitSha: 'old',
    });
    await seedRoute(checkoutPath);

    const delegate = {
      execute: vi.fn(async () => {
        throw new Error('delegate must not run on a seeded round');
      }),
    } as unknown as ReviewExecutor;
    const wrapper = new SeedAwareReviewExecutor({ delegate, logger: mockLogger });

    await wrapper.execute(createContext(checkoutPath));

    // round derives from the surviving artifact (2 + 1), not reset to 1.
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!.round).toBe(3);
  });
});
