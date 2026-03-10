/**
 * GitHub access validation for `generacy init`.
 *
 * Discovers a GitHub token from the environment or `gh` CLI, then
 * validates that the token has access to the specified repositories.
 * All validation is advisory — warnings are printed but never abort
 * the init flow.
 */
import * as p from '@clack/prompts';
import { getLogger } from '../../utils/logger.js';
import { execSafe } from '../../utils/exec.js';
import type { InitOptions, RepoAccessResult } from './types.js';

// ---------------------------------------------------------------------------
// Token discovery
// ---------------------------------------------------------------------------

/**
 * Discover a GitHub token from available sources.
 *
 * Priority:
 *   1. `GITHUB_TOKEN` environment variable
 *   2. `gh auth token` CLI command (GitHub CLI)
 *
 * @returns The token string, or `null` if no credentials are found.
 */
export function discoverGitHubToken(): string | null {
  const logger = getLogger();

  // 1. Check GITHUB_TOKEN env var
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken && envToken.trim()) {
    logger.debug('GitHub token discovered from GITHUB_TOKEN env var');
    return envToken.trim();
  }

  // 2. Fallback: gh auth token
  const result = execSafe('gh auth token');
  if (result.ok && result.stdout) {
    logger.debug('GitHub token discovered from gh auth token');
    return result.stdout;
  }

  logger.debug('No GitHub token found');
  return null;
}

// ---------------------------------------------------------------------------
// Repo access validation
// ---------------------------------------------------------------------------

/** Shape of the GitHub repos API response (only the fields we need). */
interface GitHubRepoResponse {
  permissions?: {
    push?: boolean;
  };
}

/**
 * Validate GitHub API access for a list of repositories.
 *
 * For each repo (`owner/repo`), issues a GET request to the GitHub API
 * and checks response status and permissions.
 *
 * @param repos - Array of repositories in `owner/repo` format.
 * @param token - GitHub API token for authorization.
 * @returns Array of access results, one per repo.
 */
export async function validateRepoAccess(
  repos: string[],
  token: string,
): Promise<RepoAccessResult[]> {
  const logger = getLogger();
  const results: RepoAccessResult[] = [];

  for (const repo of repos) {
    try {
      logger.debug({ repo }, 'Checking GitHub repo access');

      const response = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'generacy-cli',
        },
      });

      if (response.status === 200) {
        const data = (await response.json()) as GitHubRepoResponse;
        const writable = data.permissions?.push === true;
        results.push({ repo, accessible: true, writable });
        logger.debug({ repo, writable }, 'Repo accessible');
      } else if (response.status === 404) {
        results.push({
          repo,
          accessible: false,
          writable: false,
          error: 'Repository not found or no access',
        });
        logger.debug({ repo }, 'Repo not found (404)');
      } else if (response.status === 401 || response.status === 403) {
        results.push({
          repo,
          accessible: false,
          writable: false,
          error: `Bad credentials (HTTP ${response.status})`,
        });
        logger.debug({ repo, status: response.status }, 'Bad credentials');
      } else {
        results.push({
          repo,
          accessible: false,
          writable: false,
          error: `Unexpected response (HTTP ${response.status})`,
        });
        logger.debug({ repo, status: response.status }, 'Unexpected status');
      }
    } catch (err) {
      results.push({
        repo,
        accessible: false,
        writable: false,
        error: err instanceof Error ? err.message : 'Network error',
      });
      logger.debug({ repo, error: String(err) }, 'Repo access check failed');
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run GitHub access validation for all repos in the init options.
 *
 * This is an **advisory** check — warnings are printed for inaccessible
 * or read-only repos, but the init flow is never aborted.
 *
 * @param options - Resolved init options (uses repos and `skipGithubCheck`).
 */
export async function runGitHubValidation(options: InitOptions): Promise<void> {
  // Skip if explicitly requested
  if (options.skipGithubCheck) {
    return;
  }

  const logger = getLogger();

  // Discover token
  const token = discoverGitHubToken();
  if (!token) {
    p.log.warn(
      'GitHub validation skipped — no credentials found.\n' +
        '  Set GITHUB_TOKEN or run `gh auth login` to enable repo access checks.',
    );
    return;
  }

  // Collect all repos to validate
  const allRepos = [
    options.primaryRepo,
    ...options.devRepos,
    ...options.cloneRepos,
  ];

  if (allRepos.length === 0) {
    return;
  }

  // Validate with spinner feedback
  const s = p.spinner();
  s.start('Validating GitHub repository access');

  const results = await validateRepoAccess(allRepos, token);

  s.stop('GitHub validation complete');

  // Report results
  for (const result of results) {
    if (!result.accessible) {
      p.log.warn(
        `Repository "${result.repo}" is not accessible: ${result.error ?? 'unknown error'}`,
      );
    } else if (!result.writable) {
      p.log.warn(
        `Repository "${result.repo}" is read-only — Generacy requires write access to create branches and PRs.`,
      );
    } else {
      logger.debug({ repo: result.repo }, 'Repo access OK');
    }
  }
}
