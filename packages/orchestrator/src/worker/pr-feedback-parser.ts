/**
 * Dual-source external-feedback parser (#1130, T011).
 *
 * Extracts trusted findings from a PR's inline review threads AND top-level
 * review bodies, mapping them to {@link ExternalFeedbackFinding}[]. This is the
 * retained parser previously embedded in `PrFeedbackHandler.handle()` (~218-402),
 * lifted to a standalone callable so the thin `address-pr-feedback` adapter in
 * `claude-cli-worker.ts` can seed the shared review/remediate loop without
 * running the legacy fixer.
 *
 * Trust gating mirrors the handler exactly (#842/#869/#878/#1047 Finding 3):
 *   - Inline threads: `getPRReviewThreads` → drop resolved → per-comment
 *     `isTrustedCommentAuthor('pr-feedback')`. A thread contributes each of its
 *     trusted comments (with `path`/`line` when present).
 *   - Review bodies: `listReviews` → keep `CHANGES_REQUESTED | COMMENTED` with a
 *     non-empty body → per-review `isTrustedCommentAuthor('pr-feedback')` via a
 *     Comment-shaped stub. Trusted bodies keep the legacy
 *     "review body (no file anchor):\n\n<body>" prefix so body-only asks survive
 *     (FR-004); they carry no `path`/`line`.
 *
 * Both fetches are best-effort in the same shape as the handler: a thread-fetch
 * failure throws (the inline path is the primary signal), a review-fetch failure
 * is log-and-continue (the body path is supplementary).
 */
import {
  isTrustedCommentAuthor,
  tryLoadCommentTrustConfig,
} from '@generacy-ai/workflow-engine';
import type { Comment, GitHubClient, Review } from '@generacy-ai/workflow-engine';
import type { Logger } from './types.js';
import type { ExternalFeedbackFinding } from './external-feedback-seed.js';
import { commentCarriesEngineAuthoredReviewMarker } from './review-poster.js';

export interface ParseExternalFeedbackParams {
  github: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  checkoutPath: string;
  logger: Logger;
}

/**
 * Map a trusted inline comment to a finding. `Comment.id` is numeric; the seed
 * finding `id` is a string, so we stringify. `path`/`line` flow through when the
 * comment anchors to a file+line.
 */
function inlineCommentToFinding(c: Comment): ExternalFeedbackFinding {
  return {
    id: String(c.id),
    body: c.body,
    author: c.author,
    ...(c.path !== undefined ? { path: c.path } : {}),
    ...(c.line !== undefined ? { line: c.line } : {}),
  };
}

/**
 * Map a trusted review body to a finding. Keeps the legacy no-anchor prefix and
 * carries no `path`/`line` (FR-004).
 */
function reviewBodyToFinding(r: Review): ExternalFeedbackFinding {
  return {
    id: String(r.id),
    body: `review body (no file anchor):\n\n${r.body}`,
    author: r.user.login,
  };
}

/**
 * Extract trusted dual-source findings from a PR. Returns `[]` when no trusted
 * finding is present on either source. Never returns untrusted content.
 */
export async function parseExternalFeedback(
  params: ParseExternalFeedbackParams,
): Promise<ExternalFeedbackFinding[]> {
  const { github, owner, repo, prNumber, checkoutPath, logger } = params;

  const trustConfig = tryLoadCommentTrustConfig(checkoutPath, logger);
  const botLogin = process.env['CLUSTER_GITHUB_USERNAME'] ?? process.env['GH_USERNAME'];

  const findings: ExternalFeedbackFinding[] = [];

  // 1. Inline review threads (primary signal — fetch failure throws).
  const threads = await github.getPRReviewThreads(owner, repo, prNumber);
  const unresolvedThreads = threads.filter((t) => !t.isResolved);
  for (const thread of unresolvedThreads) {
    for (const c of thread.comments) {
      // #1130 finding #4: exclude engine-authored comments regardless of trust.
      // The engine bot IS a trusted author, so a pure trust filter would re-seed
      // the engine's own review threads (`<!-- generacy-finding:... -->` /
      // `<!-- generacy-engine-review ... -->`) into the remediate loop alongside
      // the genuine human ask — the same double-processing the monitor's FR-010
      // exclusion prevents. Skipping per-comment (not per-thread) keeps a mixed
      // thread's human comment(s) while dropping the engine reply(ies) in it.
      if (commentCarriesEngineAuthoredReviewMarker(c.body)) {
        continue;
      }
      const decision = isTrustedCommentAuthor(c, 'pr-feedback', {
        logger,
        ...(botLogin ? { botLogin } : {}),
        ...(trustConfig ? { config: trustConfig } : {}),
      });
      if (decision.trusted) {
        findings.push(inlineCommentToFinding(c));
      } else {
        logger.info(
          {
            event: 'comment-skipped',
            surface: 'pr-feedback',
            commentId: c.id,
            author: c.author,
            authorAssociation: c.authorAssociation,
            reason: decision.reason,
            viewerDidAuthor: c.viewerDidAuthor ?? null,
          },
          'Skipped PR review comment from untrusted author',
        );
      }
    }
  }

  // 2. Top-level review bodies (supplementary — fetch failure log-and-continue).
  try {
    const reviews = await github.listReviews(owner, repo, prNumber);
    const stateAndBodyOK = reviews.filter(
      (r: Review) =>
        (r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED') &&
        r.body.trim().length > 0,
    );
    for (const r of stateAndBodyOK) {
      // #1130 finding #4: the engine posts its own review submissions carrying
      // the round marker (`<!-- generacy-engine-review round=<N> -->`). Exclude
      // them from external-feedback synthesis for the same reason as the inline
      // path — the engine's review is already the driver of the shared loop, not
      // external feedback to route back into it.
      if (commentCarriesEngineAuthoredReviewMarker(r.body)) {
        continue;
      }
      const stub: Comment = {
        id: r.id,
        body: r.body,
        author: r.user.login,
        created_at: r.submittedAt,
        updated_at: r.submittedAt,
        viewerDidAuthor: false,
        ...(r.authorAssociation ? { authorAssociation: r.authorAssociation } : {}),
      };
      const decision = isTrustedCommentAuthor(stub, 'pr-feedback', {
        logger,
        ...(botLogin ? { botLogin } : {}),
        ...(trustConfig ? { config: trustConfig } : {}),
      });
      if (decision.trusted) {
        findings.push(reviewBodyToFinding(r));
      } else {
        logger.info(
          {
            event: 'review-body-skipped',
            surface: 'pr-feedback',
            reviewId: r.id,
            author: r.user.login,
            authorAssociation: r.authorAssociation,
            reason: decision.reason,
          },
          'Skipped PR review body from untrusted author (#1047 Finding 3)',
        );
      }
    }
  } catch (error) {
    logger.warn(
      { error: String(error), prNumber, owner, repo },
      'Failed to fetch PR reviews (#1130 external-feedback body path) — continuing with thread-only findings',
    );
  }

  return findings;
}
