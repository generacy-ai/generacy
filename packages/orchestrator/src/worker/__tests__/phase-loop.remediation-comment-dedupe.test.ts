// #1154 SC-004 (FR-005): the "Remediation limit reached" gate-body comment is
// marker-deduped. The comment is posted to the ISSUE (`addIssueComment`), so the
// dedupe MUST read the issue's comments (`getIssueComments`) — the original
// implementation read PR comments (`listPrCommentBodies(prNumber)`), never found
// the marker, and re-posted on every re-park. On a resume/re-pause cycle where
// the same cap gate fires again, the hidden `REMEDIATION_LIMIT_MARKER` already
// present in the issue comments suppresses a second `addIssueComment`. Once the
// marker is gone (cleared history), a genuinely new cap pause posts once more.
//
// Drives PhaseLoop.executeLoop to the #1128 remediation-cap gate (rc >= max &&
// verdict === 'changes-required') so the real posting/dedupe path in phase-loop.ts
// runs.
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
import type { ReviewArtifact, Severity } from '../review-artifact.js';
import {
  bumpRemediationCount,
  readReviewArtifactSync,
  writeReviewArtifact,
} from '../review-artifact.js';

const REMEDIATION_LIMIT_MARKER = '<!-- generacy-remediation-limit -->';

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
const PR_NUMBER = 4242;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;
const WORKFLOW = 'speckit-feature';
const MAX = 3;

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

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

function makeFindingsReader(
  checkoutPath: string,
): (context: WorkerContext) => Promise<{ artifact: ReviewArtifact; blockingSeverity: Severity } | null> {
  return async () => {
    const ra = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    if (!ra) return null;
    // Live seam shape (#1161): the canonical artifact (round lives in `ra.round`)
    // plus the blocking severity used for the poster's render projection.
    return { artifact: ra, blockingSeverity: 'critical' };
  };
}

function baseDeps(prNumber: number | undefined = PR_NUMBER): PhaseLoopDeps {
  return {
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
      getPrNumber: vi.fn().mockReturnValue(prNumber),
      convertToDraftIfEngineMarkedReady: vi.fn().mockResolvedValue(undefined),
      markReadyForReview: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function capContext(
  checkoutPath: string,
  issueCommentBodies: string[],
  addIssueComment: ReturnType<typeof vi.fn>,
): WorkerContext {
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
      getIssue: vi.fn().mockResolvedValue({ labels: [], state: 'open' }),
      addIssueComment,
      removeLabels: vi.fn().mockResolvedValue(undefined),
      // ISSUE-side read — the surface the dedupe must consult.
      getIssueComments: vi.fn().mockResolvedValue(
        issueCommentBodies.map((body, idx) => ({ id: idx + 1, body, author: 'bot', created_at: '', updated_at: '' })),
      ),
      // PR-side read — must NOT be consulted (wrong object; see header).
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

function wireExecutors(deps: PhaseLoopDeps, checkoutPath: string) {
  const reviewExecutor = makeScriptedReviewExecutor(checkoutPath);
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
}

async function seedCappedState(checkoutPath: string): Promise<void> {
  // Prior run already hit the cap: rc === MAX, still changes-required.
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

describe('PhaseLoop remediation-limit comment dedupe (#1154 SC-004 / FR-005)', () => {
  let phaseLoop: PhaseLoop;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'phaseloop-dedupe-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('suppresses a second comment when the marker is already present in the ISSUE comments', async () => {
    await seedCappedState(checkoutPath);
    const addIssueComment = vi.fn().mockResolvedValue(undefined);
    // A prior cap pause already posted the marked comment on the issue.
    const priorComment = `${REMEDIATION_LIMIT_MARKER}\n## Remediation limit reached\n...`;
    const deps = baseDeps();
    wireExecutors(deps, checkoutPath);
    deps.settings = { workflows: { [WORKFLOW]: { maxRemediations: MAX } } } as OrchestratorSettings;

    const ctx = capContext(checkoutPath, [priorComment], addIssueComment);
    const sequence = getPhaseSequence(WORKFLOW, true) as WorkflowPhase[];
    const result = await phaseLoop.executeLoop(ctx, capConfig(), deps, sequence);

    // Re-parked at the same cap gate.
    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    // The marker grep read the ISSUE comments (the object the comment is posted
    // to) and found the prior comment → no duplicate posted.
    expect(ctx.github.getIssueComments).toHaveBeenCalledWith(OWNER, REPO, ISSUE);
    expect(ctx.github.listPrCommentBodies).not.toHaveBeenCalled();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it('posts the comment once when no marker is present in the issue comments', async () => {
    await seedCappedState(checkoutPath);
    const addIssueComment = vi.fn().mockResolvedValue(undefined);
    // Fresh issue history — marker absent.
    const deps = baseDeps();
    wireExecutors(deps, checkoutPath);
    deps.settings = { workflows: { [WORKFLOW]: { maxRemediations: MAX } } } as OrchestratorSettings;

    const ctx = capContext(checkoutPath, ['unrelated chatter'], addIssueComment);
    const sequence = getPhaseSequence(WORKFLOW, true) as WorkflowPhase[];
    const result = await phaseLoop.executeLoop(ctx, capConfig(), deps, sequence);

    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    // No marker found → posted exactly once, and the body carries the marker.
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    const body = addIssueComment.mock.calls[0][3] as string;
    expect(body).toContain(REMEDIATION_LIMIT_MARKER);
    expect(body).toContain('src/cap.ts:12');
  });

  it('still dedupes when no PR exists (getPrNumber() undefined)', async () => {
    await seedCappedState(checkoutPath);
    const addIssueComment = vi.fn().mockResolvedValue(undefined);
    const priorComment = `${REMEDIATION_LIMIT_MARKER}\n## Remediation limit reached\n...`;
    const deps = baseDeps(undefined);
    wireExecutors(deps, checkoutPath);
    deps.settings = { workflows: { [WORKFLOW]: { maxRemediations: MAX } } } as OrchestratorSettings;

    const ctx = capContext(checkoutPath, [priorComment], addIssueComment);
    const sequence = getPhaseSequence(WORKFLOW, true) as WorkflowPhase[];
    const result = await phaseLoop.executeLoop(ctx, capConfig(), deps, sequence);

    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    expect(ctx.github.getIssueComments).toHaveBeenCalledWith(OWNER, REPO, ISSUE);
    expect(addIssueComment).not.toHaveBeenCalled();
  });
});
