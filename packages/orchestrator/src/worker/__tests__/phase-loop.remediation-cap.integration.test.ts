// #1132 US2 (T020–T024) — remediation cap + reset + converge, end-to-end.
//
// Drives PhaseLoop.executeLoop through the real review + remediate executor seams
// (shared T010 harness) and asserts the #1128 remediation-cap gate composes with
// the counter-reset resume seam:
//
//   T021 (SC-003): once `remediationCount` reaches the configured `maxRemediations`
//     AND the verdict is still `changes-required`, the loop pauses and raises
//     `waiting-for:remediation-limit` — with ZERO terminal `blocked:*` labels.
//   T022 (FR-002): the remaining `open` findings are surfaced to the human via a
//     gate-body comment at the pause point.
//   T023: the counter-reset/resume seam #1128 ships is label-driven (Q4=C):
//     `completed:remediation-limit` present → the loop resets the counter and
//     re-arms the gate (removes the operator label). Observable: the budget
//     climbs from 0 again (final rc = 1, not cap+1) and the label is removed.
//   T024 (SC-003): after reset, a clean re-review converges and the loop proceeds
//     forward — only the observable reset + convergence is asserted, not the
//     concrete trigger shape (Q4=C).
//
// Parameterized over both workflows. The cap is driven to the CONFIGURED
// `maxRemediations` (feature 3 / bugfix 2) via `deps.settings`, never a hardcoded
// numeric default (Assumption §93).
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
const ISSUE = 1132;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

// Configured caps per workflow (driven via settings, not a hardcoded default).
const MAX_BY_WORKFLOW: Record<string, number> = {
  'speckit-feature': 3,
  'speckit-bugfix': 2,
};

type Verdict = 'clean' | 'changes-required';

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

/**
 * Call-scripted review executor stand-in — same write contract as the T010
 * harness: read prior → advance `round` → preserve `remediationCount` → write the
 * steered verdict. The open finding carries a distinctive location/title so the
 * gate-body surfacing assertion (T022) can match it.
 */
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
): (context: WorkerContext) => Promise<{ artifact: FindingsArtifact; round: number } | null> {
  return async () => {
    const ra = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    if (!ra) return null;
    return {
      artifact: {
        verdict: ra.verdict,
        findings: ra.findings.map((f, idx) => ({
          marker: `finding-${idx}`,
          text: f.title,
          severity: 'blocking' as const,
        })),
      },
      round: ra.round,
    };
  };
}

function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as any).mock.calls.map(
    (c: unknown[]) => c[0] as WorkflowPhase,
  );
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
      getPrNumber: vi.fn().mockReturnValue(undefined),
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function capContext(
  checkoutPath: string,
  workflowName: string,
  issueLabels: string[],
): WorkerContext {
  return {
    workerId: 'test-worker',
    jobId: 'test-job',
    item: {
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      workflowName,
    } as any,
    startPhase: 'review',
    github: {
      getDefaultBranch: vi.fn().mockResolvedValue('develop'),
      getPullRequest: vi.fn().mockResolvedValue({ base: { ref: 'develop' } }),
      getCurrentCommitSha: vi.fn().mockResolvedValue('deadbeef'),
      getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
      commitExistsInCheckout: vi.fn().mockResolvedValue(true),
      getIssue: vi.fn().mockResolvedValue({ labels: issueLabels, state: 'open' }),
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
      'speckit-bugfix': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
    },
    maxImplementRetries: 0,
    reviewPhaseEnabled: true,
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
  'PhaseLoop remediation cap + reset + converge (#1132 US2) [%s]',
  (workflowName) => {
    const MAX = MAX_BY_WORKFLOW[workflowName]!;
    let phaseLoop: PhaseLoop;
    let checkoutPath: string;

    beforeEach(async () => {
      phaseLoop = new PhaseLoop(mockLogger);
      checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phaseloop-cap-'));
    });

    afterEach(async () => {
      await fs.rm(checkoutPath, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it('caps at maxRemediations → waiting-for:remediation-limit, findings surfaced, zero blocked:* (T021/T022)', async () => {
      const deps = baseDeps();
      // Never satisfied — the stub remediate never fixes the diff, so every
      // re-review stays `changes-required` until the counter hits the cap.
      const reviewExecutor = makeScriptedReviewExecutor(checkoutPath, ['changes-required']);
      const remediateExecute = wireExecutors(deps, checkoutPath, reviewExecutor);

      const settings: OrchestratorSettings = {
        workflows: { [workflowName]: { maxRemediations: MAX } },
      } as OrchestratorSettings;
      deps.settings = settings;

      const ctx = capContext(checkoutPath, workflowName, []);
      const sequence = getPhaseSequence(workflowName, true) as WorkflowPhase[];
      const result = await phaseLoop.executeLoop(ctx, capConfig(), deps, sequence);

      // T021: paused at the cap, not looped forever.
      expect(result.completed).toBe(false);
      expect(result.gateHit).toBe(true);

      // rc climbs 0→MAX across MAX remediation rounds; the gate fires on the
      // review where rc === MAX. Order: MAX × [review, remediate] then a final
      // review that trips the gate.
      const expectedOrder: WorkflowPhase[] = [];
      for (let i = 0; i < MAX; i++) expectedOrder.push('review', 'remediate');
      expectedOrder.push('review');
      expect(phaseStartOrder(deps)).toEqual(expectedOrder);
      expect(remediateExecute).toHaveBeenCalledTimes(MAX);

      // T021: the disposition is the remediation-limit gate and ONLY that — no
      // terminal blocked:* dead-end.
      expect(deps.labelManager.onGateHit).toHaveBeenCalledWith(
        'review',
        'waiting-for:remediation-limit',
      );
      const gateLabels = (deps.labelManager.onGateHit as any).mock.calls.map(
        (c: unknown[]) => c[1] as string,
      );
      expect(gateLabels).toEqual(['waiting-for:remediation-limit']);
      expect(gateLabels).not.toContain('blocked:stuck-feedback-loop');

      // T022 (FR-002): the open findings are surfaced to the human at the pause.
      expect(ctx.github.addIssueComment).toHaveBeenCalledTimes(1);
      const commentBody = (ctx.github.addIssueComment as any).mock.calls[0][3] as string;
      expect(commentBody).toContain('src/cap.ts:12');
      expect(commentBody).toContain('unresolved blocker');

      const finalArtifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
      expect(finalArtifact.remediationCount).toBe(MAX);
      expect(finalArtifact.verdict).toBe('changes-required');
    });

    it('completed:remediation-limit resets the counter and the loop converges forward (T023/T024)', async () => {
      // Pre-seed a capped state: the prior run paused with rc === MAX.
      await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
        findings: [
          { severity: 'critical', file: 'src/cap.ts', line: 12, title: 'unresolved blocker', detail: 'x', round: MAX + 1, status: 'open' },
        ],
        verdict: 'changes-required',
        round: MAX + 1,
        lastReviewedCommitSha: 'capped',
        remediationCount: MAX,
      });

      const deps = baseDeps();
      // Resume run: the first re-review is still blocking (so the gate engages
      // and the completed-label reset path fires); the next re-review is clean
      // (so the loop converges forward).
      const reviewExecutor = makeScriptedReviewExecutor(checkoutPath, [
        'changes-required',
        'clean',
      ]);
      const remediateExecute = wireExecutors(deps, checkoutPath, reviewExecutor);

      const settings: OrchestratorSettings = {
        workflows: { [workflowName]: { maxRemediations: MAX } },
      } as OrchestratorSettings;
      deps.settings = settings;

      // The operator answered by adding the resume label.
      const ctx = capContext(checkoutPath, workflowName, ['completed:remediation-limit']);
      const sequence = getPhaseSequence(workflowName, true) as WorkflowPhase[];
      const result = await phaseLoop.executeLoop(ctx, capConfig(), deps, sequence);

      // T024: converged forward — no pause this time.
      expect(result.completed).toBe(true);
      expect(result.gateHit).toBe(false);
      expect(result.lastPhase).toBe('validate');

      // review#1 (blocking, gate resets) → remediate → review#2 (clean) → validate.
      expect(phaseStartOrder(deps)).toEqual(['review', 'remediate', 'review', 'validate']);

      // T023: the reset re-armed the gate by removing the operator label.
      expect(ctx.github.removeLabels).toHaveBeenCalledWith(
        OWNER,
        REPO,
        ISSUE,
        ['completed:remediation-limit'],
      );

      // T023: the counter was reset to zero, then climbed once via the single
      // post-reset remediation — final rc === 1, NOT MAX + 1. This is the
      // observable proof of the reset (not the concrete trigger shape).
      expect(remediateExecute).toHaveBeenCalledTimes(1);
      const finalArtifact = readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!;
      expect(finalArtifact.remediationCount).toBe(1);
      expect(finalArtifact.verdict).toBe('clean');

      // T024: the clean re-review marked the PR ready and the loop proceeded to a
      // green validate.
      expect(deps.prManager.markReadyForReview).toHaveBeenCalledTimes(1);
      expect(deps.cliSpawner.runValidatePhase).toHaveBeenCalledTimes(1);
      // No terminal gate on the resume path.
      expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
    });
  },
);
