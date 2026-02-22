/**
 * Shared utility for finding child issues of an epic.
 *
 * Searches for issues whose body contains `epic-parent: #N` using `gh issue list --search`.
 * Optionally checks whether each child has a merged PR.
 *
 * Used by:
 * - `epic.check_completion` action (workflow-engine)
 * - `EpicCompletionMonitorService` (orchestrator)
 */
import { executeCommand } from '../cli-utils.js';
import type { EpicChild } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Extended child type with optional PR number (for callers that need it)
// ---------------------------------------------------------------------------

export interface EpicChildWithPr extends EpicChild {
  pr_number: number | null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FindChildIssuesOptions {
  /** Issue state filter. Defaults to 'all'. */
  state?: 'open' | 'closed' | 'all';
  /** Whether to check merged-PR status for each child. Defaults to true. */
  includePrStatus?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find child issues that reference the given epic via `epic-parent: #N` in
 * their body. Uses the GitHub search API via `gh issue list --search`.
 */
export async function findChildIssues(
  owner: string,
  repo: string,
  epicNumber: number,
  options: FindChildIssuesOptions = {},
): Promise<EpicChildWithPr[]> {
  const { state = 'all', includePrStatus = true } = options;

  const args = [
    'issue', 'list',
    '-R', `${owner}/${repo}`,
    '--search', `"epic-parent: ${epicNumber}" in:body`,
    '--json', 'number,title,state,labels',
    '--limit', '100',
  ];

  if (state !== 'open') {
    // gh defaults to open; add --state for 'all' or 'closed'
    args.push('--state', state);
  }

  const result = await executeCommand('gh', args);

  if (result.exitCode !== 0) {
    return [];
  }

  let issues: Array<{
    number: number;
    title: string;
    state: string;
    labels: Array<{ name: string }>;
  }>;

  try {
    issues = JSON.parse(result.stdout);
  } catch {
    return [];
  }

  const children: EpicChildWithPr[] = [];

  for (const issue of issues) {
    let prMerged = false;
    let prNumber: number | null = null;

    if (includePrStatus) {
      const prStatus = await checkPrMerged(owner, repo, issue.number);
      prMerged = prStatus.merged;
      prNumber = prStatus.prNumber;
    }

    children.push({
      issue_number: issue.number,
      title: issue.title,
      state: issue.state.toLowerCase() as 'open' | 'closed',
      pr_merged: prMerged,
      pr_number: prNumber,
      labels: issue.labels.map(l => l.name),
    });
  }

  return children;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a merged PR exists that closes the given issue.
 */
async function checkPrMerged(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ merged: boolean; prNumber: number | null }> {
  const result = await executeCommand('gh', [
    'pr', 'list',
    '-R', `${owner}/${repo}`,
    '--search', `closes:#${issueNumber}`,
    '--state', 'merged',
    '--json', 'number',
    '--limit', '1',
  ]);

  if (result.exitCode !== 0 || result.stdout.trim() === '[]') {
    return { merged: false, prNumber: null };
  }

  try {
    const prs = JSON.parse(result.stdout) as Array<{ number: number }>;
    if (prs.length > 0 && prs[0]) {
      return { merged: true, prNumber: prs[0].number };
    }
  } catch {
    // Fall through
  }

  return { merged: false, prNumber: null };
}
