/**
 * External-feedback thread resolver (#1130 finding #1(a)).
 *
 * Closes the convergence half of the address-pr-feedback runaway: when the
 * shared review/remediate loop completes for an `address-pr-feedback` re-entry
 * (verdict clean → PR marked ready), the external human threads that seeded the
 * loop are still unresolved. Left as-is, the monitor's next poll sees them live
 * and re-enqueues — clearing the review artifact (budget reset) and re-seeding
 * from round 1, an infinite loop.
 *
 * On convergence we therefore resolve each seeded external inline thread with an
 * invite-to-reopen reply, mirroring the legacy fixer's behavior
 * (`pr-feedback-handler.ts`): the reviewer re-opens if the change still falls
 * short, which produces a NEW unresolved thread and legitimately re-arms the
 * trigger with a fresh remediation budget (FR-006).
 *
 * The complementary cap half — when the loop instead exhausts the remediation
 * budget — is handled by the monitor's `waiting-for:remediation-limit` skip;
 * there the threads MUST stay unresolved so the operator sees the unaddressed
 * feedback.
 *
 * All operations are best-effort: no failure here may fail an already-completed
 * workflow.
 */
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger } from './types.js';
import { commentCarriesEngineAuthoredReviewMarker } from './review-poster.js';

export interface ResolveExternalFeedbackThreadsParams {
  github: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  /** Root comment ids captured by the monitor at enqueue (`metadata.reviewThreadIds`). */
  rootCommentIds: readonly number[];
  /** Short SHA of the converged branch head — decoration in the reply body. */
  headShortSha: string;
  logger: Logger;
}

/**
 * Resolve the seeded external inline threads on loop convergence. Matches
 * threads by `rootCommentId` against the monitor-captured id set, skips threads
 * already resolved or fully engine-authored, posts one invite-to-reopen reply,
 * then resolves. Each thread is independent — one failure warns and does not
 * block the others. Never throws.
 */
export async function resolveExternalFeedbackThreads(
  params: ResolveExternalFeedbackThreadsParams,
): Promise<void> {
  const { github, owner, repo, prNumber, rootCommentIds, headShortSha, logger } = params;

  if (rootCommentIds.length === 0) return;
  const targets = new Set(rootCommentIds);

  let threads;
  try {
    threads = await github.getPRReviewThreads(owner, repo, prNumber);
  } catch (error) {
    logger.warn(
      { error: String(error), prNumber, owner, repo },
      '#1130: failed to fetch review threads for convergence resolution — non-fatal',
    );
    return;
  }

  let resolved = 0;
  for (const thread of threads) {
    if (thread.isResolved) continue;
    if (!targets.has(thread.rootCommentId)) continue;
    // Defensive: never resolve a thread whose every comment is engine-authored.
    // Those are excluded from the trigger to begin with (FR-010); a thread that
    // reached the seed necessarily carried a human comment, but guard anyway so
    // a stale target id can never resolve an engine-only thread.
    const allEngineAuthored =
      thread.comments.length > 0 &&
      thread.comments.every((c) => commentCarriesEngineAuthoredReviewMarker(c.body));
    if (allEngineAuthored) continue;

    const replyBody =
      `The engine review/remediate loop completed for this feedback (${headShortSha}). ` +
      'Re-open this thread if it still needs changes.';
    try {
      await github.replyToPRComment(owner, repo, prNumber, thread.rootCommentId, replyBody);
    } catch (error) {
      logger.warn(
        { error: String(error), prNumber, rootCommentId: thread.rootCommentId },
        '#1130: failed to post convergence reply — continuing to resolve thread',
      );
    }
    try {
      await github.resolveReviewThread(thread.id);
      resolved++;
      logger.info(
        { prNumber, owner, repo, rootCommentId: thread.rootCommentId },
        '#1130: resolved external feedback thread on loop convergence',
      );
    } catch (error) {
      logger.warn(
        { error: String(error), prNumber, threadId: thread.id, rootCommentId: thread.rootCommentId },
        '#1130: failed to resolve external feedback thread — non-fatal',
      );
    }
  }

  logger.info(
    { prNumber, owner, repo, targetCount: targets.size, resolved },
    '#1130: external feedback thread resolution complete',
  );
}
