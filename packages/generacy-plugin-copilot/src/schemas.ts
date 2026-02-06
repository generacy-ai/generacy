/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Zod validation schemas for runtime validation.
 */

import { z } from 'zod';

// =============================================================================
// Workspace Schemas
// =============================================================================

/**
 * Schema for workspace status values.
 */
export const WorkspaceStatusSchema = z.enum([
  'pending',
  'planning',
  'implementing',
  'review_ready',
  'merged',
  'failed',
  'not_available',
]);

/**
 * Schema for file change types.
 */
export const FileChangeTypeSchema = z.enum(['added', 'modified', 'deleted', 'renamed']);

/**
 * Schema for PR state.
 */
export const PullRequestStateSchema = z.enum(['open', 'closed', 'merged']);

/**
 * Schema for review status.
 */
export const ReviewStatusSchema = z.enum([
  'pending',
  'approved',
  'changes_requested',
  'dismissed',
]);

// =============================================================================
// Input Schemas
// =============================================================================

/**
 * Schema for workspace options.
 */
export const WorkspaceOptionsSchema = z.object({
  autoMerge: z.boolean().optional(),
  reviewRequired: z.boolean().optional(),
  timeoutMs: z.number().positive('Timeout must be positive').optional(),
  prLabels: z.array(z.string()).optional(),
});

/**
 * Schema for create workspace parameters.
 */
export const CreateWorkspaceParamsSchema = z.object({
  issueUrl: z
    .string()
    .url('Issue URL must be a valid URL')
    .regex(
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/,
      'Issue URL must be a valid GitHub issue URL'
    ),
  options: WorkspaceOptionsSchema.optional(),
});

// =============================================================================
// Configuration Schemas
// =============================================================================

/**
 * Schema for polling configuration.
 */
export const PollingConfigSchema = z.object({
  initialIntervalMs: z
    .number()
    .int('Initial interval must be an integer')
    .positive('Initial interval must be positive')
    .default(5000),
  maxIntervalMs: z
    .number()
    .int('Max interval must be an integer')
    .positive('Max interval must be positive')
    .default(60000),
  backoffMultiplier: z
    .number()
    .positive('Backoff multiplier must be positive')
    .default(1.5),
  maxRetries: z
    .number()
    .int('Max retries must be an integer')
    .nonnegative('Max retries cannot be negative')
    .default(100),
  timeoutMs: z
    .number()
    .int('Timeout must be an integer')
    .positive('Timeout must be positive')
    .optional(),
});

/**
 * Schema for GitHub token validation.
 */
export const GitHubTokenSchema = z
  .string()
  .min(1, 'GitHub token is required')
  .refine(
    (token) => {
      const validPrefixes = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];
      return validPrefixes.some((prefix) => token.startsWith(prefix)) || token.length === 40;
    },
    { message: 'Invalid GitHub token format' }
  );

/**
 * Schema for plugin options.
 */
export const CopilotPluginOptionsSchema = z.object({
  githubToken: GitHubTokenSchema,
  apiBaseUrl: z.string().url('API base URL must be a valid URL').optional(),
  logger: z.any().optional(),
  polling: PollingConfigSchema.partial().optional(),
  workspaceDefaults: WorkspaceOptionsSchema.optional(),
});

// =============================================================================
// Output Schemas
// =============================================================================

/**
 * Schema for file change.
 */
export const FileChangeSchema = z.object({
  path: z.string().min(1, 'File path is required'),
  type: FileChangeTypeSchema,
  previousPath: z.string().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  content: z.string().optional(),
  patch: z.string().optional(),
});

/**
 * Schema for pull request.
 */
export const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  body: z.string(),
  state: PullRequestStateSchema,
  head: z.string(),
  base: z.string(),
  mergeable: z.boolean().optional(),
  linkedIssues: z.array(z.number().int().positive()),
  reviewStatus: ReviewStatusSchema,
  changedFiles: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

/**
 * Schema for workspace.
 */
export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  issueUrl: z.string().url(),
  status: WorkspaceStatusSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
  pullRequestUrl: z.string().url().optional(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive(),
});

/**
 * Schema for workspace status event.
 */
export const WorkspaceStatusEventSchema = z.object({
  workspaceId: z.string().min(1),
  previousStatus: WorkspaceStatusSchema,
  status: WorkspaceStatusSchema,
  timestamp: z.date(),
  details: z
    .object({
      pullRequestUrl: z.string().url().optional(),
      failureReason: z.string().optional(),
      progress: z.number().min(0).max(100).optional(),
    })
    .optional(),
});

// =============================================================================
// Type Exports
// =============================================================================

export type WorkspaceOptionsInput = z.input<typeof WorkspaceOptionsSchema>;
export type WorkspaceOptionsOutput = z.output<typeof WorkspaceOptionsSchema>;

export type CreateWorkspaceParamsInput = z.input<typeof CreateWorkspaceParamsSchema>;
export type CreateWorkspaceParamsOutput = z.output<typeof CreateWorkspaceParamsSchema>;

export type PollingConfigInput = z.input<typeof PollingConfigSchema>;
export type PollingConfigOutput = z.output<typeof PollingConfigSchema>;

export type CopilotPluginOptionsInput = z.input<typeof CopilotPluginOptionsSchema>;
export type CopilotPluginOptionsOutput = z.output<typeof CopilotPluginOptionsSchema>;
