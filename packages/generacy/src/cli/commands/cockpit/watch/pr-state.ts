import type { GhWrapper, Issue, PullRequestSummary } from '@generacy-ai/cockpit';
import type { PrLifecycle, PrSnapshot, Snapshot } from './snapshot.js';

export interface DerivePrLifecycleDeps {
  getPullRequest: GhWrapper['getPullRequest'];
}

/**
 * Derive the lifecycle of a PR (`open` | `closed` | `merged`).
 *
 * Plan D5: avoid an extra `gh pr view` call per cycle for stable PRs. Only call
 * `getPullRequest` when:
 *   - the previous snapshot was OPEN (or absent) AND the current issue state is
 *     CLOSED — i.e. the PR just flipped to closed and we don't yet know if it
 *     was merged.
 * Otherwise reuse the prior lifecycle (or default 'open' if no prev).
 */
export async function derivePrLifecycle(
  repo: string,
  prev: Snapshot | undefined,
  issue: Pick<Issue, 'number' | 'state'>,
  deps: DerivePrLifecycleDeps,
): Promise<PrLifecycle> {
  const wasMerged = prev != null && prev.kind === 'pr' && prev.lifecycle === 'merged';
  const wasClosed = prev != null && prev.kind === 'pr' && prev.lifecycle === 'closed';
  if (issue.state === 'OPEN') return 'open';
  if (wasMerged) return 'merged';
  if (wasClosed) return 'closed';
  // Issue state flipped to CLOSED — disambiguate via getPullRequest.
  let summary: PullRequestSummary;
  try {
    summary = await deps.getPullRequest(repo, issue.number);
  } catch {
    return 'closed';
  }
  if (summary.state === 'MERGED' || (summary.mergedAt != null && summary.mergedAt.length > 0)) {
    return 'merged';
  }
  return 'closed';
}
