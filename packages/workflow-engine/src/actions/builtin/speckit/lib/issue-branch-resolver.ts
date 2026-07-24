/**
 * Issue → canonical branch resolver.
 *
 * Given an issue number, returns the canonical `<N>-<slug>` branch for the
 * issue by querying remote state only: (1) open PRs on `<N>-*` branches,
 * (2) remote branches matching `<N>-*`. See #1043.
 *
 * Best-effort; never throws. Falls back to `null` so callers can use
 * their existing slug-derivation path.
 */
import type { SimpleGit } from 'simple-git';
import type { GitHubClient } from '../../../github/client/interface.js';
import type { Logger } from '../../../../types/logger.js';

/**
 * Result shape of {@link resolveIssueBranch}.
 * Discriminated on `source` for observability.
 */
export type ResolvedIssueBranch = {
  /** Canonical branch name for the issue — the head ref of the oldest open PR
   *  or, if no open PR exists, the oldest remote branch matching `<N>-*`. */
  branchName: string;

  /** Which lookup rule picked the branch. */
  source: 'oldest-open-pr' | 'oldest-remote-branch';

  /** For `oldest-open-pr`: the PR number that anchored the choice.
   *  For `oldest-remote-branch`: undefined. */
  anchoringPrNumber?: number;

  /** Number of candidate `<N>-*` branches considered. */
  candidateBranchCount: number;

  /** Number of candidate open PRs on `<N>-*` branches considered. */
  candidatePrCount: number;
};

export interface ResolveIssueBranchInput {
  issueNumber: number;
  owner: string;
  repo: string;
  github: GitHubClient;
  git: SimpleGit;
  logger?: Logger;
}

/**
 * Resolve the canonical branch for an issue.
 *
 * Two enumeration steps + PR-first tiebreak (per spec §Clarifications Q2-A):
 *
 * 1. Open PRs on `<N>-*` branches sorted by `created_at` ascending.
 * 2. Remote branches matching `<N>-*` sorted by commit timestamp ascending
 *    (final alphabetical tiebreak on branch name).
 * 3. Return the oldest PR's head branch if any PR candidates exist; else the
 *    oldest branch if any branch candidates exist; else `null`.
 *
 * Never throws. Enumeration failures are logged and treated as empty sets.
 */
export async function resolveIssueBranch(
  input: ResolveIssueBranchInput
): Promise<ResolvedIssueBranch | null> {
  const { issueNumber, owner, repo, github, git, logger } = input;

  const filter = new RegExp('^' + issueNumber + '-');

  // Step 1: open PRs on <N>-* branches, oldest by created_at.
  const candidatePrs: Array<{ number: number; branch: string; createdAt: string }> = [];
  let prListFailed = false;
  try {
    const prs = await github.listOpenPullRequests(owner, repo);
    for (const pr of prs) {
      if (filter.test(pr.head.ref)) {
        candidatePrs.push({
          number: pr.number,
          branch: pr.head.ref,
          createdAt: pr.created_at,
        });
      }
    }
    candidatePrs.sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0;
    });
  } catch (error) {
    prListFailed = true;
    logger?.warn('issue-branch-resolver-pr-list-failed', {
      event: 'issue-branch-resolver-pr-list-failed',
      issueNumber,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 2: remote branches matching <N>-*, oldest by commit timestamp.
  const candidateBranches: Array<{ name: string; timestamp: number }> = [];
  let branchListFailed = false;
  try {
    const branches = await github.listBranches(owner, repo);
    const matching = branches.filter((b) => filter.test(b));
    for (const name of matching) {
      let timestamp = Number.POSITIVE_INFINITY;
      try {
        const raw = await git.raw([
          'log',
          '-1',
          '--format=%ct',
          `refs/remotes/origin/${name}`,
        ]);
        const parsed = parseInt(raw.trim(), 10);
        if (Number.isFinite(parsed)) timestamp = parsed;
      } catch {
        // Leave timestamp as +Infinity so this branch sorts last.
      }
      candidateBranches.push({ name, timestamp });
    }
    candidateBranches.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  } catch (error) {
    branchListFailed = true;
    logger?.warn('issue-branch-resolver-branch-list-failed', {
      event: 'issue-branch-resolver-branch-list-failed',
      issueNumber,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const candidatePrCount = candidatePrs.length;
  const candidateBranchCount = candidateBranches.length;

  // Tiebreak: PR-first, branch-second, else null.
  if (candidatePrCount > 0) {
    const oldest = candidatePrs[0]!;
    return {
      branchName: oldest.branch,
      source: 'oldest-open-pr',
      anchoringPrNumber: oldest.number,
      candidateBranchCount,
      candidatePrCount,
    };
  }

  if (candidateBranchCount > 0) {
    const oldest = candidateBranches[0]!;
    return {
      branchName: oldest.name,
      source: 'oldest-remote-branch',
      candidateBranchCount,
      candidatePrCount,
    };
  }

  // Both empty — either genuinely no candidates, or both enumerations failed.
  void prListFailed;
  void branchListFailed;
  return null;
}
