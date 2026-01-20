import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { GitHubAppConfig, AuthStrategy, AuthVerification, CachedToken } from './types.js';
import { GitHubAppAuthError, GitHubAppErrorCode } from '../utils/errors.js';
import { TokenCache } from './token-cache.js';
import * as fs from 'node:fs';

/**
 * Authentication context for Octokit initialization
 */
export interface AuthContext {
  owner: string;
  repo: string;
  baseUrl?: string;
}

/**
 * GitHub App authentication strategy
 *
 * Implements the AuthStrategy interface for GitHub App authentication.
 * Handles JWT generation, installation discovery, and token caching.
 */
export class GitHubAppAuthStrategy implements AuthStrategy {
  public readonly type = 'github-app' as const;

  private readonly config: GitHubAppConfig;
  private readonly context: AuthContext;
  private readonly tokenCache: TokenCache;
  private installationId: number | null = null;
  private octokit: Octokit | null = null;
  private authFn: ReturnType<typeof createAppAuth> | null = null;

  constructor(config: GitHubAppConfig, context: AuthContext) {
    this.config = config;
    this.context = context;
    this.tokenCache = new TokenCache();
  }

  /**
   * Initialize the GitHub App authentication
   * - Resolves private key (from file or inline)
   * - Creates the auth function
   * - Discovers installation ID if not provided
   */
  async initialize(): Promise<void> {
    const privateKey = await this.resolvePrivateKey();
    const appId = typeof this.config.appId === 'string'
      ? parseInt(this.config.appId, 10)
      : this.config.appId;

    this.authFn = createAppAuth({
      appId,
      privateKey,
    });

    // If installation ID is provided, use it; otherwise discover it
    if (this.config.installationId) {
      this.installationId = this.config.installationId;
    } else {
      this.installationId = await this.discoverInstallationId();
    }

    // Create Octokit instance with app auth
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey,
        installationId: this.installationId,
      },
      baseUrl: this.context.baseUrl,
    });
  }

  /**
   * Resolve the private key from file path or inline content
   */
  private async resolvePrivateKey(): Promise<string> {
    if (this.config.privateKey) {
      return this.config.privateKey;
    }

    if (this.config.privateKeyPath) {
      try {
        return fs.readFileSync(this.config.privateKeyPath, 'utf-8');
      } catch (error) {
        throw new GitHubAppAuthError(
          `Failed to read private key from path: ${this.config.privateKeyPath}`,
          GitHubAppErrorCode.PRIVATE_KEY_NOT_FOUND,
          error
        );
      }
    }

    throw new GitHubAppAuthError(
      'No private key provided. Either privateKey or privateKeyPath is required.',
      GitHubAppErrorCode.INVALID_PRIVATE_KEY
    );
  }

  /**
   * Discover the installation ID for the configured owner
   * Uses the GitHub App JWT to list installations and find the matching one
   */
  private async discoverInstallationId(): Promise<number> {
    if (!this.authFn) {
      throw new GitHubAppAuthError(
        'Auth function not initialized',
        GitHubAppErrorCode.JWT_GENERATION_FAILED
      );
    }

    try {
      // Get app-level auth (JWT) for listing installations
      const appAuth = await this.authFn({ type: 'app' });

      // Create a temporary Octokit for installation discovery
      const tempOctokit = new Octokit({
        auth: appAuth.token,
        baseUrl: this.context.baseUrl,
      });

      // List all installations
      const { data: installations } = await tempOctokit.request('GET /app/installations');

      // Find installation for the configured owner (case-insensitive)
      const installation = installations.find(
        (inst: { account: { login: string } | null }) =>
          inst.account?.login.toLowerCase() === this.context.owner.toLowerCase()
      );

      if (!installation) {
        throw new GitHubAppAuthError(
          `No installation found for owner: ${this.context.owner}`,
          GitHubAppErrorCode.INSTALLATION_NOT_FOUND
        );
      }

      return installation.id;
    } catch (error) {
      if (error instanceof GitHubAppAuthError) {
        throw error;
      }
      throw new GitHubAppAuthError(
        'Failed to discover installation ID',
        GitHubAppErrorCode.INSTALLATION_NOT_FOUND,
        error
      );
    }
  }

  /**
   * Get a valid authentication token
   * Returns cached token if still valid, otherwise generates a new one
   */
  async getToken(): Promise<string> {
    if (this.installationId === null) {
      await this.initialize();
    }

    // Check cache first
    const cached = this.tokenCache.get(this.installationId!);
    if (cached && !this.tokenCache.needsRefresh(this.installationId!)) {
      return cached.token;
    }

    // Generate new token
    return this.generateInstallationToken();
  }

  /**
   * Generate a new installation access token
   */
  private async generateInstallationToken(): Promise<string> {
    if (!this.authFn || this.installationId === null) {
      throw new GitHubAppAuthError(
        'GitHub App not initialized',
        GitHubAppErrorCode.TOKEN_GENERATION_FAILED
      );
    }

    try {
      const auth = await this.authFn({
        type: 'installation',
        installationId: this.installationId,
      });

      // Cache the token
      const cachedToken: CachedToken = {
        token: auth.token,
        expiresAt: new Date(auth.expiresAt!),
        installationId: this.installationId,
        permissions: (auth as { permissions?: Record<string, string> }).permissions ?? {},
        repositorySelection: ((auth as { repositorySelection?: string }).repositorySelection as 'all' | 'selected') ?? 'all',
      };

      this.tokenCache.set(cachedToken);

      return auth.token;
    } catch (error) {
      throw new GitHubAppAuthError(
        'Failed to generate installation access token',
        GitHubAppErrorCode.TOKEN_GENERATION_FAILED,
        error
      );
    }
  }

  /**
   * Verify that authentication is working
   * Returns the authenticated user/bot information
   */
  async verify(): Promise<AuthVerification> {
    const token = await this.getToken();

    const octokit = new Octokit({
      auth: token,
      baseUrl: this.context.baseUrl,
    });

    const { data } = await octokit.request('GET /user');

    return {
      login: data.login,
      id: data.id,
      type: data.type as 'User' | 'Bot',
    };
  }

  /**
   * Get the Octokit instance for making API calls
   */
  getOctokit(): Octokit {
    if (!this.octokit) {
      throw new GitHubAppAuthError(
        'GitHub App not initialized. Call initialize() first.',
        GitHubAppErrorCode.JWT_GENERATION_FAILED
      );
    }
    return this.octokit;
  }

  /**
   * Clear the token cache
   */
  clearCache(): void {
    this.tokenCache.clearAll();
  }
}

/**
 * Create a new GitHubAppAuthStrategy instance
 */
export async function createGitHubAppAuth(
  config: GitHubAppConfig,
  context: AuthContext
): Promise<GitHubAppAuthStrategy> {
  const strategy = new GitHubAppAuthStrategy(config, context);
  await strategy.initialize();
  return strategy;
}
