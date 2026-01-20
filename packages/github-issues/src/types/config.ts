import { z } from 'zod';

/**
 * Plugin configuration for GitHub Issues integration
 */
export interface GitHubIssuesConfig {
  /** Repository owner (user or organization) */
  owner: string;

  /** Repository name */
  repo: string;

  /** GitHub authentication token (PAT or installation token) */
  token: string;

  /** Webhook secret for signature verification */
  webhookSecret?: string;

  /** Agent account username for assignment detection */
  agentAccount?: string;

  /** Labels that trigger workflow start */
  triggerLabels?: string[];

  /** GitHub Enterprise base URL */
  baseUrl?: string;
}

/**
 * Zod schema for configuration validation
 */
export const GitHubIssuesConfigSchema = z.object({
  owner: z.string().min(1, 'Owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  token: z.string().min(1, 'Token is required'),
  webhookSecret: z.string().optional(),
  agentAccount: z.string().optional(),
  triggerLabels: z.array(z.string()).optional(),
  baseUrl: z.string().url('Invalid base URL').optional(),
});

export type ValidatedConfig = z.infer<typeof GitHubIssuesConfigSchema>;
