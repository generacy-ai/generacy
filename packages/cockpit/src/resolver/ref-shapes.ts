import type { IssueRef } from './types.js';

const OWNER_REPO = '[A-Za-z0-9._-]+/[A-Za-z0-9._-]+';

const BARE_RE = new RegExp(`^(${OWNER_REPO})#(\\d+)$`);
const MD_LINK_BARE_RE = new RegExp(`^\\[(${OWNER_REPO})#(\\d+)\\]\\([^)]*\\)$`);
const MD_LINK_HASH_RE = new RegExp(
  `^\\[#(\\d+)\\]\\(https://github\\.com/(${OWNER_REPO})/(?:issues|pull)/(\\d+)(?:[?#][^)]*)?\\)$`,
);
const PLAIN_URL_RE = new RegExp(
  `^https://github\\.com/(${OWNER_REPO})/(?:issues|pull)/(\\d+)(?:[?#].*)?$`,
);

function toRef(repo: string, numberStr: string): IssueRef | null {
  const n = Number.parseInt(numberStr, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { repo, number: n };
}

/**
 * Recognise a task-list ref token from an epic body.
 *
 * Accepted shapes (all normalise to `IssueRef`):
 *   1. Bare: `owner/repo#N`
 *   2. Markdown link with bare label: `[owner/repo#N](anything)`
 *   3. Markdown link with `#N` label: `[#N](https://github.com/owner/repo/(issues|pull)/N)`
 *   4. Plain URL: `https://github.com/owner/repo/(issues|pull)/N`
 *
 * Rejected (returns `null` — caller records FR-003 warning):
 *   - Bare `#N` shorthand
 *   - Non-integer / non-positive N
 *   - URLs whose path doesn't match `/(issues|pull)/N`
 */
export function parseRef(line: string): IssueRef | null {
  const trimmed = line.trim();

  const bare = BARE_RE.exec(trimmed);
  if (bare != null) return toRef(bare[1]!, bare[2]!);

  const mdBare = MD_LINK_BARE_RE.exec(trimmed);
  if (mdBare != null) return toRef(mdBare[1]!, mdBare[2]!);

  const mdHash = MD_LINK_HASH_RE.exec(trimmed);
  if (mdHash != null) {
    const labelN = mdHash[1]!;
    const repo = mdHash[2]!;
    const urlN = mdHash[3]!;
    if (labelN !== urlN) return null;
    return toRef(repo, urlN);
  }

  const url = PLAIN_URL_RE.exec(trimmed);
  if (url != null) return toRef(url[1]!, url[2]!);

  return null;
}
