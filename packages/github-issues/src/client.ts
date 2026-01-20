import { Octokit } from '@octokit/rest';
import type { GitHubIssuesConfig } from './types/index.js';
import type { AuthStrategy } from './auth/types.js';
import { validateConfig } from './utils/validation.js';
import { createAuthStrategy } from './auth/auth-factory.js';
import { readGitHubAppConfigFromEnv } from './auth/env.js';
import {
  GitHubAuthError,
  GitHubRateLimitError,
  wrapGitHubError,
} from './utils/errors.js';

/**
 * GitHub API client wrapper with authentication and error handling
 *
 * Supports both PAT and GitHub App authentication.
 */
export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly config: GitHubIssuesConfig;
  private authStrategy: AuthStrategy | null = null;
  private authType: 'pat' | 'github-app' | undefined;

  /**
   * Create a new GitHubClient
   *
   * For synchronous construction (backward compatible), use token-based auth.
   * For GitHub App auth, use the async createClient() function instead.
   */
  constructor(config: GitHubIssuesConfig) {
    this.config = validateConfig(config);

    // For synchronous construction, use token if available
    // GitHub App auth requires async initialization
    this.octokit = new Octokit({
      auth: this.config.token,
      baseUrl: this.config.baseUrl,
    });
  }

  /**
   * Initialize authentication strategy
   * Called automatically by createClientAsync for GitHub App auth
   */
  async initializeAuth(): Promise<void> {
    // Merge env config with explicit config (explicit takes precedence)
    const envAppConfig = readGitHubAppConfigFromEnv();
    const appConfig = this.config.app ?? envAppConfig;

    this.authStrategy = await createAuthStrategy({
      owner: this.config.owner,
      repo: this.config.repo,
      token: this.config.token,
      app: appConfig,
      baseUrl: this.config.baseUrl,
    });

    this.authType = this.authStrategy.type;

    // Log which auth method is active
    if (this.authType === 'github-app') {
      console.log(`[GitHubClient] Initialized with GitHub App authentication for ${this.config.owner}/${this.config.repo}`);
    } else {
      console.log(`[GitHubClient] Initialized with PAT authentication for ${this.config.owner}/${this.config.repo}`);
    }
  }

  /**
   * Get the authentication type being used
   */
  get authenticationType(): 'pat' | 'github-app' | undefined {
    return this.authType;
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
   * Get the current authentication token
   * For GitHub App, this returns the installation access token
   */
  async getToken(): Promise<string> {
    if (this.authStrategy) {
      return this.authStrategy.getToken();
    }
    // Fallback to configured token
    return this.config.token ?? '';
  }

  /**
   * Verify authentication by fetching the authenticated user
   */
  async verifyAuth(): Promise<{ login: string; id: number; type?: 'User' | 'Bot' }> {
    try {
      if (this.authStrategy) {
        const verification = await this.authStrategy.verify();
        return { login: verification.login, id: verification.id, type: verification.type };
      }

      const { data } = await this.octokit.rest.users.getAuthenticated();
      return { login: data.login, id: data.id, type: data.type as 'User' | 'Bot' };
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
 * Create a new GitHub client instance (synchronous, backward compatible)
 *
 * Note: For GitHub App authentication, use createClientAsync() instead.
 */
export function createClient(config: GitHubIssuesConfig): GitHubClient {
  return new GitHubClient(config);
}

/**
 * Create a new GitHub client instance with full auth initialization
 *
 * This async version properly initializes GitHub App authentication
 * and should be used when GitHub App auth is configured.
 */
export async function createClientAsync(config: GitHubIssuesConfig): Promise<GitHubClient> {
  const client = new GitHubClient(config);
  await client.initializeAuth();
  return client;
}
