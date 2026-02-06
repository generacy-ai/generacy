import { z } from 'zod';

/**
 * Jira plugin configuration
 */
export interface JiraConfig {
  /** Jira Cloud host URL (e.g., "https://company.atlassian.net") */
  host: string;

  /** Atlassian account email */
  email: string;

  /** Jira API token */
  apiToken: string;

  /** Default project key for operations */
  projectKey?: string;

  /** Map Generacy issue types to Jira issue types */
  issueTypeMapping?: {
    feature: string;
    bug: string;
    task: string;
    epic: string;
  };

  /** Map workflow states to Jira status IDs */
  workflowMapping?: {
    todo: string;
    inProgress: string;
    done: string;
  };

  /** Webhook secret for signature verification */
  webhookSecret?: string;

  /** Timeout for API requests (ms) */
  timeout?: number;
}

/**
 * Issue type mapping configuration schema
 */
export const IssueTypeMappingSchema = z.object({
  feature: z.string().default('Story'),
  bug: z.string().default('Bug'),
  task: z.string().default('Task'),
  epic: z.string().default('Epic'),
});

/**
 * Workflow mapping configuration schema
 */
export const WorkflowMappingSchema = z.object({
  todo: z.string(),
  inProgress: z.string(),
  done: z.string(),
});

/**
 * Zod schema for configuration validation
 */
export const JiraConfigSchema = z.object({
  host: z.string().url('Host must be a valid URL'),
  email: z.string().email('Valid email required'),
  apiToken: z.string().min(1, 'API token is required'),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Project key must start with uppercase letter').optional(),
  issueTypeMapping: IssueTypeMappingSchema.optional(),
  workflowMapping: WorkflowMappingSchema.optional(),
  webhookSecret: z.string().optional(),
  timeout: z.number().positive().optional(),
});

export type ValidatedJiraConfig = z.infer<typeof JiraConfigSchema>;
