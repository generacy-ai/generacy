/**
 * Acquire-or-refresh-or-takeover the active-driver claim (#1015).
 *
 * Four branches per R-10:
 *
 *  1. **acquire** — no claim exists → post marker + apply label; re-discover
 *     to verify we're the sole live holder.
 *  2. **refresh** — same session holds → edit marker with new heartbeatAt.
 *  3. **takeover** — `takeover: true` && different session → delete
 *     incumbent + post ours; re-discover to verify.
 *  4. **refuse** — different session && `takeover: false` → return refusal.
 *
 * Stale claim is treated as no-claim regardless of `takeover` / `sessionId`.
 * Takeover-when-already-holder collapses to refresh (idempotency contract).
 *
 * Post-then-verify is single-shot (no retry loop). Losing the race deletes
 * our just-posted comment and returns a refusal — the caller retries at the
 * next wake tick.
 */
import type { GhWrapper } from '@generacy-ai/cockpit';
import type {
  AcquireResult,
  ClaimPayload,
  RefusalPayload,
} from './payload.js';
import { formatMarker } from './marker.js';
import { CLAIM_LABEL, discoverClaim } from './discover.js';

export interface AcquireArgs {
  gh: GhWrapper;
  scope: { owner: string; repo: string; number: number };
  sessionId: string;
  ledger: string;
  takeover: boolean;
  now: Date;
}

export async function acquireClaim(
  args: AcquireArgs,
): Promise<AcquireResult | RefusalPayload> {
  const { gh, scope, sessionId, ledger, takeover, now } = args;
  const repoRef = `${scope.owner}/${scope.repo}`;
  const scopeStr = `${scope.owner}/${scope.repo}#${scope.number}`;

  const initial = await discoverClaim(gh, scope.owner, scope.repo, scope.number, now);

  if (initial.kind === 'no-claim') {
    return acquireFresh({
      gh,
      repoRef,
      issue: scope.number,
      scopeStr,
      sessionId,
      ledger,
      now,
    });
  }

  const holder = initial.live.payload;
  if (holder.sessionId === sessionId) {
    return refresh({
      gh,
      repoRef,
      issue: scope.number,
      commentId: initial.live.commentId,
      commentUrl: initial.live.commentUrl,
      previous: holder,
      ledger,
      now,
      labelMissing: initial.orphanedLabelPresent,
    });
  }

  if (!takeover) {
    return buildRefusal(holder, initial.live.commentUrl, scopeStr);
  }

  return takeOver({
    gh,
    repoRef,
    issue: scope.number,
    scopeStr,
    sessionId,
    ledger,
    now,
    incumbent: holder,
    incumbentCommentId: initial.live.commentId,
    labelMissing: initial.orphanedLabelPresent,
  });
}

interface AcquireFreshArgs {
  gh: GhWrapper;
  repoRef: string;
  issue: number;
  scopeStr: string;
  sessionId: string;
  ledger: string;
  now: Date;
}

async function acquireFresh(
  args: AcquireFreshArgs,
): Promise<AcquireResult | RefusalPayload> {
  const payload = buildPayload(
    args.sessionId,
    args.ledger,
    args.scopeStr,
    args.now,
    args.now,
  );
  const posted = await args.gh.postIssueComment(
    args.repoRef,
    args.issue,
    formatMarker(payload),
  );
  await args.gh.addLabels(args.repoRef, args.issue, [CLAIM_LABEL]);

  const verified = await discoverClaim(
    args.gh,
    ...splitRepo(args.repoRef),
    args.issue,
    args.now,
  );
  if (
    verified.kind === 'held' &&
    verified.live.payload.sessionId === args.sessionId
  ) {
    return {
      status: 'ok',
      action: 'acquired',
      claim: verified.live.payload,
      commentUrl: verified.live.commentUrl,
    };
  }
  // Race lost — delete our own comment (best-effort) and refuse.
  const ourCommentId = extractCommentIdFromUrl(posted.url);
  if (ourCommentId > 0) {
    await bestEffort(async () => {
      await args.gh.deleteIssueComment(args.repoRef, ourCommentId);
    });
  }
  if (verified.kind === 'held') {
    return buildRefusal(
      verified.live.payload,
      verified.live.commentUrl,
      args.scopeStr,
    );
  }
  // Race also cleared the winner — treat as generic conflict; the caller can
  // retry on the next wake tick.
  return buildRefusal(payload, posted.url, args.scopeStr);
}

interface RefreshArgs {
  gh: GhWrapper;
  repoRef: string;
  issue: number;
  commentId: number;
  commentUrl: string;
  previous: ClaimPayload;
  ledger: string;
  now: Date;
  labelMissing: boolean;
}

async function refresh(args: RefreshArgs): Promise<AcquireResult> {
  const payload = buildPayload(
    args.previous.sessionId,
    args.ledger,
    args.previous.scope,
    new Date(args.previous.heldSince),
    args.now,
  );
  await args.gh.editIssueComment(
    args.repoRef,
    args.commentId,
    formatMarker(payload),
  );
  if (args.labelMissing) {
    await bestEffort(async () => {
      await args.gh.addLabels(args.repoRef, args.issue, [CLAIM_LABEL]);
    });
  }
  return {
    status: 'ok',
    action: 'refreshed',
    claim: payload,
    commentUrl: args.commentUrl,
  };
}

interface TakeOverArgs {
  gh: GhWrapper;
  repoRef: string;
  issue: number;
  scopeStr: string;
  sessionId: string;
  ledger: string;
  now: Date;
  incumbent: ClaimPayload;
  incumbentCommentId: number;
  labelMissing: boolean;
}

async function takeOver(
  args: TakeOverArgs,
): Promise<AcquireResult | RefusalPayload> {
  await bestEffort(async () => {
    await args.gh.deleteIssueComment(args.repoRef, args.incumbentCommentId);
  });
  const payload = buildPayload(
    args.sessionId,
    args.ledger,
    args.scopeStr,
    args.now,
    args.now,
  );
  const posted = await args.gh.postIssueComment(
    args.repoRef,
    args.issue,
    formatMarker(payload),
  );
  if (args.labelMissing) {
    await bestEffort(async () => {
      await args.gh.addLabels(args.repoRef, args.issue, [CLAIM_LABEL]);
    });
  }

  const verified = await discoverClaim(
    args.gh,
    ...splitRepo(args.repoRef),
    args.issue,
    args.now,
  );
  if (
    verified.kind === 'held' &&
    verified.live.payload.sessionId === args.sessionId
  ) {
    return {
      status: 'ok',
      action: 'taken-over',
      claim: verified.live.payload,
      commentUrl: verified.live.commentUrl,
      displaced: args.incumbent,
    };
  }
  // Lost the takeover race — delete our own comment, refuse.
  const ourCommentId = extractCommentIdFromUrl(posted.url);
  if (ourCommentId > 0) {
    await bestEffort(async () => {
      await args.gh.deleteIssueComment(args.repoRef, ourCommentId);
    });
  }
  if (verified.kind === 'held') {
    return buildRefusal(
      verified.live.payload,
      verified.live.commentUrl,
      args.scopeStr,
    );
  }
  return buildRefusal(payload, posted.url, args.scopeStr);
}

function buildPayload(
  sessionId: string,
  ledger: string,
  scope: string,
  heldSince: Date,
  heartbeatAt: Date,
): ClaimPayload {
  return {
    version: 1,
    sessionId,
    heldSince: heldSince.toISOString(),
    heartbeatAt: heartbeatAt.toISOString(),
    ledger,
    scope,
  };
}

function buildRefusal(
  holder: ClaimPayload,
  commentUrl: string,
  scopeStr: string,
): RefusalPayload {
  return {
    status: 'error',
    class: 'claim-conflict',
    detail:
      `scope ${scopeStr} is already claimed by session ${holder.sessionId}` +
      ` (heartbeat ${holder.heartbeatAt}, ledger ${holder.ledger})`,
    hint:
      'retry with takeover: true, run /cockpit:auto ... --takeover, or accept the auto skill gate',
    holder,
    commentUrl,
  };
}

function extractCommentIdFromUrl(url: string): number {
  const match = /#issuecomment-(\d+)$/.exec(url);
  if (match === null) return 0;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function splitRepo(repoRef: string): [string, string] {
  const [owner, repo] = repoRef.split('/', 2);
  return [owner ?? '', repo ?? ''];
}

async function bestEffort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // swallow — best-effort per R-10
  }
}
