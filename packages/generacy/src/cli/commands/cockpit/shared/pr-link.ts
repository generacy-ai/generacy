import type { Issue } from '@generacy-ai/cockpit';

const PR_URL_RE = /https?:\/\/github\.com\/[^\s)\]]+\/pull\/\d+/;

/**
 * Extract the first linked PR URL from an issue's body. Used by `status`'s row
 * builder when `kind === 'issue'` and a `resolveIssueToPR` round-trip is not
 * wanted (or has already returned null).
 */
export function extractPrUrl(issue: Pick<Issue, 'body' | 'url'>): string | null {
  if (issue.url != null && /\/pull\/\d+/.test(issue.url)) {
    return issue.url;
  }
  const body = issue.body ?? '';
  const m = body.match(PR_URL_RE);
  return m != null ? m[0] : null;
}
