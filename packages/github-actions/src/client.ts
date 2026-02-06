import { Octokit } from '@octokit/rest';
import type { GitHubActionsConfig } from './types/config.js';
import { RateLimitError, ConfigurationError } from './utils/errors.js';

/**
 * GitHub API client wrapper for GitHub Actions operations
 */
export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  constructor(config: GitHubActionsConfig) {
    if (!config.owner || !config.repo || !config.token) {
      throw new ConfigurationError(
        'owner, repo, and token are required in configuration'
      );
    }

    this.owner = config.owner;
    this.repo = config.repo;
    this.octokit = new Octokit({
      auth: config.token,
      userAgent: '@generacy-ai/generacy-plugin-github-actions',
    });
  }

  /**
   * Get the repository owner
   */
  getOwner(): string {
    return this.owner;
  }

  /**
   * Get the repository name
   */
  getRepo(): string {
    return this.repo;
  }

  /**
   * Get the underlying Octokit instance
   */
  getOctokit(): Octokit {
    return this.octokit;
  }

  /**
   * Execute a GitHub API request with rate limit handling
   */
  async request<T>(
    fn: (octokit: Octokit) => Promise<{ data: T }>
  ): Promise<T> {
    try {
      const response = await fn(this.octokit);
      return response.data;
    } catch (error) {
      if (this.isRateLimitError(error)) {
        const resetAt = this.extractRateLimitReset(error);
        throw new RateLimitError(resetAt, error as Error);
      }
      throw error;
    }
  }

  /**
   * Execute a GitHub API request that returns raw data (like log downloads)
   */
  async requestRaw<T>(fn: (octokit: Octokit) => Promise<T>): Promise<T> {
    try {
      return await fn(this.octokit);
    } catch (error) {
      if (this.isRateLimitError(error)) {
        const resetAt = this.extractRateLimitReset(error);
        throw new RateLimitError(resetAt, error as Error);
      }
      throw error;
    }
  }

  /**
   * Check if an error is a rate limit error
   */
  private isRateLimitError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'status' in error) {
      const statusError = error as { status: number };
      return statusError.status === 403 || statusError.status === 429;
    }
    return false;
  }

  /**
   * Extract rate limit reset time from error headers
   */
  private extractRateLimitReset(error: unknown): Date {
    if (
      error &&
      typeof error === 'object' &&
      'response' in error &&
      error.response &&
      typeof error.response === 'object' &&
      'headers' in error.response
    ) {
      const headers = error.response.headers as Record<string, string>;
      const resetHeader = headers['x-ratelimit-reset'];
      if (resetHeader) {
        const resetTimestamp = parseInt(resetHeader, 10);
        if (!isNaN(resetTimestamp)) {
          return new Date(resetTimestamp * 1000);
        }
      }
    }
    // Default to 60 seconds from now if we can't determine the reset time
    return new Date(Date.now() + 60000);
  }
}

/**
 * Create a new GitHub client
 */
export function createClient(config: GitHubActionsConfig): GitHubClient {
  return new GitHubClient(config);
}
