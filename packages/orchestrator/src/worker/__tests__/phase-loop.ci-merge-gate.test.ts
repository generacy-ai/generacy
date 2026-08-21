// #1133 — phase-loop integration for the CI-aware merge gate (US3).
//
// SC-001 (skipped≠passed): a green `validate` whose head-SHA CI is skipped-only
//   reads as `pending` → the readiness wait times out → the workflow pauses with
//   `waiting-for:ci`, and the relocated `implementation-review` gate is NEVER
//   raised (readiness is blocked).
// SC-002: green CI on a green `validate` → the `on-ci-green` gate fires and the
//   relocated `implementation-review` gate is raised on `validate`.
// SC-003: satisfying the gate (a `continue` re-entry at `validate` carrying both
//   `completed:validate` and `completed:implementation-review`) short-circuits to
//   a completed, merge-eligible terminal state cockpit can read (research
//   Decision 5, terminal no-op resume).
// SC-006: flag OFF → byte-identical run; the CI readout is never consulted.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, PhaseResult, WorkflowPhase } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { CiRun } from '@generacy-ai/workflow-engine';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

const OWNER = 'test';
const REPO = 'repo';
const ISSUE = 1133;

/** Relocated (flag-ON) gate: implementation-review fires on `validate` via on-ci-green. */
const CI_GREEN_GATE = {
  phase: 'validate' as const,
  gateLabel: 'waiting-for:implementation-review',
  condition: 'on-ci-green' as const,
};

/** Flag-OFF default gate: implementation-review sits on `implement`, on-request (never fires unbidden). */
const FLAG_OFF_GATE = {
  phase: 'implement' as const,
  gateLabel: 'waiting-for:implementation-review',
  condition: 'on-request' as const,
};

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
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
      markSiblingsReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

interface ContextOverrides {
  ciRuns?: CiRun[];
  ciRunsFn?: ReturnType<typeof vi.fn>;
  issueLabels?: string[];
  startPhase?: WorkflowPhase;
  command?: 'process' | 'continue';
}

function createMockContext(checkoutPath: string, overrides: ContextOverrides = {}): WorkerContext {
  const getCiRunsForSha =
    overrides.ciRunsFn ??
    vi.fn().mockResolvedValue({ runs: overrides.ciRuns ?? [], source: 'check-runs' });
  return {
    workerId: 'test-worker',
    item: {
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      workflowName: 'speckit-feature',
      command: overrides.command ?? 'process',
    } as any,
    startPhase: overrides.startPhase ?? 'implement',
    // `branch` intentionally left unset: the #1051 phase-start push guard only
    // runs when it is populated, and this suite exercises the CI-readiness path
    // (which does not depend on the branch value — getCiRunsForSha is mocked).
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      commitExistsInCheckout: vi.fn().mockResolvedValue(true),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getIssue: vi.fn().mockResolvedValue({ labels: overrides.issueLabels ?? [] }),
      getCiRunsForSha,
      addIssueComment: vi.fn().mockResolvedValue(undefined),
      removeLabels: vi.fn().mockResolvedValue(undefined),
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
    ciWaitTimeoutMs: 900_000,
    ciMergeGateEnabled: false,
    gates: { 'speckit-feature': [] },
    maxImplementRetries: 2,
    ...overrides,
  } as WorkerConfig;
}

function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
}

function onGateHitCalls(deps: PhaseLoopDeps): unknown[][] {
  return (deps.labelManager.onGateHit as any).mock.calls;
}

describe('#1133 — CI-aware merge gate (phase-loop)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'phase-loop-ci-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('SC-001: skipped-only CI on a green validate blocks readiness — pauses on waiting-for:ci, implementation-review NOT raised', async () => {
    // Skipped runs drop out of the rollup → pending → the wait times out.
    // ciWaitTimeoutMs: 0 makes the timeout immediate (the raw-cast config
    // bypasses the Zod min(30_000), so a real-timer wait resolves at once).
    const context = createMockContext(checkoutPath, {
      ciRuns: [{ status: 'completed', conclusion: 'skipped' }],
    });
    const config = createConfig({
      ciMergeGateEnabled: true,
      ciWaitTimeoutMs: 0,
      gates: { 'speckit-feature': [CI_GREEN_GATE] },
    });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    // Paused on the CI gate, not the review gate.
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith('validate', 'waiting-for:ci');
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalledWith(
      'validate',
      'waiting-for:implementation-review',
    );
    // The readout was consulted (readiness was actually evaluated).
    expect(context.github.getCiRunsForSha).toHaveBeenCalled();
  });

  it('SC-002: green CI on a green validate raises the relocated implementation-review gate on validate', async () => {
    const context = createMockContext(checkoutPath, {
      ciRuns: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'skipped' },
      ],
    });
    const config = createConfig({
      ciMergeGateEnabled: true,
      ciWaitTimeoutMs: 900_000,
      gates: { 'speckit-feature': [CI_GREEN_GATE] },
    });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    // The gate raised is implementation-review on validate (never waiting-for:ci).
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith(
      'validate',
      'waiting-for:implementation-review',
    );
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalledWith('validate', 'waiting-for:ci');
    // The PR was flipped ready-for-review so repo CI (ready_for_review-triggered) runs.
    expect(deps.prManager.markReadyForReview).toHaveBeenCalled();
    // The pause grants completed:validate (this is a post-completion gate), so the
    // approve→resume terminal no-op (SC-003) sees the label state the pause really
    // leaves and cockpit treats the PR as merge-eligible while it waits.
    expect(deps.labelManager.onPhaseComplete).toHaveBeenCalledWith('validate');
  });

  it('SC-003: a continue re-entry at validate with completed:validate + completed:implementation-review is a merge-eligible terminal no-op', async () => {
    const context = createMockContext(checkoutPath, {
      startPhase: 'validate',
      command: 'continue',
      issueLabels: ['completed:validate', 'completed:implementation-review'],
    });
    const config = createConfig({
      ciMergeGateEnabled: true,
      gates: { 'speckit-feature': [CI_GREEN_GATE] },
    });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // Nothing left to run: the gate is satisfied and validate is complete.
    expect(result.completed).toBe(true);
    expect(result.lastPhase).toBe('validate');
    expect(result.gateHit).toBe(false);
    // No phase re-ran; no CI readout was needed on the terminal no-op path.
    expect(phaseStartOrder(deps)).toEqual([]);
    expect(context.github.getCiRunsForSha).not.toHaveBeenCalled();
  });

  it('SC-006: flag OFF → byte-identical run, CI readout never consulted', async () => {
    const context = createMockContext(checkoutPath, {
      ciRuns: [{ status: 'completed', conclusion: 'skipped' }],
    });
    const config = createConfig({
      ciMergeGateEnabled: false,
      gates: { 'speckit-feature': [FLAG_OFF_GATE] },
    });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(result.completed).toBe(true);
    // implement → validate, no CI pause, no gate raised.
    expect(phaseStartOrder(deps)).toEqual(['implement', 'validate']);
    expect(onGateHitCalls(deps)).toEqual([]);
    // The CI readiness path is entirely inert when the flag is off.
    expect(context.github.getCiRunsForSha).not.toHaveBeenCalled();
  });
});

// #1157 — red CI must not silently complete the workflow.
describe('#1157 — red-CI pause (phase-loop)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'phase-loop-ci-1157-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('SC-001/SC-003/FR-009: validate success + not-passed verdict pauses on waiting-for:ci, never grants completed:validate, posts a reason comment', async () => {
    const context = createMockContext(checkoutPath, {
      ciRuns: [{ status: 'completed', conclusion: 'failure' }],
    });
    const config = createConfig({
      ciMergeGateEnabled: true,
      ciWaitTimeoutMs: 900_000,
      gates: { 'speckit-feature': [CI_GREEN_GATE] },
    });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    // Recoverable pause, not a silent completion.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    // onGateHit('validate', 'waiting-for:ci') is what applies waiting-for:ci +
    // agent:paused and removes phase:validate (FR-009). Never the review gate.
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith('validate', 'waiting-for:ci');
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalledWith(
      'validate',
      'waiting-for:implementation-review',
    );
    // INV-2: completed:validate is NEVER granted on the red path.
    expect(deps.labelManager.onPhaseComplete).not.toHaveBeenCalledWith('validate');
    // FR-004: a best-effort reason comment is attempted.
    expect(context.github.addIssueComment).toHaveBeenCalled();
    // The readout was actually consulted (a real red verdict, not a fast-fail).
    expect(context.github.getCiRunsForSha).toHaveBeenCalled();
  });

  it('SC-002: the red path does not complete the phase or re-mark the PR ready a second time', async () => {
    const context = createMockContext(checkoutPath, {
      ciRuns: [{ status: 'completed', conclusion: 'failure' }],
    });
    const config = createConfig({
      ciMergeGateEnabled: true,
      ciWaitTimeoutMs: 900_000,
      gates: { 'speckit-feature': [CI_GREEN_GATE] },
    });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    // markReadyForReview fires exactly once (before the CI wait); the red path
    // returns without a second flip.
    expect(deps.prManager.markReadyForReview).toHaveBeenCalledTimes(1);
    // No completion label surgery for validate.
    expect(deps.labelManager.onPhaseComplete).not.toHaveBeenCalledWith('validate');
  });

  it('SC-004: getCurrentCommitSha throwing fast-fails into the pause without polling CI (no getCiRunsForSha)', async () => {
    // Start at `validate` so the `implement` product-diff guard (the only phase in
    // PHASES_REQUIRING_CHANGES, which also consumes getCurrentCommitSha) is skipped;
    // the sole getCurrentCommitSha caller is then the validate-phase CI-readiness fast-fail.
    const context = createMockContext(checkoutPath, {
      ciRuns: [{ status: 'completed', conclusion: 'success' }],
      startPhase: 'validate',
    });
    (context.github.getCurrentCommitSha as any).mockRejectedValue(
      new Error('detached HEAD / no commit'),
    );
    const config = createConfig({
      ciMergeGateEnabled: true,
      // A long timeout: if the fast-fail regressed into waitForCiGreen this would
      // hang well past the test budget. It must return immediately instead.
      ciWaitTimeoutMs: 900_000,
      gates: { 'speckit-feature': [CI_GREEN_GATE] },
    });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith('validate', 'waiting-for:ci');
    expect(deps.labelManager.onPhaseComplete).not.toHaveBeenCalledWith('validate');
    // FR-005 ordering guarantee: the readout is never invoked on the fast-fail path.
    expect(context.github.getCiRunsForSha).not.toHaveBeenCalled();
  });

  it("SC-004: getCurrentCommitSha returning the 'unknown' sentinel also fast-fails without polling", async () => {
    const context = createMockContext(checkoutPath, {
      ciRuns: [{ status: 'completed', conclusion: 'success' }],
      startPhase: 'validate',
    });
    (context.github.getCurrentCommitSha as any).mockResolvedValue('unknown');
    const config = createConfig({
      ciMergeGateEnabled: true,
      ciWaitTimeoutMs: 900_000,
      gates: { 'speckit-feature': [CI_GREEN_GATE] },
    });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith('validate', 'waiting-for:ci');
    expect(context.github.getCiRunsForSha).not.toHaveBeenCalled();
  });
});
