import type { GhWrapper, Issue, ListIssuesOptions } from '@generacy-ai/cockpit';

export interface ListAllIssuesOptions {
  pageSize?: number;
  safetyCap?: number;
  repo?: string;
  logger?: { warn: (msg: string) => void };
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SAFETY_CAP = 1000;

/**
 * Loop `gh.listIssues` until a page returns fewer items than requested.
 * Advances via a `created:<ISO` predicate cursor (R4).
 * Emits a single stderr warning per call when the cumulative result exceeds
 * `safetyCap`; never truncates.
 */
export async function listAllIssues(
  gh: GhWrapper,
  query: string,
  opts: ListAllIssuesOptions = {},
): Promise<Issue[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const safetyCap = opts.safetyCap ?? DEFAULT_SAFETY_CAP;
  const logger = opts.logger;
  const out: Issue[] = [];
  const seen = new Set<number>();
  let cursorQuery = query;
  let warned = false;

  for (;;) {
    const listOpts: ListIssuesOptions = { limit: pageSize };
    if (opts.repo != null) listOpts.repo = opts.repo;
    const page = await gh.listIssues(cursorQuery, listOpts);
    let newCount = 0;
    let minCreated: string | undefined;
    for (const issue of page) {
      if (seen.has(issue.number)) continue;
      seen.add(issue.number);
      out.push(issue);
      newCount += 1;
      if (issue.createdAt != null && issue.createdAt.length > 0) {
        if (minCreated == null || issue.createdAt < minCreated) {
          minCreated = issue.createdAt;
        }
      }
    }
    if (!warned && out.length > safetyCap && logger != null) {
      logger.warn(
        `cockpit: poll cycle exceeded ${safetyCap} items; consider narrower epic scoping`,
      );
      warned = true;
    }
    if (page.length < pageSize) break;
    if (newCount === 0) break;
    if (minCreated == null) break;
    cursorQuery = `${query} created:<${minCreated}`;
  }

  return out;
}
