/**
 * `IssueRef` parser. Accepts:
 *   - "owner/repo#123"
 *   - "https://github.com/owner/repo/issues/123"
 *   - "https://github.com/owner/repo/pull/123"        (PRs are issues on GitHub)
 *
 * Bare-number shorthand ("123") is intentionally not accepted: the cockpit no
 * longer configures a monitored-repo list (repos derive from the epic body), so
 * a bare number is ambiguous across repos. Callers must pass a repo-qualified
 * ref or a full URL.
 *
 * Errors are thrown with the contract shape `parse issue: <reason>` so the
 * calling verb can prefix `Error: cockpit <verb>: ` per cli-surface.md.
 *
 * Single field of truth: `nwo = ${owner}/${repo}`.
 */

export interface IssueRef {
  /** GitHub owner login (e.g. "generacy-ai") */
  owner: string;
  /** GitHub repo name (e.g. "generacy") */
  repo: string;
  /** GitHub issue/PR number */
  number: number;
  /** "owner/repo" — convenience for gh CLI calls */
  nwo: string;
}

const OWNER_REPO_HASH = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;
const ISSUE_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/;
const BARE_NUMBER = /^\d+$/;

function fail(reason: string): never {
  throw new Error(`parse issue: ${reason}`);
}

function makeRef(owner: string, repo: string, number: number): IssueRef {
  if (!owner || owner.includes('/') || /\s/.test(owner)) {
    fail(`invalid owner "${owner}"`);
  }
  if (!repo || repo.includes('/') || /\s/.test(repo)) {
    fail(`invalid repo "${repo}"`);
  }
  if (!Number.isInteger(number) || number <= 0) {
    fail(`issue number must be a positive integer, got "${number}"`);
  }
  return { owner, repo, number, nwo: `${owner}/${repo}` };
}

export function parseIssueRef(input: string): IssueRef {
  const trimmed = input.trim();
  if (trimmed === '') {
    fail('issue argument is required');
  }

  const ownerRepoHash = OWNER_REPO_HASH.exec(trimmed);
  if (ownerRepoHash) {
    const [, owner, repo, num] = ownerRepoHash;
    return makeRef(owner!, repo!, Number.parseInt(num!, 10));
  }

  const url = ISSUE_URL.exec(trimmed);
  if (url) {
    const [, owner, repo, num] = url;
    return makeRef(owner!, repo!, Number.parseInt(num!, 10));
  }

  if (BARE_NUMBER.test(trimmed)) {
    fail(
      `bare issue number "${trimmed}" is not accepted — repos are not configured, ` +
        `so a bare number is ambiguous. Use <owner>/<repo>#${trimmed} or the full URL.`,
    );
  }

  fail(
    `unrecognized issue ref "${input}". ` +
      `Use <owner>/<repo>#<n> or https://github.com/<owner>/<repo>/issues/<n>.`,
  );
}
