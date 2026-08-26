/**
 * US3 (#1168, T020 / T021, FR-008) — the clean-review happy path and the
 * changes-required → draft-conversion path, end-to-end through the REAL
 * production code, with NO verdict-steering stub.
 *
 * Re-pointed off the old `readFindingsArtifact`-steered double (which returned a
 * hand-built CLEAN `FindingsArtifact` and left the review executor as the #1121
 * stub). That masked the exact "seam passes, production fails" class #1168
 * exists to close (#1155 phantom-clean, #1156 unwired poster). Now:
 *   - the verdict is RECOMPUTED by the real `ReviewExecutor` + `computeVerdict`
 *     from a candidate the scripted-CLI fixture writes (real `child_process`
 *     spawn via the `createReviewCompositionHarness` double);
 *   - posting runs through the real `ReviewPoster` (#1125) against the harness's
 *     recording-fake `GitHubClient`, so the assertions target the actual wire
 *     behavior — exactly one COMMENT review, zero REQUEST_CHANGES, the
 *     engine-authored marker on the body, and the ready/draft lifecycle calls;
 *   - the `readFindingsArtifact` reader is REAL: it reads the engine-written
 *     authoritative artifact and returns `{ artifact, blockingSeverity }`
 *     exactly as `claude-cli-worker.ts` wires it in production.
 *
 * This preserves every assertion the prior double-based suite made (COMMENT-only
 * review, marker present, ready on clean, no draft-convert on clean) and adds
 * the positive draft-conversion case a clean-only steer could never reach.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  ReviewPoster,
  matchEngineAuthoredReviewMarker,
} from '../review-poster.js';
import { readReviewArtifact } from '../review-artifact.js';
import type { Severity } from '../review-artifact.js';
import type { PhaseLoopDeps } from '../phase-loop.js';
import type { WorkflowPhase } from '../types.js';
import type { CreateReviewInput } from '@generacy-ai/workflow-engine';
import {
  createReviewCompositionHarness,
  type ReviewCompositionHarness,
} from './helpers/review-composition-harness.js';

const harnesses: ReviewCompositionHarness[] = [];

async function newHarness(
  opts: { workflowName?: string } = {},
): Promise<ReviewCompositionHarness> {
  const h = await createReviewCompositionHarness(opts);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()!.cleanup();
  }
});

/**
 * The real posting deps: a real `ReviewPoster` bound to the harness's recording
 * github, and a REAL `readFindingsArtifact` reading the engine-written artifact
 * and returning `{ artifact, blockingSeverity }` — the exact shape
 * `claude-cli-worker.ts` wires in production (NOT the deleted `{ artifact, round }`).
 */
function realPostingDeps(
  harness: ReviewCompositionHarness,
  blockingSeverity: Severity,
): Partial<PhaseLoopDeps> {
  return {
    reviewPoster: new ReviewPoster({
      github: harness.github,
      owner: harness.owner,
      repo: harness.repo,
      getPrNumber: () => 42,
      logger: harness.logger,
    }),
    readFindingsArtifact: async () => {
      const artifact = await readReviewArtifact(harness.checkoutPath, harness.workflowId);
      return artifact ? { artifact, blockingSeverity } : null;
    },
  };
}

/** Phases in the order the loop marked them active (via labelManager.onPhaseStart). */
function phaseStartOrder(deps: PhaseLoopDeps): WorkflowPhase[] {
  return (deps.labelManager.onPhaseStart as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    (c) => c[0] as WorkflowPhase,
  );
}

/** A clean candidate: one open `minor` finding, gated at `critical` → verdict clean. */
function cleanCandidateJson(): string {
  return JSON.stringify({
    findings: [
      {
        severity: 'minor',
        file: 'packages/orchestrator/src/foo.ts',
        line: 1,
        title: 'advisory nit',
        detail: 'below the blocking threshold — non-blocking',
        status: 'open',
      },
    ],
  });
}

/** The stable file+title identifying the single blocking finding across rounds. */
const BLOCKING_FILE = 'packages/orchestrator/src/foo.ts';
const BLOCKING_TITLE = 'blocking defect';

/** A blocking candidate: one open `critical` finding → verdict changes-required. */
function changesRequiredCandidateJson(): string {
  return JSON.stringify({
    findings: [
      {
        severity: 'critical',
        file: BLOCKING_FILE,
        line: 1,
        title: BLOCKING_TITLE,
        detail: 'an open blocking finding',
        status: 'open',
      },
    ],
  });
}

/**
 * The round-2 candidate that RESOLVES the round-1 blocking finding: same
 * file+title (⇒ same deterministic id) marked `resolved`, so the engine merge
 * transitions the prior `open` copy to `resolved` and recomputes `clean`. An
 * empty-findings round 2 would NOT resolve the carried-over open finding, so the
 * verdict would stay `changes-required` and never reach the ready path.
 */
function resolvedCandidateJson(): string {
  return JSON.stringify({
    findings: [
      {
        severity: 'critical',
        file: BLOCKING_FILE,
        line: 1,
        title: BLOCKING_TITLE,
        detail: 'the blocking finding, now resolved',
        status: 'resolved',
      },
    ],
  });
}

describe('US3 (#1168) — clean-review happy path, real ReviewExecutor + real ReviewPoster', () => {
  // T021 — parameterized across both speckit workflows (SC-002). The verdict is
  // recomputed by the real executor from a clean candidate; the loop advances
  // implement → review → validate with review immediately after implement.
  for (const workflow of ['speckit-feature', 'speckit-bugfix'] as const) {
    it(`traverses implement → review → validate with review immediately after implement (${workflow}, FR-001/SC-002)`, async () => {
      const harness = await newHarness({ workflowName: workflow });
      const agentLauncher = harness.makeSpawningLauncher({
        mode: 'write',
        candidateJson: cleanCandidateJson(),
      });
      const { context, config, deps, sequence } = harness.build({
        agentLauncher,
        blockingSeverity: 'critical',
        extraDeps: realPostingDeps(harness, 'critical'),
      });

      const result = await harness.phaseLoop.executeLoop(context, config, deps, sequence);

      expect(result.completed).toBe(true);
      const order = phaseStartOrder(deps);
      expect(order).toEqual(['implement', 'review', 'validate']);
      expect(order.indexOf('review')).toBe(order.indexOf('implement') + 1);
    });
  }

  // T021 — exactly one COMMENT review, zero REQUEST_CHANGES on the own PR
  // (FR-002 / SC-003), driven by a real executor verdict through the real poster.
  it('posts exactly one COMMENT review with zero REQUEST_CHANGES (FR-002 / SC-003)', async () => {
    const harness = await newHarness();
    const agentLauncher = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJson: cleanCandidateJson(),
    });
    const { context, config, deps, sequence } = harness.build({
      agentLauncher,
      blockingSeverity: 'critical',
      extraDeps: realPostingDeps(harness, 'critical'),
    });

    await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    const createReview = harness.github.createReview as unknown as ReturnType<typeof vi.fn>;
    expect(createReview).toHaveBeenCalledTimes(1);
    const inputs = createReview.mock.calls.map((c) => c[3] as CreateReviewInput);
    expect(inputs.map((i) => i.event)).toEqual(['COMMENT']);
    expect(inputs.some((i) => i.event === 'REQUEST_CHANGES')).toBe(false);
  });

  // T021 — the posted body carries the engine-authored marker (via the FR-005
  // match helper, not a raw string literal, so the suite cannot drift).
  it('stamps the engine-authored marker on the review body (FR-005 helper)', async () => {
    const harness = await newHarness();
    const agentLauncher = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJson: cleanCandidateJson(),
    });
    const { context, config, deps, sequence } = harness.build({
      agentLauncher,
      blockingSeverity: 'critical',
      extraDeps: realPostingDeps(harness, 'critical'),
    });

    await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    const createReview = harness.github.createReview as unknown as ReturnType<typeof vi.fn>;
    const input = createReview.mock.calls[0]![3] as CreateReviewInput;
    expect(matchEngineAuthoredReviewMarker(input.body)).toBeDefined();
  });

  // T021 — markReadyForReview on clean verdict; the loop advances into validate,
  // and convert-to-draft never fires on a clean pass.
  it('marks the PR ready on clean verdict and advances into validate (FR-003)', async () => {
    const harness = await newHarness();
    const agentLauncher = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJson: cleanCandidateJson(),
    });
    const { context, config, deps, sequence } = harness.build({
      agentLauncher,
      blockingSeverity: 'critical',
      extraDeps: realPostingDeps(harness, 'critical'),
    });

    await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    expect(deps.prManager.markReadyForReview).toHaveBeenCalledTimes(1);
    // convert-to-draft is a remediate-entry side effect — never on a clean pass.
    expect(deps.prManager.convertToDraftIfEngineMarkedReady).not.toHaveBeenCalled();
    expect(phaseStartOrder(deps)).toContain('validate');
  });
});

describe('US3 (#1168) — changes-required cycle converts the PR to draft (T021)', () => {
  it('converts the PR to draft when the engine drives a changes-required review, then re-reviews clean', async () => {
    const harness = await newHarness();
    // Round 1 recomputes changes-required (open critical); round 2 resolves that
    // same finding (same id) → recomputed clean. The fire-once trigger drives the
    // off-sequence remediate pass, whose entry converts the PR back to draft
    // (#1125 FR-006).
    const agentLauncher = harness.makeSpawningLauncher({
      mode: 'write',
      candidateJsonByRound: {
        1: changesRequiredCandidateJson(),
        2: resolvedCandidateJson(),
      },
    });

    const counter = { fired: 0 };
    const remediateTrigger = (): boolean => {
      if (counter.fired >= 1) return false;
      counter.fired += 1;
      return true;
    };

    const { context, config, deps, sequence } = harness.build({
      agentLauncher,
      blockingSeverity: 'critical',
      extraDeps: {
        ...realPostingDeps(harness, 'critical'),
        remediateTrigger,
      },
    });

    await harness.phaseLoop.executeLoop(context, config, deps, sequence);

    // The changes-required round drove the remediate seam, which converts the PR
    // to draft before remediating (inspect the recorded draft call).
    expect(deps.prManager.convertToDraftIfEngineMarkedReady).toHaveBeenCalled();
    expect(counter.fired).toBe(1);
    // The subsequent clean re-review posted through the real poster and marked ready.
    expect(deps.prManager.markReadyForReview).toHaveBeenCalled();
  });
});
