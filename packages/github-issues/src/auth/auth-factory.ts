import type { AuthStrategy, GitHubAppConfig } from './types.js';
import { GitHubAppAuthStrategy, type AuthContext } from './github-app.js';
import { GitHubAppConfigSchema } from './types.js';
import { GitHubValidationError } from '../utils/errors.js';

/**
 * PAT (Personal Access Token) authentication strategy
 *
 * Simple strategy that returns a static token.
 */
export class PATAuthStrategy implements AuthStrategy {
  public readonly type = 'pat' as const;

  private readonly token: string;
  private readonly context: AuthContext;

  constructor(token: string, context: AuthContext) {
    this.token = token;
    this.context = context;
  }

  async getToken(): Promise<string> {
    return this.token;
  }

  async verify(): Promise<{ login: string; id: number; type: 'User' | 'Bot' }> {
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({
      auth: this.token,
      baseUrl: this.context.baseUrl,
    });

    const { data } = await octokit.rest.users.getAuthenticated();
    return {
      login: data.login,
      id: data.id,
      type: data.type as 'User' | 'Bot',
    };
  }
}

/**
 * Configuration for createAuthStrategy
 */
export interface AuthFactoryConfig {
  owner: string;
  repo: string;
  token?: string;
  app?: GitHubAppConfig;
  baseUrl?: string;
}

/**
 * Create an authentication strategy based on the provided configuration
 *
 * Priority:
 * 1. GitHub App auth (if app config provided)
 * 2. PAT auth (if token provided)
 *
 * If GitHub App auth fails and PAT is available, falls back to PAT.
 *
 * @param config Authentication configuration
 * @returns An initialized AuthStrategy
 * @throws Error if neither app nor token is configured
 */
export async function createAuthStrategy(config: AuthFactoryConfig): Promise<AuthStrategy> {
  const context: AuthContext = {
    owner: config.owner,
    repo: config.repo,
    baseUrl: config.baseUrl,
  };

  // Validate that at least one auth method is provided
  if (!config.app && !config.token) {
    throw new GitHubValidationError(
      'No authentication configured. Either app or token is required.'
    );
  }

  // Try GitHub App auth first if configured
  if (config.app) {
    try {
      // Validate app config
      const validationResult = GitHubAppConfigSchema.safeParse(config.app);
      if (!validationResult.success) {
        const errorMessages = validationResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        throw new GitHubValidationError(
          `Invalid GitHub App configuration: ${errorMessages}`
        );
      }

      const strategy = new GitHubAppAuthStrategy(config.app, context);
      await strategy.initialize();
      return strategy;
    } catch (error) {
      // If PAT is available, fall back to it
      if (config.token) {
        console.warn(
          `GitHub App auth failed, falling back to PAT: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        return new PATAuthStrategy(config.token, context);
      }
      // No fallback available
      throw error;
    }
  }

  // Use PAT auth
  return new PATAuthStrategy(config.token!, context);
}
