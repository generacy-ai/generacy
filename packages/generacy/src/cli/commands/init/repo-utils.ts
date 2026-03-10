/**
 * Repo URL parsing, normalization, and auto-detection utilities.
 *
 * Handles all common GitHub repo URL formats:
 *   - owner/repo              (shorthand)
 *   - github.com/owner/repo   (no protocol)
 *   - https://github.com/owner/repo      (HTTPS)
 *   - https://github.com/owner/repo.git  (HTTPS with .git)
 *   - git@github.com:owner/repo.git      (SSH)
 */
import { execSafe } from '../../utils/exec.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedRepo {
  owner: string;
  repo: string;
}

export interface NormalizedRepo {
  /** `owner/repo` format — used by templates */
  shorthand: string;
  /** `github.com/owner/repo` format — used by config schema */
  configFormat: string;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** SSH format: git@github.com:owner/repo.git */
const SSH_RE = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/;

/** HTTPS format: https://github.com/owner/repo[.git] */
const HTTPS_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/;

/** Bare domain: github.com/owner/repo */
const BARE_DOMAIN_RE = /^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/;

/** Shorthand: owner/repo (no dots, no colons, no slashes beyond the one) */
const SHORTHAND_RE = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a repo URL in any supported format into `{ owner, repo }`.
 * Throws a descriptive error if the format is unrecognizable.
 */
export function parseRepoUrl(input: string): ParsedRepo {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Repository URL cannot be empty');
  }

  // Try SSH first (git@github.com:owner/repo.git)
  let match = SSH_RE.exec(trimmed);
  if (match) {
    return { owner: match[1]!, repo: match[2]! };
  }

  // Try HTTPS (https://github.com/owner/repo[.git])
  match = HTTPS_RE.exec(trimmed);
  if (match) {
    return { owner: match[1]!, repo: match[2]! };
  }

  // Try bare domain (github.com/owner/repo)
  match = BARE_DOMAIN_RE.exec(trimmed);
  if (match) {
    return { owner: match[1]!, repo: match[2]! };
  }

  // Try shorthand (owner/repo)
  match = SHORTHAND_RE.exec(trimmed);
  if (match) {
    return { owner: match[1]!, repo: match[2]! };
  }

  throw new Error(
    `Unrecognized repository format: "${trimmed}". ` +
      'Expected one of: owner/repo, github.com/owner/repo, ' +
      'https://github.com/owner/repo, or git@github.com:owner/repo.git',
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Returns `owner/repo` — the shorthand format used by templates. */
export function toShorthand(parsed: ParsedRepo): string {
  return `${parsed.owner}/${parsed.repo}`;
}

/** Returns `github.com/owner/repo` — the format used in config schema. */
export function toConfigFormat(parsed: ParsedRepo): string {
  return `github.com/${parsed.owner}/${parsed.repo}`;
}

// ---------------------------------------------------------------------------
// Combined normalize
// ---------------------------------------------------------------------------

/** Parse any supported repo URL and return both shorthand and config formats. */
export function normalizeRepoUrl(input: string): NormalizedRepo {
  const parsed = parseRepoUrl(input);
  return {
    shorthand: toShorthand(parsed),
    configFormat: toConfigFormat(parsed),
  };
}

// ---------------------------------------------------------------------------
// Git auto-detection
// ---------------------------------------------------------------------------

/**
 * Detect the primary repository from the `origin` remote.
 * Returns normalized `owner/repo` shorthand, or `null` if not detectable.
 */
export function detectPrimaryRepo(cwd: string): string | null {
  const result = execSafe('git remote get-url origin', { cwd });
  if (!result.ok || !result.stdout) {
    return null;
  }

  try {
    const parsed = parseRepoUrl(result.stdout);
    return toShorthand(parsed);
  } catch {
    return null;
  }
}

/**
 * Detect the git repository root directory.
 * Returns the absolute path, or `null` if not inside a git repo.
 */
export function detectGitRoot(cwd: string): string | null {
  const result = execSafe('git rev-parse --show-toplevel', { cwd });
  if (!result.ok || !result.stdout) {
    return null;
  }
  return result.stdout;
}
