// #1124 — phase-loop integration for the REAL review executor + verdict seam.
//
// US2: verdict `clean` continues toward `validate`; verdict `changes-required`
// drives the off-sequence `remediate` seam (via the production-shaped
// `remediateTrigger` that reads the persisted sidecar) and re-enters `review`.
//
// FR-011: when the persisted `round` reaches `maxRemediations`, the new
// `on-remediation-limit` gate fires and the workflow pauses
// (`waiting-for:remediation-limit` + `agent:paused` via `onGateHit`) instead of
// looping forever against the still-stubbed `remediate`.
//
// SC-005: with `reviewPhaseEnabled=false`, `review` is absent from the effective
// sequence and the executor is never invoked (byte-identity with pre-#1124).
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
import type { RemediateExecutor } from '../remediate-executor.js';
import {
  writeReviewArtifact,
  readReviewArtifactSync,
  bumpRemediationCount,
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
const ISSUE = 1124;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

type Verdict = 'clean' | 'changes-required';

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
      // #1125 merge: the remediate seam converts the PR back to draft before
      // remediating; stub it so #1124's changes-required paths exercise the seam.
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

function createMockContext(checkoutPath: string): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      workflowName: 'speckit-feature',
    } as any,
    startPhase: 'implement',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      commitExistsInCheckout: vi.fn().mockResolvedValue(true),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      // Gate pause path fetches labels to check the completed-label short-circuit.
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    } as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}`,
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
    // Only the review gate — keep `implement` gate-free so the loop flows
    // implement → review without an unrelated pause.
    gates: {
      'speckit-feature': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
    },
    maxImplementRetries: 2,
    ...overrides,
  } as WorkerConfig;
}

/**
 * Review executor double that writes a REAL engine-shaped sidecar on each pass,
 * stamping an incrementing round and the verdict chosen by `verdictFor(round)`.
 * The gate and the production-shaped trigger both read that real file.
 */
function makeReviewExecutor(
  checkoutPath: string,
  verdictFor: (round: number) => Verdict,
): { executor: ReviewExecutor; execute: ReturnType<typeof vi.fn> } {
  let round = 0;
  const execute = vi.fn(async () => {
    round += 1;
    const verdict = verdictFor(round);
    // Preserve `remediationCount` (bumped by the remediate executor, #1128) —
    // the review executor only owns `round`/`verdict`/`findings`.
    const prior = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings:
        verdict === 'changes-required'
          ? [{ severity: 'critical', file: 'src/a.ts', title: 'x', detail: 'y', round, status: 'open' }]
          : [],
      verdict,
      round,
      lastReviewedCommitSha: `sha${round}`,
      remediationCount: prior?.remediationCount ?? 0,
    });
    return makeSuccessResult('review');
  });
  return { executor: { execute } as unknown as ReviewExecutor, execute };
}

/**
 * Remediate executor double (#1128): bumps `remediationCount` by exactly one on
 * every invocation, mirroring the real executor's every-return-path increment
 * (Q4=A). The `on-remediation-limit` gate keys on this counter, so the cap tests
 * need a bumping double — the still-stubbed `remediate` never touches the sidecar.
 */
function makeRemediateExecutor(
  checkoutPath: string,
): { executor: RemediateExecutor; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => {
    await bumpRemediationCount(checkoutPath, WORKFLOW_ID);
    return makeSuccessResult('remediate');
  });
  return { executor: { execute } as unknown as RemediateExecutor, execute };
}

/** Production-shaped synchronous trigger: reads the sidecar verdict. */
const remediateTrigger: PhaseLoopDeps['remediateTrigger'] = (ctx) =>
  readReviewArtifactSync(
    ctx.checkoutPath,
    `${ctx.item.owner}/${ctx.item.repo}#${ctx.item.issueNumber}`,
  )?.verdict === 'changes-required';

function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

describe('#1124 — review executor verdict seam + remediation cap', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'phase-loop-review-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('US2: a `clean` verdict continues toward validate without entering remediate', async () => {
    const { executor, execute } = makeReviewExecutor(checkoutPath, () => 'clean');
    deps.reviewExecutor = executor;
    deps.remediateTrigger = remediateTrigger;
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(createMockContext(checkoutPath), config, deps, sequence);

    expect(result.completed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(phaseStartOrder(deps)).toEqual(['implement', 'review', 'validate']);
    // Persisted verdict is clean; no gate fired.
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!.verdict).toBe('clean');
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
  });

  it('US2: `changes-required` routes into remediate, then a clean re-review reaches validate', async () => {
    // round 1 → changes-required (drives one remediate); round 2 → clean.
    const { executor } = makeReviewExecutor(checkoutPath, (r) => (r === 1 ? 'changes-required' : 'clean'));
    deps.reviewExecutor = executor;
    deps.remediateTrigger = remediateTrigger;
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(createMockContext(checkoutPath), config, deps, sequence);

    expect(result.completed).toBe(true);
    expect(phaseStartOrder(deps)).toEqual(['implement', 'review', 'remediate', 'review', 'validate']);
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('remediate');
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
  });

  it('FR-011: exhausting maxRemediations fires the on-remediation-limit gate and pauses', async () => {
    // Always changes-required → the loop would spin forever; the counter-based
    // cap must break it. The remediate executor double bumps `remediationCount`
    // by one each pass (#1128); the gate keys on that counter, not `round`.
    const { executor } = makeReviewExecutor(checkoutPath, () => 'changes-required');
    const { executor: remediateExecutor } = makeRemediateExecutor(checkoutPath);
    deps.reviewExecutor = executor;
    deps.remediateExecutor = remediateExecutor;
    deps.remediateTrigger = remediateTrigger;
    const config = createConfig({ reviewPhaseEnabled: true });
    const settings: OrchestratorSettings = {
      workflows: { 'speckit-feature': { maxRemediations: 2 } },
    };
    deps.settings = settings;
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(createMockContext(checkoutPath), config, deps, sequence);

    // Paused, did not complete.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    // implement → review(r1,count0) → remediate(→1) → review(r2,count1) →
    // remediate(→2) → review(r3,count2) → gate fires (count 2 >= 2).
    expect(phaseStartOrder(deps)).toEqual([
      'implement',
      'review',
      'remediate',
      'review',
      'remediate',
      'review',
    ]);
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith('review', 'waiting-for:remediation-limit');
    const artifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
    expect(artifact.round).toBe(3);
    expect(artifact.remediationCount).toBe(2);
  });

  it('FR-011: a `clean` verdict landing on the cap round advances to validate (gate keys on verdict, not count alone)', async () => {
    // round 1 → changes-required (drives one remediate, bumping the counter to
    // maxRemediations=1); round 2 → clean. The counter cap is reached but the
    // review is CLEAN — this is NOT exhaustion (Q5=A), so the gate must NOT fire
    // and the loop must proceed to validate. Regression guard for the
    // on-remediation-limit gate ignoring the verdict conjunct.
    const { executor } = makeReviewExecutor(checkoutPath, (r) => (r === 1 ? 'changes-required' : 'clean'));
    const { executor: remediateExecutor } = makeRemediateExecutor(checkoutPath);
    deps.reviewExecutor = executor;
    deps.remediateExecutor = remediateExecutor;
    deps.remediateTrigger = remediateTrigger;
    const config = createConfig({ reviewPhaseEnabled: true });
    const settings: OrchestratorSettings = {
      workflows: { 'speckit-feature': { maxRemediations: 1 } },
    };
    deps.settings = settings;
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(createMockContext(checkoutPath), config, deps, sequence);

    // Completed — the clean verdict at the cap round did NOT pause.
    expect(result.completed).toBe(true);
    // implement → review(r1, changes-required, count0) → remediate(→1) →
    // review(r2, clean, count1 === max) → validate.
    expect(phaseStartOrder(deps)).toEqual(['implement', 'review', 'remediate', 'review', 'validate']);
    // The gate must not have fired despite remediationCount === maxRemediations.
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
    const artifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
    expect(artifact.round).toBe(2);
    expect(artifact.remediationCount).toBe(1);
    expect(artifact.verdict).toBe('clean');
  });

  it('SC-005: with reviewPhaseEnabled=false, review is absent and the executor is never invoked', async () => {
    const { executor, execute } = makeReviewExecutor(checkoutPath, () => 'changes-required');
    deps.reviewExecutor = executor;
    deps.remediateTrigger = remediateTrigger;
    const config = createConfig({ reviewPhaseEnabled: false });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(createMockContext(checkoutPath), config, deps, sequence);

    expect(result.completed).toBe(true);
    expect(sequence).not.toContain('review');
    expect(execute).not.toHaveBeenCalled();
    const order = phaseStartOrder(deps);
    expect(order).not.toContain('review');
    expect(order).not.toContain('remediate');
    expect(order).toEqual(['implement', 'validate']);
  });
});
