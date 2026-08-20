// #1128 — phase-loop integration for the remediation cap gate + operator resume.
//
// SC-002: reaching the cap raises `waiting-for:remediation-limit` (+ `agent:paused`
//   via onGateHit) and posts the gate body listing the open findings.
// SC-003: `completed:remediation-limit` resets the counter and re-arms the gate
//   (removeLabels + no pause), letting the loop converge.
// SC-004: review(changes-required) → remediate → re-review → clean → validate
//   converges inside the cap.
// SC-005: no `blocked:*` label is ever applied on any of these paths.
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
const ISSUE = 1128;
const WORKFLOW_ID = `${OWNER}/${REPO}#${ISSUE}`;

type Verdict = 'clean' | 'changes-required';

/** Collects every label string ever handed to any github/label mutation spy. */
interface LabelSink {
  seen: string[];
}

function createMockDeps(labelSink: LabelSink): PhaseLoopDeps {
  const record = (labels: unknown) => {
    if (Array.isArray(labels)) labelSink.seen.push(...(labels as string[]));
  };
  return {
    labelManager: {
      onPhaseStart: vi.fn().mockResolvedValue(undefined),
      onPhaseComplete: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      onGateHit: vi.fn(async (_phase: WorkflowPhase, gateLabel: string) => {
        labelSink.seen.push(gateLabel);
      }),
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
    } as any,
    // record any addLabels calls so SC-005 can assert no blocked:* label appears.
    _labelSink: labelSink,
  } as unknown as PhaseLoopDeps & { _labelSink: LabelSink };
}

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

/** Mutable-label github mock so removeLabels re-arms a resolved gate. */
function makeGithub(
  labelSink: LabelSink,
  initialLabels: string[] = [],
): {
  github: WorkerContext['github'];
  addIssueComment: ReturnType<typeof vi.fn>;
  removeLabels: ReturnType<typeof vi.fn>;
  addLabels: ReturnType<typeof vi.fn>;
} {
  const labels = new Set(initialLabels);
  const addIssueComment = vi.fn().mockResolvedValue(undefined);
  const removeLabels = vi.fn(async (_o: string, _r: string, _n: number, toRemove: string[]) => {
    for (const l of toRemove) labels.delete(l);
  });
  const addLabels = vi.fn(async (_o: string, _r: string, _n: number, toAdd: string[]) => {
    labelSink.seen.push(...toAdd);
    for (const l of toAdd) labels.add(l);
  });
  const github = {
    getDefaultBranch: vi.fn().mockResolvedValue('develop'),
    getCurrentCommitSha: vi.fn().mockResolvedValue('a1b2c3d4'),
    commitExistsInCheckout: vi.fn().mockResolvedValue(true),
    getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    getFilesChangedBetween: vi.fn().mockResolvedValue(['packages/orchestrator/src/foo.ts']),
    getIssue: vi.fn(async () => ({ labels: [...labels] })),
    addIssueComment,
    removeLabels,
    addLabels,
  } as unknown as WorkerContext['github'];
  return { github, addIssueComment, removeLabels, addLabels };
}

function createMockContext(
  checkoutPath: string,
  github: WorkerContext['github'],
): WorkerContext {
  return {
    workerId: 'test-worker',
    item: {
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      workflowName: 'speckit-feature',
    } as any,
    startPhase: 'implement',
    github,
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
    gates: {
      'speckit-feature': [
        { phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' },
      ],
    },
    maxImplementRetries: 2,
    ...overrides,
  } as WorkerConfig;
}

function makeReviewExecutor(
  checkoutPath: string,
  verdictFor: (round: number) => Verdict,
): { executor: ReviewExecutor; execute: ReturnType<typeof vi.fn> } {
  let round = 0;
  const execute = vi.fn(async () => {
    round += 1;
    const verdict = verdictFor(round);
    const prior = readReviewArtifactSync(checkoutPath, WORKFLOW_ID);
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings:
        verdict === 'changes-required'
          ? [
              { severity: 'critical', file: 'src/a.ts', line: 42, title: 'Null deref', detail: 'guard it', round, status: 'open' },
              { severity: 'major', file: 'src/b.ts', title: 'Leak', detail: 'close it', round, status: 'open' },
            ]
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

function makeRemediateExecutor(
  checkoutPath: string,
): { executor: RemediateExecutor; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => {
    await bumpRemediationCount(checkoutPath, WORKFLOW_ID);
    return makeSuccessResult('remediate');
  });
  return { executor: { execute } as unknown as RemediateExecutor, execute };
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

describe('#1128 — remediation cap gate + operator resume', () => {
  let phaseLoop: PhaseLoop;
  let labelSink: LabelSink;
  let checkoutPath: string;

  beforeEach(async () => {
    phaseLoop = new PhaseLoop(mockLogger);
    labelSink = { seen: [] };
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'phase-loop-remediate-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('SC-002/SC-005: cap raises waiting-for:remediation-limit, posts the gate body, applies no blocked:* label', async () => {
    const { executor } = makeReviewExecutor(checkoutPath, () => 'changes-required');
    const { executor: remediateExecutor } = makeRemediateExecutor(checkoutPath);
    const { github, addIssueComment } = makeGithub(labelSink);
    const deps = createMockDeps(labelSink);
    deps.reviewExecutor = executor;
    deps.remediateExecutor = remediateExecutor;
    deps.remediateTrigger = remediateTrigger;
    deps.settings = {
      workflows: { 'speckit-feature': { maxRemediations: 2 } },
    } as OrchestratorSettings;
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(
      createMockContext(checkoutPath, github),
      config,
      deps,
      sequence,
    );

    expect(result.completed).toBe(false);
    expect(result.gateHit).toBe(true);
    // SC-002: the pause label was raised via onGateHit.
    expect(deps.labelManager.onGateHit).toHaveBeenCalledWith(
      'review',
      'waiting-for:remediation-limit',
    );
    // SC-002: the gate body enumerated the open findings + resume instructions.
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    const body = addIssueComment.mock.calls[0]![3] as string;
    expect(body).toContain('Remediation limit reached');
    expect(body).toContain('src/a.ts:42 — Null deref');
    expect(body).toContain('src/b.ts — Leak');
    expect(body).toContain('completed:remediation-limit');
    // SC-005: no blocked:* label anywhere.
    expect(labelSink.seen.some((l) => l.startsWith('blocked:'))).toBe(false);
  });

  it('SC-003/SC-005: completed:remediation-limit resets the counter, re-arms the gate, and the loop converges', async () => {
    // Pre-seed the sidecar at the cap so the gate is active on the first review
    // round; the operator label is present so the gate resolves (reset + re-arm)
    // instead of pausing. round 1 → changes-required (keeps the gate active);
    // round 2 → clean (converges to validate).
    await writeReviewArtifact(checkoutPath, WORKFLOW_ID, {
      findings: [{ severity: 'critical', file: 'src/a.ts', title: 't', detail: 'd', round: 0, status: 'open' }],
      verdict: 'changes-required',
      round: 1,
      lastReviewedCommitSha: 'seed',
      remediationCount: 1,
    });
    const { executor } = makeReviewExecutor(checkoutPath, (r) => (r === 1 ? 'changes-required' : 'clean'));
    const { executor: remediateExecutor } = makeRemediateExecutor(checkoutPath);
    const { github, removeLabels } = makeGithub(labelSink, ['completed:remediation-limit']);
    const deps = createMockDeps(labelSink);
    deps.reviewExecutor = executor;
    deps.remediateExecutor = remediateExecutor;
    deps.remediateTrigger = remediateTrigger;
    deps.settings = {
      workflows: { 'speckit-feature': { maxRemediations: 1 } },
    } as OrchestratorSettings;
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(
      createMockContext(checkoutPath, github),
      config,
      deps,
      sequence,
    );

    // Converged — the resolved gate never paused.
    expect(result.completed).toBe(true);
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
    // Re-arm: the operator label was removed.
    expect(removeLabels).toHaveBeenCalledWith(
      OWNER,
      REPO,
      ISSUE,
      ['completed:remediation-limit'],
    );
    // implement → review(r1, changes-required, gate resolves) → remediate →
    // review(r2, clean) → validate.
    expect(phaseStartOrder(deps)).toEqual(['implement', 'review', 'remediate', 'review', 'validate']);
    // SC-005: no blocked:* label anywhere.
    expect(labelSink.seen.some((l) => l.startsWith('blocked:'))).toBe(false);
  });

  it('SC-004/SC-005: changes-required → remediate → clean re-review reaches validate within the cap', async () => {
    const { executor } = makeReviewExecutor(checkoutPath, (r) => (r === 1 ? 'changes-required' : 'clean'));
    const { executor: remediateExecutor, execute: remediateExecute } = makeRemediateExecutor(checkoutPath);
    const { github, addIssueComment } = makeGithub(labelSink);
    const deps = createMockDeps(labelSink);
    deps.reviewExecutor = executor;
    deps.remediateExecutor = remediateExecutor;
    deps.remediateTrigger = remediateTrigger;
    // Default maxRemediations (3) — one remediation is well within budget.
    const config = createConfig({ reviewPhaseEnabled: true });
    const sequence = getPhaseSequence('speckit-feature', true) as WorkflowPhase[];

    const result = await phaseLoop.executeLoop(
      createMockContext(checkoutPath, github),
      config,
      deps,
      sequence,
    );

    expect(result.completed).toBe(true);
    expect(remediateExecute).toHaveBeenCalledTimes(1);
    expect(phaseStartOrder(deps)).toEqual(['implement', 'review', 'remediate', 'review', 'validate']);
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();
    // No gate body posted when the cap is never hit.
    expect(addIssueComment).not.toHaveBeenCalled();
    // SC-005: no blocked:* label anywhere.
    expect(labelSink.seen.some((l) => l.startsWith('blocked:'))).toBe(false);
    // The counter reflects exactly one remediation.
    expect(readReviewArtifactSync(checkoutPath, WORKFLOW_ID)!.remediationCount).toBe(1);
  });
});
