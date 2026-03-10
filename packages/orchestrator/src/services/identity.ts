import { execFile } from 'node:child_process';

/**
 * Minimal issue shape for assignee filtering.
 * Compatible with the `Issue` type from @generacy-ai/workflow-engine.
 */
export interface FilterableIssue {
  number: number;
  assignees: string[];
}

/**
 * Minimal logger interface for identity resolution.
 * Uses optional `debug` since some service loggers (e.g., LabelMonitorService)
 * don't expose it.
 */
interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Resolve the cluster's GitHub identity for assignee-based issue filtering.
 *
 * Resolution order:
 *   1. `configUsername` (from CLUSTER_GITHUB_USERNAME env var via config)
 *   2. `gh api /user` fallback (auto-detection from gh auth)
 *   3. `undefined` (filtering disabled, all issues processed)
 *
 * Called once at startup; result is cached for the cluster's lifetime.
 */
export async function resolveClusterIdentity(
  configUsername: string | undefined,
  logger: Logger,
): Promise<string | undefined> {
  // 1. Explicit config (env var)
  if (configUsername) {
    logger.info(
      { username: configUsername, source: 'config' },
      `Cluster identity resolved: ${configUsername} (from CLUSTER_GITHUB_USERNAME)`,
    );
    return configUsername;
  }

  // 2. Fallback: gh api /user
  try {
    const login = await ghApiUser();
    logger.info(
      { username: login, source: 'gh-api' },
      `Cluster identity resolved: ${login} (from gh api /user)`,
    );
    return login;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('ENOENT') || message.includes('not found')) {
      logger.warn(
        { error: message },
        'gh CLI not found — set CLUSTER_GITHUB_USERNAME to enable assignee filtering',
      );
    } else if (message.includes('auth') || message.includes('401') || message.includes('login')) {
      logger.warn(
        { error: message },
        'gh CLI not authenticated — run "gh auth login" or set CLUSTER_GITHUB_USERNAME',
      );
    } else if (message.includes('timeout') || message.includes('TIMEOUT')) {
      logger.warn(
        { error: message },
        'gh api /user timed out — set CLUSTER_GITHUB_USERNAME to avoid this delay',
      );
    } else {
      logger.warn(
        { error: message },
        'Failed to resolve cluster identity via gh api /user — set CLUSTER_GITHUB_USERNAME to enable assignee filtering',
      );
    }
  }

  // 3. Both failed — filtering disabled
  logger.warn('Assignee filtering disabled: no cluster identity configured. All issues will be processed.');
  return undefined;
}

/**
 * Call `gh api /user` with a 10s timeout and return the login field.
 */
function ghApiUser(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      ['api', '/user', '--jq', '.login'],
      { timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        const login = stdout.trim();
        if (!login) {
          reject(new Error('gh api /user returned empty login'));
          return;
        }
        resolve(login);
      },
    );

    // Handle spawn errors (ENOENT when gh is not installed)
    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Filter issues to only those assigned to the cluster's GitHub username.
 *
 * When `clusterGithubUsername` is `undefined`, returns all issues (no filtering).
 * When filtering is active, unassigned issues are skipped with a warning.
 * Issues assigned to multiple users trigger a warning but are still processed.
 */
export function filterByAssignee<T extends FilterableIssue>(
  issues: T[],
  clusterGithubUsername: string | undefined,
  logger: Logger,
): T[] {
  if (!clusterGithubUsername) return issues;

  return issues.filter(issue => {
    if (issue.assignees.length === 0) {
      logger.warn(
        { issueNumber: issue.number },
        'Skipping issue: no assignees set (assign before labeling)',
      );
      return false;
    }

    const assigned = issue.assignees.includes(clusterGithubUsername);

    if (assigned && issue.assignees.length > 1) {
      logger.warn(
        { issueNumber: issue.number, assignees: issue.assignees },
        'Issue has multiple assignees — may be processed by multiple clusters',
      );
    }

    if (!assigned) {
      logger.debug?.(
        { issueNumber: issue.number, assignees: issue.assignees, clusterUsername: clusterGithubUsername },
        'Skipping issue: not assigned to this cluster',
      );
    }

    return assigned;
  });
}
