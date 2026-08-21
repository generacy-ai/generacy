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

// ---------------------------------------------------------------------------
// #1160 T014 (US4 / SC-004 / FR-006)
//
// The CI-readiness wait now resolves `ciWaitTimeoutMs` per-workflow through
// `resolveWorkflowOverrides` before calling `waitForCiGreen`. A per-workflow
// `workflows.<name>.ciWaitTimeoutMs` wins over the cluster base; an unset tier
// falls through to `config.ciWaitTimeoutMs` (no repo tier — mirrors
// `maxRemediations`). We spy on `waitForCiGreen` to observe the exact value
// threaded to it, then let the gate raise (`kind: 'green'`).
// ---------------------------------------------------------------------------

// Spy on the real readiness helper: return green immediately so the on-ci-green
// gate raises, and capture the params object (asserting the resolved timeout).
vi.mock('../ci-merge-readiness.js', () => ({
  waitForCiGreen: vi.fn().mockResolvedValue({ kind: 'green' }),
}));
import { waitForCiGreen } from '../ci-merge-readiness.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

const OWNER = 'test';
const REPO = 'repo';
const ISSUE = 1160;

const CI_GREEN_GATE = {
  phase: 'validate' as const,
  gateLabel: 'waiting-for:implementation-review',
  condition: 'on-ci-green' as const,
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

function createMockContext(checkoutPath: string, ciRuns: CiRun[]): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      workflowName: 'speckit-feature',
      command: 'process',
    } as any,
    startPhase: 'implement',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
      commitExistsInCheckout: vi.fn().mockResolvedValue(true),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
      getCiRunsForSha: vi.fn().mockResolvedValue({ runs: ciRuns, source: 'check-runs' }),
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
    ciMergeGateEnabled: true,
    gates: { 'speckit-feature': [CI_GREEN_GATE] },
    maxImplementRetries: 2,
    ...overrides,
  } as WorkerConfig;
}

describe('PhaseLoop ciWaitTimeout resolution (#1160 T014)', () => {
  let phaseLoop: PhaseLoop;
  let deps: PhaseLoopDeps;
  let checkoutPath: string;

  beforeEach(async () => {
    (waitForCiGreen as any).mockClear();
    phaseLoop = new PhaseLoop(mockLogger);
    deps = createMockDeps();
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'phase-loop-ci-wait-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('SC-004: per-workflow ciWaitTimeoutMs is the value passed to waitForCiGreen', async () => {
    const context = createMockContext(checkoutPath, [{ status: 'completed', conclusion: 'success' }]);
    deps.settings = {
      workflows: {
        'speckit-feature': { ciWaitTimeoutMs: 120_000 },
      },
    } as any;
    // Cluster base differs from the workflow override so the assertion is meaningful.
    const config = createConfig({ ciWaitTimeoutMs: 900_000 });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(waitForCiGreen).toHaveBeenCalledWith(
      expect.objectContaining({ ciWaitTimeoutMs: 120_000 }),
    );
  });

  it('precedence: unset workflow tier falls through to the cluster base ciWaitTimeoutMs', async () => {
    const context = createMockContext(checkoutPath, [{ status: 'completed', conclusion: 'success' }]);
    // No workflow override → the resolver returns config.ciWaitTimeoutMs.
    const config = createConfig({ ciWaitTimeoutMs: 600_000 });
    const sequence = getPhaseSequence('speckit-feature', false) as WorkflowPhase[];

    await phaseLoop.executeLoop(context, config, deps, sequence);

    expect(waitForCiGreen).toHaveBeenCalledWith(
      expect.objectContaining({ ciWaitTimeoutMs: 600_000 }),
    );
  });
});
