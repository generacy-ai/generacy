import { Octokit } from '@octokit/rest';
import type { GitHubIssuesConfig } from './types/index.js';
import { validateConfig } from './utils/validation.js';
import {
  GitHubAuthError,
  GitHubRateLimitError,
  wrapGitHubError,
} from './utils/errors.js';

/**
 * GitHub API client wrapper with authentication and error handling
 */
export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly config: GitHubIssuesConfig;

  constructor(config: GitHubIssuesConfig) {
    this.config = validateConfig(config);

    this.octokit = new Octokit({
      auth: this.config.token,
      baseUrl: this.config.baseUrl,
    });
  }

  /**
   * Get the owner from config
   */
  get owner(): string {
    return this.config.owner;
  }

  /**
   * Get the repo from config
   */
  get repo(): string {
    return this.config.repo;
  }

  /**
   * Get the agent account from config
   */
  get agentAccount(): string | undefined {
    return this.config.agentAccount;
  }

  /**
   * Get trigger labels from config
   */
  get triggerLabels(): string[] {
    return this.config.triggerLabels ?? [];
  }

  /**
   * Get webhook secret from config
   */
  get webhookSecret(): string | undefined {
    return this.config.webhookSecret;
  }

  /**
   * Access to the underlying Octokit instance for advanced usage
   */
  get rest(): Octokit['rest'] {
    return this.octokit.rest;
  }

  /**
   * Verify authentication by fetching the authenticated user
   */
  async verifyAuth(): Promise<{ login: string; id: number }> {
    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      return { login: data.login, id: data.id };
    } catch (error) {
      throw new GitHubAuthError('Failed to verify authentication', error);
    }
  }

  /**
   * Check the current rate limit status
   */
  async getRateLimit(): Promise<{
    limit: number;
    remaining: number;
    reset: Date;
  }> {
    try {
      const { data } = await this.octokit.rest.rateLimit.get();
      return {
        limit: data.rate.limit,
        remaining: data.rate.remaining,
        reset: new Date(data.rate.reset * 1000),
      };
    } catch (error) {
      throw wrapGitHubError(error, 'Failed to get rate limit');
    }
  }

  /**
   * Execute a request with error handling
   */
  async request<T>(
    operation: () => Promise<T>,
    context?: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Check for rate limit error
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        (error as Record<string, unknown>).status === 429
      ) {
        const headers = (error as Record<string, unknown>).headers as Record<string, string> | undefined;
        const resetTimestamp = headers?.['x-ratelimit-reset'];
        const resetAt = resetTimestamp ? new Date(parseInt(resetTimestamp, 10) * 1000) : undefined;
        throw new GitHubRateLimitError(
          `Rate limit exceeded${context ? ` for ${context}` : ''}`,
          resetAt,
          error
        );
      }

      throw wrapGitHubError(error, context);
    }
  }

  /**
   * Paginate through all results
   */
  async paginate<T>(
    method: (params: { per_page: number; page: number }) => Promise<{ data: T[] }>,
    maxPages = 10
  ): Promise<T[]> {
    const results: T[] = [];
    let page = 1;

    while (page <= maxPages) {
      const response = await method({ per_page: 100, page });
      results.push(...response.data);

      if (response.data.length < 100) {
        break;
      }
      page++;
    }

    return results;
  }
}

/**
 * Create a new GitHub client instance
 */
export function createClient(config: GitHubIssuesConfig): GitHubClient {
  return new GitHubClient(config);
}
