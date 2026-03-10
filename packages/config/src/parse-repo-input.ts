/**
 * Multi-format repo input parser.
 *
 * Supports:
 *   - Bare name:            `generacy`
 *   - owner/repo:           `generacy-ai/generacy`
 *   - github.com URL path:  `github.com/generacy-ai/generacy`
 *   - HTTPS URL:            `https://github.com/generacy-ai/generacy.git`
 *   - SSH URL:              `git@github.com:generacy-ai/generacy.git`
 */

/** Matches `git@github.com:owner/repo.git` (SSH) */
const SSH_RE = /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/;

/** Matches `https://github.com/owner/repo` or `github.com/owner/repo` (with optional .git) */
const HTTPS_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/;

/** Matches `owner/repo` (no slashes beyond the single separator) */
const OWNER_REPO_RE = /^([^/]+)\/([^/]+)$/;

/** Matches a bare repo name — no slashes, no colons, no protocol */
const BARE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

/**
 * Parse a single repo input string into `{ owner, repo }`.
 *
 * @param input     Raw input in any supported format
 * @param defaultOrg  Org to use when input is a bare repo name (required for bare names)
 * @returns `{ owner: string, repo: string }`
 * @throws if input is empty, unrecognized, or a bare name without `defaultOrg`
 */
export function parseRepoInput(
  input: string,
  defaultOrg?: string,
): { owner: string; repo: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Repo input must not be empty');
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(SSH_RE);
  if (sshMatch) {
    return { owner: sshMatch[1]!, repo: sshMatch[2]! };
  }

  // HTTPS or github.com path: https://github.com/owner/repo.git
  const httpsMatch = trimmed.match(HTTPS_RE);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }

  // owner/repo (after stripping optional .git suffix)
  const cleaned = trimmed.replace(/\.git$/, '');
  const ownerRepoMatch = cleaned.match(OWNER_REPO_RE);
  if (ownerRepoMatch) {
    return { owner: ownerRepoMatch[1]!, repo: ownerRepoMatch[2]! };
  }

  // Bare repo name
  if (BARE_NAME_RE.test(cleaned)) {
    if (!defaultOrg) {
      throw new Error(
        `Bare repo name "${cleaned}" requires a defaultOrg parameter`,
      );
    }
    return { owner: defaultOrg, repo: cleaned };
  }

  throw new Error(`Unrecognized repo input format: "${trimmed}"`);
}

/**
 * Parse a comma-separated list of repo inputs.
 *
 * @param csv         Comma-separated repo strings
 * @param defaultOrg  Org to use for bare repo names
 * @returns Array of `{ owner, repo }`
 */
export function parseRepoList(
  csv: string,
  defaultOrg?: string,
): { owner: string; repo: string }[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseRepoInput(s, defaultOrg));
}
