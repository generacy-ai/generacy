import { z } from 'zod';

/**
 * Project configuration schema
 * Defines project metadata and link to generacy.ai
 */
export const ProjectConfigSchema = z.object({
  /**
   * Unique project ID from generacy.ai
   * Format: proj_{alphanumeric}, minimum 12 characters total
   * Example: "proj_abc123"
   */
  id: z.string()
    .regex(/^proj_[a-z0-9]+$/, 'Project ID must match format: proj_{alphanumeric}')
    .min(12, 'Project ID must be at least 12 characters'),

  /**
   * Human-readable project name
   * Maximum 255 characters
   */
  name: z.string()
    .min(1, 'Project name cannot be empty')
    .max(255, 'Project name cannot exceed 255 characters'),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * Repository URL schema
 * Format: github.com/{owner}/{repo}
 * Protocol-agnostic (no https:// or ssh://, no .git suffix)
 */
const RepositoryUrlSchema = z.string()
  .regex(
    /^github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/,
    'Repository URL must match format: github.com/{owner}/{repo}'
  )
  .refine(
    (url) => !url.endsWith('.git'),
    'Repository URL must not end with .git suffix'
  );

/**
 * Repository configuration schema
 * Defines repository relationships for the project
 */
export const ReposConfigSchema = z.object({
  /**
   * Primary repository (the "main" repo for the project)
   * This is the repository where the onboarding PR will be created
   */
  primary: RepositoryUrlSchema,

  /**
   * Development repositories (optional)
   * These repos are cloned for active development and can receive PRs
   * Default: empty array
   */
  dev: z.array(RepositoryUrlSchema).optional().default([]),

  /**
   * Clone-only repositories (optional)
   * These repos are cloned for reference/reading only (no PRs created)
   * Default: empty array
   */
  clone: z.array(RepositoryUrlSchema).optional().default([]),
});

export type ReposConfig = z.infer<typeof ReposConfigSchema>;

/**
 * Workflow defaults schema
 * Defines default settings for workflow execution
 */
export const DefaultsConfigSchema = z.object({
  /**
   * Default agent to use for workflow execution
   * Format: kebab-case (e.g., "claude-code", "cursor-agent")
   */
  agent: z.string()
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'Agent name must be kebab-case format (lowercase alphanumeric with hyphens)'
    )
    .optional(),

  /**
   * Default base branch for creating feature branches
   * No validation of branch existence (checked at runtime)
   */
  baseBranch: z.string()
    .min(1, 'Base branch cannot be empty')
    .optional(),
});

export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>;

/**
 * Orchestrator settings schema
 * Defines runtime settings for the orchestrator
 */
export const OrchestratorSettingsSchema = z.object({
  /**
   * Polling interval in milliseconds
   * Minimum 5000ms (5 seconds)
   */
  pollIntervalMs: z.number()
    .int('Poll interval must be an integer')
    .min(5000, 'Poll interval must be at least 5000ms (5 seconds)')
    .optional(),

  /**
   * Maximum number of concurrent workers
   * Range: 1-20
   */
  workerCount: z.number()
    .int('Worker count must be an integer')
    .min(1, 'Worker count must be at least 1')
    .max(20, 'Worker count cannot exceed 20')
    .optional(),
});

export type OrchestratorSettings = z.infer<typeof OrchestratorSettingsSchema>;

/**
 * Cluster configuration schema
 * Defines the development cluster topology
 */
export const ClusterConfigSchema = z.object({
  /**
   * Cluster variant determines the Docker topology
   * - standard: Docker-outside-of-Docker (DooD) — for apps that don't run containers
   * - microservices: Docker-in-Docker (DinD) — each worker can run isolated container stacks
   */
  variant: z.enum(['standard', 'microservices']).default('standard'),
});

export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;

/**
 * Complete Generacy configuration schema
 * Root configuration object for .generacy/config.yaml
 */
export const GeneracyConfigSchema = z.object({
  /**
   * Schema version (optional)
   * Defaults to "1" if omitted
   * Used for future migration support
   */
  schemaVersion: z.string().default('1'),

  /**
   * Project configuration (required)
   */
  project: ProjectConfigSchema,

  /**
   * Repository configuration (required)
   */
  repos: ReposConfigSchema,

  /**
   * Workflow defaults (optional)
   */
  defaults: DefaultsConfigSchema.optional(),

  /**
   * Orchestrator settings (optional)
   */
  orchestrator: OrchestratorSettingsSchema.optional(),

  /**
   * Cluster configuration (optional)
   * Defines the development cluster Docker topology
   */
  cluster: ClusterConfigSchema.optional(),
});

export type GeneracyConfig = z.infer<typeof GeneracyConfigSchema>;

/**
 * Validate a configuration object against the schema
 *
 * @param config - Unknown configuration object to validate
 * @returns Validated and typed configuration
 * @throws ZodError if validation fails
 *
 * @example
 * ```typescript
 * const config = validateConfig({
 *   project: { id: 'proj_abc123', name: 'My Project' },
 *   repos: { primary: 'github.com/acme/main' }
 * });
 * ```
 */
export function validateConfig(config: unknown): GeneracyConfig {
  return GeneracyConfigSchema.parse(config);
}
