/**
 * Discover the current active-driver claim on a scope issue (#1015).
 *
 * Single-pass algorithm (R-9):
 *  1. Fetch labels + comments (via existing wrapper methods).
 *  2. Filter comments matching the `<!-- cockpit:claim v1 -->` prefix.
 *  3. Compute live payloads = markers whose `heartbeatAt` is within the last
 *     10 minutes (R-3 absolute threshold).
 *  4. Zero live → `no-claim`. Best-effort delete stale markers; best-effort
 *     remove orphaned `cockpit:claimed` label.
 *  5. One live → `held`.
 *  6. Multi-live race → oldest `heldSince` wins; best-effort delete younger.
 *
 * All best-effort operations swallow errors — discovery is read-first; a
 * failed cleanup does not fail the caller.
 */
import type { GhWrapper, IssueComment } from '@generacy-ai/cockpit';
import type { ClaimPayload, DiscoverResult, LiveClaim } from './payload.js';
import { parseMarker, MARKER_PREFIX } from './marker.js';

export const CLAIM_LABEL = 'cockpit:claimed';
export const STALE_THRESHOLD_MS = 10 * 60 * 1000;

interface MarkerCandidate {
  comment: IssueComment;
  payload: ClaimPayload;
}

export async function discoverClaim(
  gh: GhWrapper,
  owner: string,
  repo: string,
  issue: number,
  now: Date,
): Promise<DiscoverResult> {
  const repoRef = `${owner}/${repo}`;
  const [labelsResult, comments] = await Promise.all([
    gh.fetchIssueLabels(repoRef, issue),
    gh.fetchIssueComments(repoRef, issue),
  ]);
  const hasLabel = labelsResult.labels.includes(CLAIM_LABEL);

  const parsedCandidates: MarkerCandidate[] = [];
  const malformedMarkerCandidates: IssueComment[] = [];
  for (const comment of comments) {
    const body = comment.body ?? '';
    if (!body.startsWith(MARKER_PREFIX)) continue;
    const payload = parseMarker(body);
    if (payload === null) {
      malformedMarkerCandidates.push(comment);
      continue;
    }
    parsedCandidates.push({ comment, payload });
  }

  const nowMs = now.getTime();
  const live: MarkerCandidate[] = [];
  const stale: MarkerCandidate[] = [];
  for (const cand of parsedCandidates) {
    const beatMs = Date.parse(cand.payload.heartbeatAt);
    if (Number.isNaN(beatMs)) {
      stale.push(cand);
      continue;
    }
    if (nowMs - beatMs <= STALE_THRESHOLD_MS) {
      live.push(cand);
    } else {
      stale.push(cand);
    }
  }

  if (live.length === 0) {
    for (const cand of stale) {
      await bestEffortDelete(gh, repoRef, cand.comment.id);
    }
    for (const cand of malformedMarkerCandidates) {
      await bestEffortDelete(gh, repoRef, cand.id);
    }
    if (hasLabel) {
      await bestEffortRemoveLabel(gh, repoRef, issue);
    }
    return { kind: 'no-claim' };
  }

  live.sort((a, b) => a.payload.heldSince.localeCompare(b.payload.heldSince));
  const winner = live[0]!;
  const losers = live.slice(1);
  for (const loser of losers) {
    await bestEffortDelete(gh, repoRef, loser.comment.id);
  }
  for (const cand of stale) {
    await bestEffortDelete(gh, repoRef, cand.comment.id);
  }
  for (const cand of malformedMarkerCandidates) {
    await bestEffortDelete(gh, repoRef, cand.id);
  }

  const liveClaim: LiveClaim = {
    payload: winner.payload,
    commentId: winner.comment.id,
    commentUrl: winner.comment.url,
  };
  return { kind: 'held', live: liveClaim, orphanedLabelPresent: !hasLabel };
}

async function bestEffortDelete(
  gh: GhWrapper,
  repo: string,
  commentId: number,
): Promise<void> {
  if (commentId <= 0) return;
  try {
    await gh.deleteIssueComment(repo, commentId);
  } catch {
    // swallow — discovery is read-first
  }
}

async function bestEffortRemoveLabel(
  gh: GhWrapper,
  repo: string,
  issue: number,
): Promise<void> {
  try {
    await gh.removeLabels(repo, issue, [CLAIM_LABEL]);
  } catch {
    // swallow — orphaned-label tolerance (FR-003)
  }
}
