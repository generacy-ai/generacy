// #1165 Corner 1 (FR-001 / FR-002) — flag-OFF validate-fix fallback.
//
// On the default (reviewPhaseEnabled OFF) path, a failing `validate` gets
// exactly one bounded remediate attempt before escalating. This is the safety
// net that keeps the legacy flag-OFF path self-healing without the full
// engine-native review→remediate loop. The four scenarios below pin the
// contract: one-shot budget, escalation on repeat failure, escalation when no
// remediate adapter exists, and non-interference with the flag-ON path.
//
// See `contracts/flag-off-validate-fix.md` Guard/Steps/Invariants.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkerContext, Logger, WorkflowPhase, PhaseResult } from '../types.js';
import type { WorkerConfig } from '../config.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

const OWNER = 'christrudelpw';
const REPO = 'snappoll';
const ISSUE = 1165;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

function makeFailResult(phase: WorkflowPhase): PhaseResult {
  return {
    phase,
    success: false,
    exitCode: 1,
    durationMs: 1,
    output: [],
    capturedStdout: 'FAIL src/foo.test.ts',
    capturedStderr: 'AssertionError: expected 1 to be 2',
    error: { message: 'validate failed', output: 'AssertionError', phase },
  } as PhaseResult;
}

function makeGithub() {
  return {
    getDefaultBranch: vi.fn().mockResolvedValue('develop'),
    getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
    getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
    getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    commitExistsInCheckout: vi.fn().mockResolvedValue(true),
    getIssue: vi.fn().mockResolvedValue({ labels: [], state: 'open' }),
    discardWorkingTreeChanges: vi.fn().mockResolvedValue(undefined),
    // #1051 phase-start push-guard runs at loop entry when `context.branch` is
    // set. With no PR on the branch it must ALLOW (row 5/6); leaving this
    // unmocked would make the guard throw → refuse (`pr-lookup-failed`) and
    // return before validate ever runs.
    findPRForBranchAnyState: vi.fn().mockResolvedValue(null),
  };
}

interface DepsOptions {
  validateResults: PhaseResult[];
  remediateResult?: PhaseResult;
  includeRemediateExecutor?: boolean;
  reviewPhaseEnabled?: boolean;
}

function makeDeps(opts: DepsOptions): PhaseLoopDeps {
  let validateCall = 0;
  const runValidatePhase = vi.fn(async (): Promise<PhaseResult> => {
    const r = opts.validateResults[Math.min(validateCall, opts.validateResults.length - 1)]!;
    validateCall++;
    return r;
  });

  const deps: PhaseLoopDeps = {
    // Stub the pre-validate base-merge so the loop reaches `runValidatePhase`.
    // The real `performBaseMerge` shells out to git against the temp checkout,
    // which is not a repo — it would throw before validate ever runs.
    baseMergeRunner: vi.fn(async (_p: string, _b: string, baseRef: string) => ({
      ok: true as const,
      baseRef,
    })),
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
      checkGates: vi.fn().mockReturnValue([]),
    } as any,
    cliSpawner: {
      spawnPhase: vi.fn().mockImplementation(async (phase: WorkflowPhase) => makeSuccessResult(phase)),
      runValidatePhase,
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
  };

  if (opts.includeRemediateExecutor !== false) {
    deps.remediateExecutor = {
      execute: vi.fn(async (): Promise<PhaseResult> => opts.remediateResult ?? makeSuccessResult('remediate')),
    } as any;
  }

  return deps;
}

function makeContext(checkoutPath: string): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: { owner: OWNER, repo: REPO, issueNumber: ISSUE, workflowName: 'speckit-feature' } as any,
    startPhase: 'validate',
    github: makeGithub() as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}`,
    description: 'test',
    branch: '1165-feature',
  } as WorkerContext;
}

function makeConfig(reviewPhaseEnabled: boolean): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    preValidateCommand: '',
    gates: {},
    maxImplementRetries: 0,
    reviewPhaseEnabled,
  } as WorkerConfig;
}

function executeCalls(deps: PhaseLoopDeps): number {
  return (deps.remediateExecutor?.execute as any)?.mock.calls.length ?? 0;
}

describe('PhaseLoop flag-OFF validate-fix fallback (#1165 Corner 1 / FR-002)', () => {
  let phaseLoop: PhaseLoop;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phaseloop-flagoff-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('(a) validate fails once → remediate succeeds → validate re-run passes ⇒ completes, no failed:validate, one execute', async () => {
    const deps = makeDeps({
      validateResults: [makeFailResult('validate'), makeSuccessResult('validate')],
      remediateResult: makeSuccessResult('remediate'),
    });
    const ctx = makeContext(checkoutPath);

    const result = await phaseLoop.executeLoop(ctx, makeConfig(false), deps, ['validate']);

    expect(result.completed).toBe(true);
    expect(executeCalls(deps)).toBe(1);
    expect(deps.labelManager.onError).not.toHaveBeenCalled();
  });

  it('(b) validate fails → remediate runs → validate fails again ⇒ one execute, then failed:validate', async () => {
    const deps = makeDeps({
      validateResults: [makeFailResult('validate'), makeFailResult('validate')],
      remediateResult: makeSuccessResult('remediate'),
    });
    const ctx = makeContext(checkoutPath);

    const result = await phaseLoop.executeLoop(ctx, makeConfig(false), deps, ['validate']);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('validate');
    expect(executeCalls(deps)).toBe(1);
    expect(deps.labelManager.onError).toHaveBeenCalledWith('validate');
  });

  it('(c) no remediateExecutor ⇒ escalates immediately (no attempt)', async () => {
    const deps = makeDeps({
      validateResults: [makeFailResult('validate')],
      includeRemediateExecutor: false,
    });
    const ctx = makeContext(checkoutPath);

    const result = await phaseLoop.executeLoop(ctx, makeConfig(false), deps, ['validate']);

    expect(result.completed).toBe(false);
    expect(result.lastPhase).toBe('validate');
    expect(deps.remediateExecutor).toBeUndefined();
    expect(deps.labelManager.onError).toHaveBeenCalledWith('validate');
  });

  it('(d) flag-ON path does not fire the flag-OFF fallback (regression guard)', async () => {
    // With reviewPhaseEnabled=true, the flag-OFF branch is dead by guard. A
    // failing validate routes into the flag-ON review→remediate loop instead,
    // which is driven by the review executor (absent here), so the flag-OFF
    // remediateExecutor is never called by the fallback branch.
    const deps = makeDeps({
      validateResults: [makeFailResult('validate'), makeSuccessResult('validate')],
      remediateResult: makeSuccessResult('remediate'),
      reviewPhaseEnabled: true,
    });
    const ctx = makeContext(checkoutPath);

    await phaseLoop.executeLoop(ctx, makeConfig(true), deps, ['validate']);

    // The flag-OFF fallback never ran: the single-shot remediate attempt that
    // it would have dispatched is absent (the flag-ON path owns routing).
    expect(executeCalls(deps)).toBe(0);
  });
});
