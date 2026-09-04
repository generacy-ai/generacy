import type { Issue, IssueRef } from '@generacy-ai/cockpit';

/**
 * Drop any fetched issue/PR whose `repo#number` is not in the resolved ref set.
 *
 * Defence-in-depth behind the exact `batchLookupIssuesOrPrs` lookup: the query
 * structurally cannot free-text match, but a misbehaving backend (or the
 * free-text `status` search) could still surface foreign refs. Pure — no API
 * calls. Membership key mirrors `snapshotKey`'s #1106 lowercase-repo
 * normalization so casing never leaks a foreign ref through.
 */
export function filterToRefSet(
  issues: Issue[],
  repo: string,
  refs: IssueRef[],
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void },
): Issue[] {
  const allowed = new Set(
    refs.map((ref) => `${ref.repo.toLowerCase()}#${ref.number}`),
  );
  return issues.filter((issue) => {
    const key = `${repo.toLowerCase()}#${issue.number}`;
    if (allowed.has(key)) return true;
    logger?.debug?.(
      `ref-set-filter: dropped out-of-scope ${repo}#${issue.number}`,
    );
    return false;
  });
}
