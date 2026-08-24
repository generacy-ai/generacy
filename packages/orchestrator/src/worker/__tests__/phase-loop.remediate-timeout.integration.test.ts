// #1128 — SC-006 timeout integration.
//
// A remediate attempt whose CLI never exits on its own is killed by the phase
// timeout. The partial work it left behind is still committed+pushed, the sidecar
// (and its `remediationCount`) stays valid and parseable, and the loop CONTINUES
// (review → remediate again) rather than restarting — until the counter cap fires
// the gate. Uses the REAL RemediateExecutor driven through the phase loop.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type {
  ChildProcessHandle,
  Logger,
  PhaseResult,
  WorkerContext,
  WorkflowPhase,
} from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { OrchestratorSettings } from '@generacy-ai/config';
import type { AgentLauncher } from '../../launcher/agent-launcher.js';
import { RemediateExecutor } from '../remediate-executor.js';
import type { ReviewExecutor } from '../review-executor.js';
import {
  writeReviewArtifact,
  readReviewArtifact,
  readReviewArtifactSync,
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
const ISSUE = 1128;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

/** Child that never exits on its own — only the timeout SIGTERM resolves it. */
function makeNeverExitingProcess(exitCode = 143): ChildProcessHandle {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let resolveExit: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  return {
    stdin: null,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    pid: 4242,
    kill: vi.fn(() => {
      resolveExit(exitCode);
      return true;
    }),
    exitPromise,
  };
}

/** Launcher returning a fresh never-exiting child on each launch. */
function makeTimingOutLauncher(): { launcher: AgentLauncher; launch: ReturnType<typeof vi.fn> } {
  const launch = vi.fn(async () => ({
    process: makeNeverExitingProcess(),
    outputParser: { processChunk: () => undefined, flush: () => undefined },
    metadata: { pluginId: 'claude-code', intentKind: 'remediate' },
  }));
  return { launcher: { launch } as unknown as AgentLauncher, launch };
}

function makeReviewExecutor(checkoutPath: string): {
  executor: ReviewExecutor;
  execute: ReturnType<typeof vi.fn>;
} {
  let round = 0;
  const execute = vi.fn(async () => {
    round += 1;
    const prior = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    // Always changes-required so the review↔remediate loop keeps cycling until
    // the counter cap breaks it.
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [
        { severity: 'critical', file: 'src/a.ts', line: 7, title: 'boom', detail: 'fix', round, status: 'open' },
      ],
      verdict: 'changes-required',
      round,
      lastReviewedCommitSha: `sha${round}`,
      remediationCount: prior?.remediationCount ?? 0,
    });
    return makeSuccessResult('review');
  });
  return { executor: { execute } as unknown as ReviewExecutor, execute };
}

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

function createConfig(): WorkerConfig {
  return {
    // 20ms phase timeout → the never-exiting remediate child is SIGTERM'd.
    phaseTimeoutMs: 20,
    shutdownGracePeriodMs: 10,
    workspaceDir: '/tmp',
    validateCommand: 'pnpm test',
    preValidateCommand: '',
    reviewPhaseEnabled: true,
    gates: {
      'speckit-feature': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
    },
    maxImplementRetries: 2,
  } as WorkerConfig;
}

function createContext(checkoutPath: string): WorkerContext {
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
      getIssue: vi.fn().mockResolvedValue({ labels: [] }),
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

describe('#1128 — SC-006 remediate timeout integration', () => {
  let phaseLoop: PhaseLoop;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'phase-loop-remediate-timeout-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('commits partial work on timeout, keeps the sidecar valid, and continues review→remediate until the cap', async () => {
    const { executor: reviewExecutor } = makeReviewExecutor(checkoutPath);
    const { launcher, launch } = makeTimingOutLauncher();
    const config = createConfig();
    const remediateExecutor = new RemediateExecutor({
      agentLauncher: launcher,
      config,
      settings: null,
      logger: mockLogger,
    });

    const commitPushAndEnsurePr = vi
      .fn()
      .mockResolvedValue({ prUrl: null, hasChanges: true });

    const deps: PhaseLoopDeps = {
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
        checkGates: vi.fn((phase: WorkflowPhase, workflowName: string, cfg: WorkerConfig) =>
          (cfg.gates[workflowName] ?? []).filter((g) => g.phase === phase),
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
        commitPushAndEnsurePr,
        getPrNumber: vi.fn().mockReturnValue(undefined),
        convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
        markReadyForReview: vi.fn().mockResolvedValue(undefined),
      } as any,
      reviewExecutor,
      remediateExecutor,
      remediateTrigger,
      settings: {
        workflows: { 'speckit-feature': { maxRemediations: 2 } },
      } as OrchestratorSettings,
    };

    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];
    const result = await phaseLoop.executeLoop(createContext(checkoutPath), config, deps, sequence);

    // The counter cap eventually pauses the loop.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);

    // The loop continued (two remediate entries) rather than restarting.
    expect(phaseStartOrder(deps)).toEqual([
      'implement',
      'review',
      'remediate',
      'review',
      'remediate',
      'review',
    ]);

    // Each timed-out remediate spawned its own CLI (two launches).
    expect(launch).toHaveBeenCalledTimes(2);

    // Partial work was committed+pushed on every remediate cycle (FR-003).
    const remediateCommits = commitPushAndEnsurePr.mock.calls.filter(
      (c) => c[0] === 'remediate',
    );
    expect(remediateCommits.length).toBe(2);

    // The sidecar stayed valid and parseable, with the counter reflecting exactly
    // two consumed remediation attempts (each timeout still bumped the budget).
    const artifact = await readReviewArtifact(checkoutPath, WORKFLOW_ID);
    expect(artifact).not.toBeNull();
    expect(artifact!.remediationCount).toBe(2);
    expect(artifact!.round).toBe(3);
    expect(artifact!.verdict).toBe('changes-required');
  });
});
