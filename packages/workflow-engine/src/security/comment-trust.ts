/**
 * Comment author-trust helper.
 *
 * Shared logic for the three ingestion surfaces (clarify answer-scanner,
 * clarify resume prompt, PR-feedback reader). See specs/842 and
 * data-model.md §New Entities for the trust matrix and decision order.
 */

import type { Comment } from '../types/github.js';
import type { Logger } from '../types/logger.js';
import type { CommentTrustConfig } from './comment-trust-config.js';

export type TrustSurface = 'answer-scanner' | 'clarify-resume' | 'pr-feedback';

export type TrustReason =
  | 'owner'
  | 'member'
  | 'collaborator'
  | 'bot'
  | 'self-authored'
  | 'widened-tier'
  | 'widened-login'
  | 'none-untrusted'
  | 'first-timer-untrusted'
  | 'first-time-contributor-untrusted'
  | 'mannequin-untrusted'
  | 'contributor-untrusted'
  | 'author-association-unset'
  | 'unknown-tier';

export interface TrustDecision {
  trusted: boolean;
  reason: TrustReason;
}

export interface CommentTrustContext {
  botLogin?: string;
  config?: CommentTrustConfig;
  logger: Logger;
}

/**
 * Normalize a GitHub login for equality comparison. Strips wrapping
 * whitespace, lowercases (GitHub logins are case-insensitive), then
 * removes a trailing `[bot]` suffix (a REST-surface rendering artifact —
 * GraphQL exposes the same account without it). See specs/874-…/contracts/
 * normalize-login.contract.md for the full fixture matrix.
 */
export function normalizeLogin(raw: string): string {
  return raw.trim().toLowerCase().replace(/\[bot\]$/, '');
}

export const DEFAULT_TRUSTED_TIERS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;
export const KNOWN_UNTRUSTED_TIERS = [
  'NONE',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'MANNEQUIN',
  'CONTRIBUTOR',
] as const;

const TIER_TO_TRUSTED_REASON: Record<string, TrustReason> = {
  OWNER: 'owner',
  MEMBER: 'member',
  COLLABORATOR: 'collaborator',
};

const TIER_TO_UNTRUSTED_REASON: Record<string, TrustReason> = {
  NONE: 'none-untrusted',
  FIRST_TIME_CONTRIBUTOR: 'first-time-contributor-untrusted',
  FIRST_TIMER: 'first-timer-untrusted',
  MANNEQUIN: 'mannequin-untrusted',
  CONTRIBUTOR: 'contributor-untrusted',
};

/**
 * Surfaces whose fetch path populates `viewerDidAuthor` via GraphQL — a
 * missing/non-boolean value on these surfaces is a shape-drift alarm
 * (wrong-method trap for a future refactor that routes through REST). See
 * #878 (pr-feedback) and #910 (answer-scanner + clarify-resume).
 */
const MIGRATED_SURFACES: ReadonlySet<TrustSurface> = new Set([
  'pr-feedback',
  'answer-scanner',
  'clarify-resume',
]);

/**
 * Decide whether a comment author is trusted for the given ingestion surface.
 *
 * Pure function except for the SC-008 warn on unknown tier — no file I/O,
 * no env reads. See specs/842/contracts/trust-helper.contract.md for the
 * decision order and full matrix.
 */
export function isTrustedCommentAuthor(
  comment: Comment,
  surface: TrustSurface,
  ctx: CommentTrustContext,
): TrustDecision {
  // 1. Bot login match — always trusted, regardless of tier or unset field.
  //    Normalize both sides so REST (`generacy-ai[bot]`) and GraphQL
  //    (`generacy-ai`) surfaces compare equal. Empty result after
  //    normalization does not match.
  if (ctx.botLogin) {
    const normalizedBot = normalizeLogin(ctx.botLogin);
    const normalizedAuthor = normalizeLogin(comment.author);
    if (normalizedBot !== '' && normalizedBot === normalizedAuthor) {
      return { trusted: true, reason: 'bot' };
    }
  }

  // 1.5 Self-authored comment (#878, extended to answer-scanner + clarify-resume
  //     in #910). Uses GraphQL's viewerDidAuthor primitive, keyed on the
  //     authenticated App identity — stable across installation-token
  //     rotation. The warn on non-boolean values (Q3→D) is scoped to the
  //     migrated surfaces: pr-feedback (via `getPRReviewThreads()`),
  //     answer-scanner and clarify-resume (via
  //     `getIssueCommentsWithViewerAuth()`). On these fetch paths the field
  //     is structurally required; absence is a shape-drift alarm — including
  //     the case of a future caller that accidentally routes through the
  //     REST `getIssueComments()` (wrong-method trap).
  if (comment.viewerDidAuthor === true) {
    return { trusted: true, reason: 'self-authored' };
  }
  if (MIGRATED_SURFACES.has(surface) && comment.viewerDidAuthor !== false) {
    ctx.logger.warn(
      'viewerDidAuthor missing/non-boolean on comment; treating as not self-authored',
      { surface, commentId: comment.id, observedValue: comment.viewerDidAuthor },
    );
  }

  const tier = comment.authorAssociation;

  // 2. Unset authorAssociation — fail-closed, no warn (expected for older
  //    fixtures/cached objects).
  if (tier === undefined || tier === null || tier === '') {
    return { trusted: false, reason: 'author-association-unset' };
  }

  // 3. Default-trusted tier — config can never remove these.
  const trustedReason = TIER_TO_TRUSTED_REASON[tier];
  if (trustedReason) {
    return { trusted: true, reason: trustedReason };
  }

  // 4 + 5. Widen-config paths — context surfaces only. Answer-scanner is
  //        pinned to the hard default (Q4 / SC-009).
  if (surface !== 'answer-scanner' && ctx.config) {
    const widenLogins = ctx.config.widen.logins;
    if (widenLogins.includes(comment.author)) {
      return { trusted: true, reason: 'widened-login' };
    }
    const widenTiers = ctx.config.widen.tiers;
    if (widenTiers.includes(tier)) {
      return { trusted: true, reason: 'widened-tier' };
    }
  }

  // 6. Known untrusted tier — normal reason, no warn.
  const untrustedReason = TIER_TO_UNTRUSTED_REASON[tier];
  if (untrustedReason) {
    return { trusted: false, reason: untrustedReason };
  }

  // 7. Unknown / future tier — warn once naming the tier (SC-008).
  ctx.logger.warn('unrecognized author_association tier; treating as untrusted', {
    authorAssociation: tier,
    commentId: comment.id,
  });
  return { trusted: false, reason: 'unknown-tier' };
}
