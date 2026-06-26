/**
 * `IssueRef` parser. Accepts:
 *   - "123"                                           (bare number — requires exactly one configured repo per AD-5)
 *   - "owner/repo#123"
 *   - "https://github.com/owner/repo/issues/123"
 *   - "https://github.com/owner/repo/pull/123"        (PRs are issues on GitHub)
 *
 * Errors are thrown with the contract shape `parse issue: <reason>` so the
 * calling verb can prefix `Error: cockpit <verb>: ` per cli-surface.md.
 *
 * Single field of truth: `nwo = ${owner}/${repo}`.
 */
import type { CockpitConfig } from '@generacy-ai/cockpit';

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

export interface ParseIssueRefOptions {
  /**
   * Configured repos (from `loadCockpitConfig`) — used to resolve bare-number
   * input. Per AD-5, bare number is only allowed when exactly one repo is configured.
   */
  config: Pick<CockpitConfig, 'repos'>;
}

export function parseIssueRef(input: string, options: ParseIssueRefOptions): IssueRef {
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
    const n = Number.parseInt(trimmed, 10);
    const repos = options.config.repos;
    if (repos.length !== 1) {
      fail(
        `Cannot resolve issue #${n}: ${repos.length} monitored repos configured. ` +
          `Use <owner>/<repo>#${n} or the full URL.`,
      );
    }
    const [owner, repo] = repos[0]!.split('/');
    return makeRef(owner!, repo!, n);
  }

  fail(
    `unrecognized issue ref "${input}". ` +
      `Use <number>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.`,
  );
}
