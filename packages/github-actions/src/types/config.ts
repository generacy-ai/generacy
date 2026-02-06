import { z } from 'zod';

/**
 * Polling configuration for status monitoring
 */
export interface PollingOptions {
  /** Polling interval in milliseconds (default: 10000) */
  interval?: number;
  /** Maximum polling attempts (default: 60) */
  maxAttempts?: number;
}

/**
 * Named workflows for common operations
 */
export interface WorkflowsConfig {
  /** CI workflow filename (e.g., "ci.yml") */
  ci?: string;
  /** Deploy workflow filename (e.g., "deploy.yml") */
  deploy?: string;
  /** Test workflow filename (e.g., "test.yml") */
  test?: string;
}

/**
 * Plugin configuration interface
 */
export interface GitHubActionsConfig {
  /** Repository owner (user or organization) */
  owner: string;
  /** Repository name */
  repo: string;
  /** GitHub Personal Access Token */
  token: string;
  /** Named workflows for common operations */
  workflows?: WorkflowsConfig;
  /** Polling configuration */
  polling?: PollingOptions;
}

/**
 * Zod schema for polling configuration validation
 */
export const pollingOptionsSchema = z.object({
  interval: z.number().min(1000, 'Polling interval must be at least 1000ms').optional(),
  maxAttempts: z.number().min(1, 'Max attempts must be at least 1').optional(),
});

/**
 * Zod schema for workflows configuration validation
 */
export const workflowsConfigSchema = z.object({
  ci: z.string().optional(),
  deploy: z.string().optional(),
  test: z.string().optional(),
});

/**
 * Zod schema for plugin configuration validation
 */
export const gitHubActionsConfigSchema = z.object({
  owner: z.string().min(1, 'Owner is required'),
  repo: z.string().min(1, 'Repo is required'),
  token: z.string().min(1, 'Token is required'),
  workflows: workflowsConfigSchema.optional(),
  polling: pollingOptionsSchema.optional(),
});

/**
 * Default polling configuration values
 */
export const DEFAULT_POLLING_CONFIG: Required<PollingOptions> = {
  interval: 10000,
  maxAttempts: 60,
};

/**
 * Validate and parse plugin configuration
 */
export function parseConfig(config: unknown): GitHubActionsConfig {
  return gitHubActionsConfigSchema.parse(config);
}
