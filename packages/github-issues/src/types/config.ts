import { z } from 'zod';
import { GitHubAppConfigSchema, type GitHubAppConfig } from '../auth/types.js';

/**
 * Plugin configuration for GitHub Issues integration
 */
export interface GitHubIssuesConfig {
  /** Repository owner (user or organization) */
  owner: string;

  /** Repository name */
  repo: string;

  /** GitHub authentication token (PAT or installation token) - optional if app is configured */
  token?: string;

  /** GitHub App authentication configuration */
  app?: GitHubAppConfig;

  /** Webhook secret for signature verification */
  webhookSecret?: string;

  /** Agent account username for assignment detection */
  agentAccount?: string;

  /** Labels that trigger workflow start */
  triggerLabels?: string[];

  /** GitHub Enterprise base URL */
  baseUrl?: string;

  /** Cache TTL in milliseconds for issue caching (default: 60000) */
  cacheTimeout?: number;
}

/**
 * Zod schema for configuration validation
 */
export const GitHubIssuesConfigSchema = z
  .object({
    owner: z.string().min(1, 'Owner is required'),
    repo: z.string().min(1, 'Repository name is required'),
    token: z.string().optional(),
    app: GitHubAppConfigSchema.optional(),
    webhookSecret: z.string().optional(),
    agentAccount: z.string().optional(),
    triggerLabels: z.array(z.string()).optional(),
    baseUrl: z.string().url('Invalid base URL').optional(),
    cacheTimeout: z.number().positive().optional(),
  })
  .refine((data) => data.token !== undefined || data.app !== undefined, {
    message: 'Either token or app configuration is required',
    path: ['token'],
  });

export type ValidatedConfig = z.infer<typeof GitHubIssuesConfigSchema>;
