import { z } from 'zod';

/**
 * Zod schema for GitHub App configuration validation
 */
export const GitHubAppConfigSchema = z
  .object({
    /** GitHub App ID */
    appId: z.union([
      z.number().positive('App ID must be a positive number'),
      z.string().regex(/^\d+$/, 'App ID must be a numeric string'),
    ]),
    /** Private key in PEM format */
    privateKey: z.string().optional(),
    /** Path to private key PEM file */
    privateKeyPath: z.string().optional(),
    /** Optional installation ID (auto-discovered if not provided) */
    installationId: z.number().positive('Installation ID must be positive').optional(),
  })
  .refine((data) => data.privateKey !== undefined || data.privateKeyPath !== undefined, {
    message: 'Either privateKey or privateKeyPath must be provided',
    path: ['privateKey'],
  });

/**
 * GitHub App configuration for authentication
 */
export interface GitHubAppConfig {
  /** GitHub App ID */
  appId: number | string;
  /** Private key in PEM format */
  privateKey?: string;
  /** Path to private key PEM file */
  privateKeyPath?: string;
  /** Optional installation ID (auto-discovered if not provided) */
  installationId?: number;
}

/**
 * Result of authentication verification
 */
export interface AuthVerification {
  /** GitHub login/username */
  login: string;
  /** GitHub user/bot ID */
  id: number;
  /** Account type */
  type: 'User' | 'Bot';
}

/**
 * Authentication strategy interface
 */
export interface AuthStrategy {
  /** Get a valid authentication token */
  getToken(): Promise<string>;
  /** Verify that authentication is working */
  verify(): Promise<AuthVerification>;
  /** Authentication type for logging purposes */
  readonly type: 'pat' | 'github-app';
}

/**
 * Cached installation access token
 */
export interface CachedToken {
  /** The access token */
  token: string;
  /** Token expiration time */
  expiresAt: Date;
  /** Installation ID the token is for */
  installationId: number;
  /** Permissions granted to this token */
  permissions: Record<string, string>;
  /** Repository selection mode */
  repositorySelection: 'all' | 'selected';
}

/**
 * Inferred type from GitHubAppConfigSchema
 */
export const ValidatedGitHubAppConfig = GitHubAppConfigSchema;
export type ValidatedGitHubAppConfig = z.infer<typeof GitHubAppConfigSchema>;
