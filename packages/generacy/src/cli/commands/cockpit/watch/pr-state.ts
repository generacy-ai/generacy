import type { GhWrapper, Issue, PullRequestSummary } from '@generacy-ai/cockpit';
import type { PrLifecycle, PrSnapshot, Snapshot } from './snapshot.js';

export type PrChecksNeededReason =
  | 'no-prev'
  | 'lifecycle-flip'
  | 'head-changed'
  | 'label-changed'
  | 'safety-cycle'
  | 'not-terminal'
  | 'skip-terminal';

export interface PrChecksNeededDecision {
  fetch: boolean;
  reason: PrChecksNeededReason;
}

export interface DerivePrChecksNeededInput {
  prevSnapshot: PrSnapshot | undefined;
  currentLifecycle: PrLifecycle;
  currentLabels: string[];
  currentHeadRefOid: string | undefined;
  cyclesSinceLastCheckFetch: number;
  safetyCycles?: number;
}

const DEFAULT_SAFETY_CYCLES = 20;

function labelSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const x of b) if (!set.has(x)) return false;
  return true;
}

export function derivePrChecksNeeded(
  input: DerivePrChecksNeededInput,
): PrChecksNeededDecision {
  const {
    prevSnapshot,
    currentLifecycle,
    currentLabels,
    currentHeadRefOid,
    cyclesSinceLastCheckFetch,
  } = input;
  const safetyCycles = input.safetyCycles ?? DEFAULT_SAFETY_CYCLES;

  if (prevSnapshot == null) {
    return { fetch: true, reason: 'no-prev' };
  }
  if (currentLifecycle === 'merged' || currentLifecycle === 'closed') {
    return { fetch: false, reason: 'skip-terminal' };
  }
  if (prevSnapshot.lifecycle !== 'open' && currentLifecycle === 'open') {
    return { fetch: true, reason: 'lifecycle-flip' };
  }
  if (prevSnapshot.checksRollup !== 'success') {
    return { fetch: true, reason: 'not-terminal' };
  }
  if (
    currentHeadRefOid != null &&
    prevSnapshot.headRefOid != null &&
    currentHeadRefOid !== prevSnapshot.headRefOid
  ) {
    return { fetch: true, reason: 'head-changed' };
  }
  if (!labelSetsEqual(prevSnapshot.labels, currentLabels)) {
    return { fetch: true, reason: 'label-changed' };
  }
  if (cyclesSinceLastCheckFetch >= safetyCycles) {
    return { fetch: true, reason: 'safety-cycle' };
  }
  return { fetch: false, reason: 'skip-terminal' };
}

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
