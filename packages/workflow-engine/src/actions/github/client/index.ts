/**
 * GitHub client exports.
 * Provides the GitHubClient interface and implementations.
 */
export type {
  GitHubClient,
  GitHubClientFactory,
  IssueUpdate,
  PRCreate,
  PRUpdate,
  MergeResult,
  CommitResult,
  PushResult,
  GitStatus,
  LabelDefinition,
} from './interface.js';

export { GhCliGitHubClient } from './gh-cli.js';

// Default factory using gh CLI
import { GhCliGitHubClient } from './gh-cli.js';
import type { GitHubClient } from './interface.js';

/**
 * Create a GitHub client using the default implementation (gh CLI)
 */
export function createGitHubClient(
  workdir?: string,
  tokenProvider?: () => Promise<string | undefined>,
): GitHubClient {
  return new GhCliGitHubClient(workdir, tokenProvider);
}
