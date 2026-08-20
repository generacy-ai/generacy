/**
 * Seed-aware review executor (#1130, plan D-1, `contracts/external-feedback-seed.md` Module 2).
 *
 * Occupies the `deps.reviewExecutor` slot and wraps the real {@link ReviewExecutor}
 * (#1124). On the FIRST round of an `address-pr-feedback` re-entry the thin adapter
 * has written an {@link ExternalFeedbackSeed} sidecar; this wrapper consumes it,
 * synthesizes the findings artifact with `verdict = 'changes-required'`, deletes the
 * seed (consume-once), and returns a synthetic success WITHOUT spawning the review
 * CLI — so a body-only external finding is preserved verbatim into the artifact
 * (SC-004) and the downstream `remediateTrigger` fires the shared remediate loop
 * rather than the legacy fixer (FR-003).
 *
 * When no seed is present (convergence rounds after the seed was consumed) it
 * delegates to the real executor, which re-derives the verdict from the actual diff
 * and, when clean, flips the PR back to ready-for-review.
 */
import { clearExternalFeedbackSeed, readExternalFeedbackSeed } from './external-feedback-seed.js';
import type { ReviewExecutor, ReviewExecutorLike } from './review-executor.js';
import {
  computeVerdict,
  readReviewArtifact,
  writeReviewArtifact,
  type ReviewFinding,
  type Severity,
} from './review-artifact.js';
import type { Logger, PhaseResult, WorkerContext } from './types.js';

/**
 * Severity stamped on every seeded finding. External review feedback carries no
 * severity signal, so we mark it at the top rank — this guarantees
 * `computeVerdict` returns `'changes-required'` regardless of the workflow's
 * `blockingSeverity` threshold (data-model allows "blockingSeverity or higher"),
 * without needing access to the workflow review config from this wrapper.
 */
const SEEDED_FINDING_SEVERITY: Severity = 'critical';

/** Non-empty placeholder for review-body findings that have no file anchor. */
const NO_ANCHOR_FILE_PLACEHOLDER = '(pr-review)';

export interface SeedAwareReviewExecutorDeps {
  /** The real #1124 executor, used for convergence rounds once the seed is gone. */
  delegate: ReviewExecutor;
  logger: Logger;
}

export class SeedAwareReviewExecutor implements ReviewExecutorLike {
  private readonly delegate: ReviewExecutor;
  private readonly logger: Logger;

  constructor(deps: SeedAwareReviewExecutorDeps) {
    this.delegate = deps.delegate;
    this.logger = deps.logger;
  }

  async execute(context: WorkerContext): Promise<PhaseResult> {
    const startedAt = Date.now();
    const { checkoutPath } = context;
    const { owner, repo, issueNumber } = context.item;
    const workflowId = `${owner}/${repo}#${issueNumber}`;

    const seed = await readExternalFeedbackSeed(checkoutPath, workflowId);

    if (seed === null) {
      // Convergence round — the seed was consumed on round 1. Delegate to the
      // real executor so the verdict is re-derived from the actual diff.
      return this.delegate.execute(context);
    }

    // Seeding round: synthesize the findings artifact directly from the seed.
    const findings: ReviewFinding[] = seed.findings.map((f) => ({
      severity: SEEDED_FINDING_SEVERITY,
      file: f.path ?? NO_ANCHOR_FILE_PLACEHOLDER,
      ...(f.line !== undefined ? { line: f.line } : {}),
      title: `External feedback from ${f.author}`,
      detail: f.body,
      round: 0,
      status: 'open' as const,
    }));

    const verdict = computeVerdict(findings, SEEDED_FINDING_SEVERITY);

    const prior = await readReviewArtifact(checkoutPath, workflowId);
    const round = (prior?.round ?? 0) + 1;

    const lastReviewedCommitSha = await context.github.getCurrentCommitSha();

    await writeReviewArtifact(checkoutPath, workflowId, {
      findings,
      verdict,
      round,
      lastReviewedCommitSha,
    });

    // Consume-once: delete the seed before the loop can re-enter `review`, so
    // convergence rounds delegate to the real executor.
    await clearExternalFeedbackSeed(checkoutPath, workflowId);

    this.logger.info(
      {
        workflowId,
        prNumber: seed.prNumber,
        findingCount: findings.length,
        verdict,
        round,
        lastReviewedCommitSha,
      },
      'Seed-aware review synthesized artifact from external feedback — no CLI spawn',
    );

    return {
      phase: 'review',
      success: true,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      output: [],
    };
  }
}
