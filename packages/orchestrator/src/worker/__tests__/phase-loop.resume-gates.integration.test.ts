// #1154 FR-007 / SC-001 / SC-002 — resume-gate end-to-end through the REAL
// `LabelManager.onResumeStart()`.
//
// The existing gate/reset unit tests inject a label set directly into the phase
// loop and bypass `onResumeStart()` entirely — which is exactly why the
// resume-strip bug (stripping `completed:<human-gate>` on resume) was invisible.
// This test wires a *real* `LabelManager` over a mutable label-backed fake
// `GitHubClient`, calls `onResumeStart()` first (as `claude-cli-worker` does
// before the phase loop), then runs `executeLoop` against the SAME github so the
// strip's effect on the surviving labels is what the gate machinery actually
// reads.
//
//   SC-001: `completed:remediation-limit` + `waiting-for:remediation-limit`
//     present at resume. The answer (`completed:remediation-limit`) must survive
//     `onResumeStart`, the remediation counter must reset to 0, the gate label
//     must be cleared (re-arm), and the loop must converge forward without an
//     immediate re-pause on the same count. WITHOUT FR-001 the strip removes the
//     answer and the loop re-parks at the cap (completed:false, gateHit:true).
//   SC-002: `completed:implementation-review` + `completed:validate` present at
//     resume (ciMergeGate ON). The answer must survive `onResumeStart` and the
//     terminal no-op short-circuit must fire so `validate` does NOT re-run.
//     WITHOUT FR-001 the strip removes `completed:implementation-review` and the
//     short-circuit's two-label precondition is not met → validate re-runs.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';
import { PhaseLoop } from '../phase-loop.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import { LabelManager } from '../label-manager.js';
import type { WorkerContext, Logger, WorkflowPhase, PhaseResult } from '../types.js';
import { getPhaseSequence } from '../types.js';
import type { WorkerConfig } from '../config.js';
import type { OrchestratorSettings } from '@generacy-ai/config';
import type { FindingsArtifact } from '../review-findings-artifact.js';
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

const OWNER = 'christrudelpw';
const REPO = 'snappoll';
const ISSUE = 1154;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

const MAX_BY_WORKFLOW: Record<string, number> = {
  'speckit-feature': 3,
  'speckit-bugfix': 2,
};

type Verdict = 'clean' | 'changes-required';

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

/**
 * A mutable label-backed fake `GitHubClient`. The SAME instance is handed to
 * both the real `LabelManager` and `WorkerContext.github`, so the resume strip
 * and the gate machinery read/write one shared label set — the whole point of
 * this end-to-end test.
 */
function makeLabelBackedGithub(initialLabels: string[]) {
  const labels = new Set<string>(initialLabels);
  const toIssue = () => ({
    labels: [...labels].map((name) => ({ name })),
    state: 'open' as const,
  });
  return {
    labels,
    // LabelManager surface
    getIssue: vi.fn(async () => toIssue()),
    addLabels: vi.fn(async (_o: string, _r: string, _n: number, add: string[]) => {
      for (const l of add) labels.add(l);
    }),
    removeLabels: vi.fn(async (_o: string, _r: string, _n: number, rm: string[]) => {
      for (const l of rm) labels.delete(l);
    }),
    listLabels: vi.fn(async () => WORKFLOW_LABELS.map((l) => ({ name: l.name }))),
    createLabel: vi.fn(async () => undefined),
    // PhaseLoop read surface
    getDefaultBranch: vi.fn(async () => 'develop'),
    getPullRequest: vi.fn(async () => ({ base: { ref: 'develop' } })),
    getCurrentCommitSha: vi.fn(async () => 'deadbeef'),
    getFilesChangedByOwnCommits: vi.fn(async () => ['packages/orchestrator/src/foo.ts']),
    getFilesChangedBetween: vi.fn(async () => ['packages/orchestrator/src/foo.ts']),
    commitExistsInCheckout: vi.fn(async () => true),
    getIssueLabels: vi.fn(async () => [...labels]),
    addIssueComment: vi.fn(async () => undefined),
  };
}

type LabelBackedGithub = ReturnType<typeof makeLabelBackedGithub>;

function makeScriptedReviewExecutor(checkoutPath: string, verdicts: Verdict[]) {
  let call = 0;
  const execute = vi.fn(async (): Promise<PhaseResult> => {
    const prior = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    const round = (prior?.round ?? 0) + 1;
    const verdict = verdicts[Math.min(call, verdicts.length - 1)]!;
    call++;
    const findings =
      verdict === 'changes-required'
        ? [
            {
              severity: 'critical' as const,
              file: 'src/cap.ts',
              line: 12,
              title: 'unresolved blocker',
              detail: 'must fix before ready',
              round,
              status: 'open' as const,
            },
          ]
        : [];
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings,
      verdict,
      round,
      lastReviewedCommitSha: `sha${round}`,
      remediationCount: prior?.remediationCount ?? 0,
    });
    return makeSuccessResult('review');
  });
  return { execute };
}

function makeFindingsReader(
  checkoutPath: string,
): (context: WorkerContext, round: number) => Promise<FindingsArtifact | null> {
  return async () => {
    const ra = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    if (!ra) return null;
    return {
      verdict: ra.verdict,
      findings: ra.findings.map((f, idx) => ({
        marker: `finding-${idx}`,
        text: f.title,
        severity: 'blocking' as const,
      })),
    };
  };
}

function baseDeps(labelManager: LabelManager): PhaseLoopDeps {
  return {
    labelManager: labelManager as unknown as PhaseLoopDeps['labelManager'],
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
      getPrNumber: vi.fn().mockReturnValue(undefined),
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function makeContext(
  github: LabelBackedGithub,
  checkoutPath: string,
  workflowName: string,
  startPhase: WorkflowPhase,
): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: {
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      workflowName,
      command: 'continue',
    } as any,
    startPhase,
    github: github as any,
    logger: mockLogger,
    signal: new AbortController().signal,
    checkoutPath,
    issueUrl: `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}`,
    description: 'test',
  };
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
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
      'speckit-bugfix': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
    },
    maxImplementRetries: 0,
    reviewPhaseEnabled: true,
    ...overrides,
  } as WorkerConfig;
}

function wireExecutors(deps: PhaseLoopDeps, checkoutPath: string, reviewExecutor: { execute: any }) {
  const remediateExecute = vi.fn(async (): Promise<PhaseResult> => {
    await bumpRemediationCount(checkoutPath, WORKFLOW_ID);
    return makeSuccessResult('remediate');
  });
  deps.reviewExecutor = reviewExecutor as any;
  deps.remediateExecutor = { execute: remediateExecute } as any;
  deps.remediateTrigger = (ctx) =>
    readReviewArtifactSync(ctx.checkoutPath, WORKFLOW_ID)?.verdict === 'changes-required';
  deps.readFindingsArtifact = makeFindingsReader(checkoutPath);
  deps.reviewPoster = {
    postRound: vi.fn().mockResolvedValue(undefined),
    resolveResolvedThreads: vi.fn().mockResolvedValue(undefined),
  } as any;
  return remediateExecute;
}

describe.each([['speckit-feature'], ['speckit-bugfix']])(
  'PhaseLoop resume gates through real onResumeStart (#1154) [%s]',
  (workflowName) => {
    const MAX = MAX_BY_WORKFLOW[workflowName]!;
    let phaseLoop: PhaseLoop;
    let checkoutPath: string;

    beforeEach(async () => {
      phaseLoop = new PhaseLoop(mockLogger);
      checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phaseloop-resume-'));
      LabelManager.resetEnsureCacheForTests();
    });

    afterEach(async () => {
      await fs.rm(checkoutPath, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it('SC-001: completed:remediation-limit survives onResumeStart, counter resets, gate re-arms, loop converges', async () => {
      // Prior run paused at the cap: rc === MAX, still changes-required.
      await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
        findings: [
          { severity: 'critical', file: 'src/cap.ts', line: 12, title: 'unresolved blocker', detail: 'x', round: MAX + 1, status: 'open' },
        ],
        verdict: 'changes-required',
        round: MAX + 1,
        lastReviewedCommitSha: 'capped',
        remediationCount: MAX,
      });

      // Operator answered the gate: completed:remediation-limit is present
      // alongside the pause labels the resume strip is meant to clear.
      const github = makeLabelBackedGithub([
        'completed:remediation-limit',
        'waiting-for:remediation-limit',
        'agent:paused',
      ]);
      const labelManager = new LabelManager(github as any, OWNER, REPO, ISSUE, mockLogger);
      const onPhaseStartSpy = vi.spyOn(labelManager, 'onPhaseStart');

      // Resume-start runs BEFORE the phase loop (claude-cli-worker order).
      await labelManager.onResumeStart();

      // FR-001: the human-gate answer survived the strip; the stale pause labels
      // were cleared; agent:in-progress marks the active run.
      expect(github.labels.has('completed:remediation-limit')).toBe(true);
      expect(github.labels.has('waiting-for:remediation-limit')).toBe(false);
      expect(github.labels.has('agent:paused')).toBe(false);
      expect(github.labels.has('agent:in-progress')).toBe(true);

      const deps = baseDeps(labelManager);
      const reviewExecutor = makeScriptedReviewExecutor(checkoutPath, [
        'changes-required',
        'clean',
      ]);
      const remediateExecute = wireExecutors(deps, checkoutPath, reviewExecutor);
      deps.settings = {
        workflows: { [workflowName]: { maxRemediations: MAX } },
      } as OrchestratorSettings;

      const ctx = makeContext(github, checkoutPath, workflowName, 'review');
      const sequence = getPhaseSequence(workflowName, true) as WorkflowPhase[];
      const result = await phaseLoop.executeLoop(ctx, makeConfig(), deps, sequence);

      // The surviving answer let the gate-satisfied branch fire (reset + re-arm),
      // so the loop converged forward instead of re-parking at the cap.
      expect(result.completed).toBe(true);
      expect(result.gateHit).toBe(false);
      expect(result.lastPhase).toBe('validate');

      // review#1 (blocking → gate reset) → remediate → review#2 (clean) → validate.
      const phaseOrder = onPhaseStartSpy.mock.calls.map((c) => c[0] as WorkflowPhase);
      expect(phaseOrder).toEqual(['review', 'remediate', 'review', 'validate']);
      expect(remediateExecute).toHaveBeenCalledTimes(1);

      // Counter reset to 0 then climbed once via the single post-reset remediation.
      const finalArtifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
      expect(finalArtifact.remediationCount).toBe(1);
      expect(finalArtifact.verdict).toBe('clean');

      // Re-arm: the operator label was cleared by the reset branch (and stays
      // clear after the clean-review FR-006 defensive sweep).
      expect(github.labels.has('completed:remediation-limit')).toBe(false);
    });

    it('SC-002: completed:implementation-review survives onResumeStart, terminal no-op short-circuit skips validate', async () => {
      // Post-validate CI-merge gate satisfied: both terminal labels present,
      // plus the pause labels the resume strip clears.
      const github = makeLabelBackedGithub([
        'completed:validate',
        'completed:implementation-review',
        'waiting-for:implementation-review',
        'agent:paused',
      ]);
      const labelManager = new LabelManager(github as any, OWNER, REPO, ISSUE, mockLogger);

      await labelManager.onResumeStart();

      // FR-001: implementation-review (a human gate) survived; completed:validate
      // (a phase completion, never a strip candidate) is untouched; pause labels
      // cleared; agent:in-progress added.
      expect(github.labels.has('completed:implementation-review')).toBe(true);
      expect(github.labels.has('completed:validate')).toBe(true);
      expect(github.labels.has('waiting-for:implementation-review')).toBe(false);
      expect(github.labels.has('agent:paused')).toBe(false);
      expect(github.labels.has('agent:in-progress')).toBe(true);

      const deps = baseDeps(labelManager);
      const reviewExecutor = makeScriptedReviewExecutor(checkoutPath, ['clean']);
      wireExecutors(deps, checkoutPath, reviewExecutor);
      deps.settings = {
        workflows: { [workflowName]: { maxRemediations: MAX } },
      } as OrchestratorSettings;

      const ctx = makeContext(github, checkoutPath, workflowName, 'validate');
      const sequence = getPhaseSequence(workflowName, true) as WorkflowPhase[];
      const result = await phaseLoop.executeLoop(
        ctx,
        makeConfig({ ciMergeGateEnabled: true }),
        deps,
        sequence,
      );

      // FR-003 terminal no-op: both completed labels present → short-circuit.
      expect(result.completed).toBe(true);
      expect(result.gateHit).toBe(false);
      expect(result.lastPhase).toBe('validate');

      // validate must NOT re-run — no revalidation, no review executor invocation.
      expect(deps.cliSpawner.runValidatePhase).not.toHaveBeenCalled();
      expect(reviewExecutor.execute).not.toHaveBeenCalled();
    });
  },
);
