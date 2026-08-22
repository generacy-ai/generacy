/**
 * Validate-origin convergence through the REAL `ReviewExecutor`.
 *
 * Defect: `synthesizeValidateChangesRequiredArtifact` stores the validate
 * COMMAND in the finding's `file`; `advanceArtifact` flips open→resolved only
 * when `file ∈ delta.files`, and a command string is never a changed path. So
 * the synthesized finding was carried forward open at critical severity every
 * round → verdict stayed `changes-required` → remediate → … →
 * `waiting-for:remediation-limit`. The existing
 * `phase-loop.validate-remediate.integration.test.ts` masks this by stubbing
 * the review executor to write a clean artifact.
 *
 * This suite composes the real executor (via `review-composition-harness`) and
 * a scripted review CLI that does what the verification charter now instructs:
 * re-emit the `[synthetic: validate]` finding with the same `file` + `title` and
 * `status: "resolved"`. It proves the loop converges
 * (validate fail → remediate → review resolves synthetic → validate green) with
 * the `on-remediation-limit` cap gate ARMED and never tripped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseResult, WorkerContext, WorkflowPhase } from '../types.js';
import type { WorkerConfig } from '../config.js';
import {
  bumpRemediationCount,
  deriveFindingId,
  readReviewArtifact,
  readReviewArtifactSync,
} from '../review-artifact.js';
import {
  createReviewCompositionHarness,
  type ReviewCompositionHarness,
} from './helpers/review-composition-harness.js';

const VALIDATE_COMMAND = 'pnpm test && pnpm build';

function makeSuccessResult(phase: WorkflowPhase): PhaseResult {
  return { phase, success: true, exitCode: 0, durationMs: 1, output: [] };
}

function makeValidateFailure(): PhaseResult {
  return {
    phase: 'validate',
    success: false,
    exitCode: 1,
    durationMs: 1,
    output: [],
    capturedStdout: 'FAIL src/foo.test.ts > expects bar',
    capturedStderr: '',
    error: { message: 'validate failed', output: 'exit 1', phase: 'validate' },
  } as PhaseResult;
}

describe('validate-origin synthetic finding converges through the real ReviewExecutor', () => {
  let harness: ReviewCompositionHarness;

  beforeEach(async () => {
    harness = await createReviewCompositionHarness({ issueNumber: 1170 });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('validate fail → remediate → review re-emits the synthetic finding resolved → validate green; cap never trips', async () => {
    // Round 1: whole-PR review, clean. Round 3 (after the validate-origin
    // remediate): the reviewer confirms the synthetic finding as resolved —
    // same `file` (the validate command) + `title`, `status: "resolved"`.
    const agentLauncher = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJsonByRound: {
        1: JSON.stringify({ findings: [] }),
        3: JSON.stringify({
          findings: [
            {
              severity: 'critical',
              file: VALIDATE_COMMAND,
              title: 'validate phase failed',
              detail: 'The remediation fixed the failing test.',
              status: 'resolved',
            },
          ],
        }),
      },
    });

    const runValidatePhase = vi
      .fn()
      .mockResolvedValueOnce(makeValidateFailure())
      .mockResolvedValue(makeSuccessResult('validate'));
    const remediateExecute = vi.fn(async (): Promise<PhaseResult> => {
      // The real RemediateExecutor bumps the budget once per execution.
      await bumpRemediationCount(harness.checkoutPath, harness.workflowId);
      return makeSuccessResult('remediate');
    });

    const { context, config, deps } = harness.build({
      agentLauncher,
      startPhase: 'review',
      extraDeps: {
        remediateExecutor: { execute: remediateExecute } as never,
        remediateTrigger: (ctx: WorkerContext) =>
          readReviewArtifactSync(ctx.checkoutPath, harness.workflowId)?.verdict ===
          'changes-required',
        failureFingerprintTracker: { countPriorOccurrences: vi.fn(async () => 0) } as never,
        // Honour `config.gates` so the remediation cap is live for this run.
        gateChecker: {
          checkGates: vi.fn(
            (phase: WorkflowPhase, workflowName: string, cfg: WorkerConfig) =>
              (cfg.gates?.[workflowName] ?? []).filter((g) => g.phase === phase),
          ),
        } as never,
      },
    });
    (deps.cliSpawner as { runValidatePhase: unknown }).runValidatePhase = runValidatePhase;
    config.gates = {
      [harness.workflowName]: [
        {
          phase: 'review',
          gateLabel: 'waiting-for:remediation-limit',
          condition: 'on-remediation-limit',
        },
      ],
    } as WorkerConfig['gates'];

    const result = await harness.phaseLoop.executeLoop(context, config, deps, [
      'review',
      'validate',
    ]);

    expect(result.completed).toBe(true);
    expect(result.gateHit).toBe(false);

    const phaseStarts = (deps.labelManager.onPhaseStart as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as WorkflowPhase,
    );
    // review(clean) → validate(fail → synth) → review(stub) → remediate →
    // review(real: resolves synthetic) → validate(green).
    expect(phaseStarts).toEqual(['review', 'validate', 'review', 'remediate', 'review', 'validate']);
    expect(remediateExecute).toHaveBeenCalledTimes(1);
    expect(runValidatePhase).toHaveBeenCalledTimes(2);
    // The cap gate was armed and never fired.
    expect(deps.labelManager.onGateHit).not.toHaveBeenCalled();

    const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
    expect(artifact).not.toBeNull();
    expect(artifact!.verdict).toBe('clean');
    expect(artifact!.round).toBe(3);
    expect(artifact!.remediationCount).toBe(1);
    const synthetic = artifact!.findings.find((f) => f.synthetic === 'validate');
    expect(synthetic).toBeDefined();
    expect(synthetic!.id).toBe(deriveFindingId(VALIDATE_COMMAND, 'validate phase failed'));
    expect(synthetic!.status).toBe('resolved');
  });

  it('a green validate auto-resolves an open synthetic finding even when no review confirmed it', async () => {
    // Round 3 reviewer OMITS the synthetic finding (anti-vanish keeps it open →
    // changes-required → a second remediate → round 4 confirms). This proves the
    // safety net is orthogonal: after the final green validate, no open
    // synthetic:validate finding survives in the sidecar regardless of how the
    // review rounds went.
    const agentLauncher = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJsonByRound: {
        1: JSON.stringify({ findings: [] }),
        3: JSON.stringify({ findings: [] }),
        4: JSON.stringify({
          findings: [
            {
              severity: 'critical',
              file: VALIDATE_COMMAND,
              title: 'validate phase failed',
              detail: 'Fixed.',
              status: 'resolved',
            },
          ],
        }),
      },
    });
    const runValidatePhase = vi
      .fn()
      .mockResolvedValueOnce(makeValidateFailure())
      .mockResolvedValue(makeSuccessResult('validate'));
    const remediateExecute = vi.fn(async (): Promise<PhaseResult> => {
      await bumpRemediationCount(harness.checkoutPath, harness.workflowId);
      return makeSuccessResult('remediate');
    });
    const { context, config, deps } = harness.build({
      agentLauncher,
      startPhase: 'review',
      extraDeps: {
        remediateExecutor: { execute: remediateExecute } as never,
        remediateTrigger: (ctx: WorkerContext) =>
          readReviewArtifactSync(ctx.checkoutPath, harness.workflowId)?.verdict ===
          'changes-required',
        failureFingerprintTracker: { countPriorOccurrences: vi.fn(async () => 0) } as never,
      },
    });
    (deps.cliSpawner as { runValidatePhase: unknown }).runValidatePhase = runValidatePhase;

    const result = await harness.phaseLoop.executeLoop(context, config, deps, [
      'review',
      'validate',
    ]);
    expect(result.completed).toBe(true);
    expect(remediateExecute).toHaveBeenCalledTimes(2);

    const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
    expect(artifact!.verdict).toBe('clean');
    expect(
      artifact!.findings.filter((f) => f.synthetic === 'validate' && f.status === 'open'),
    ).toHaveLength(0);
  });
});
