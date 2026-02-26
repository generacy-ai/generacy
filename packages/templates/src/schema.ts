/**
 * Zod schemas and TypeScript types for template context
 *
 * Defines the structure of variables passed to Handlebars templates
 * during onboarding PR generation or `generacy init` CLI command.
 */

import { z } from 'zod';

// ============================================================================
// Project Context
// ============================================================================

/**
 * Project metadata
 */
export const ProjectContextSchema = z.object({
  /** Project ID (e.g., "proj_abc123") */
  id: z.string().min(1, 'Project ID is required'),

  /** Human-readable project name (e.g., "My Project") */
  name: z.string().min(1, 'Project name is required'),
});

export type ProjectContext = z.infer<typeof ProjectContextSchema>;

// ============================================================================
// Repos Context
// ============================================================================

/**
 * Repository configuration
 * Uses GitHub shorthand format: "owner/repo"
 */
export const ReposContextSchema = z.object({
  /** Primary repository (shorthand: "owner/repo") */
  primary: z.string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'Primary repo must be in format "owner/repo"'),

  /** Development repositories where PRs will be created (shorthand format) */
  dev: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
    .default([]),

  /** Clone-only repositories (no PRs created, shorthand format) */
  clone: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
    .default([]),

  /** Computed: true if any dev repos exist */
  hasDevRepos: z.boolean(),

  /** Computed: true if any clone repos exist */
  hasCloneRepos: z.boolean(),

  /** Computed: true if project has multiple development repos */
  isMultiRepo: z.boolean(),
}).superRefine((repos, ctx) => {
  const allRepos = [repos.primary, ...repos.dev, ...repos.clone];
  const nameToRepos: Record<string, string[]> = {};

  for (const repo of allRepos) {
    const name = repo.split('/')[1];
    if (nameToRepos[name]) {
      nameToRepos[name].push(repo);
    } else {
      nameToRepos[name] = [repo];
    }
  }

  for (const name of Object.keys(nameToRepos)) {
    if (nameToRepos[name].length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Multiple repos resolve to the same mount path "${name}": ${nameToRepos[name].join(', ')}`,
      });
    }
  }
});

export type ReposContext = z.infer<typeof ReposContextSchema>;

// ============================================================================
// Defaults Context
// ============================================================================

/**
 * Default settings for the project
 */
export const DefaultsContextSchema = z.object({
  /** Default agent to use (e.g., "claude-code") */
  agent: z.string().default('claude-code'),

  /** Default base branch for PRs (e.g., "main", "develop") */
  baseBranch: z.string().default('main'),

  /** Release stream determines Dev Container Feature tag */
  releaseStream: z.enum(['stable', 'preview'])
    .default('stable')
    .describe('stable=":1" tag, preview=":preview" tag'),
});

export type DefaultsContext = z.infer<typeof DefaultsContextSchema>;

// ============================================================================
// Orchestrator Context
// ============================================================================

/**
 * Orchestrator configuration (multi-repo only)
 */
export const OrchestratorContextSchema = z.object({
  /** Poll interval in milliseconds for checking new tasks (minimum 5000ms) */
  pollIntervalMs: z.number()
    .int()
    .min(5000)
    .default(5000)
    .describe('How often orchestrator checks for new work (ms, minimum 5000)'),

  /** Number of worker containers to spawn (0–20) */
  workerCount: z.number()
    .int()
    .nonnegative()
    .max(20)
    .default(2)
    .describe('Number of parallel workers (0 for single-repo, max 20)'),
});

export type OrchestratorContext = z.infer<typeof OrchestratorContextSchema>;

// ============================================================================
// DevContainer Context
// ============================================================================

/**
 * Dev Container configuration
 */
export const DevContainerContextSchema = z.object({
  /** Base Docker image for dev container */
  baseImage: z.string()
    .default('mcr.microsoft.com/devcontainers/base:ubuntu')
    .describe('Language-agnostic base image, Feature handles tooling'),

  /** Dev Container Feature tag (derived from releaseStream) */
  featureTag: z.string()
    .regex(/^:(1|preview)$/, 'Feature tag must be ":1" or ":preview"')
    .describe('":1" for stable, ":preview" for latest'),
});

export type DevContainerContext = z.infer<typeof DevContainerContextSchema>;

// ============================================================================
// Metadata Context
// ============================================================================

/**
 * Template generation metadata
 */
export const MetadataContextSchema = z.object({
  /** ISO 8601 UTC timestamp (e.g., "2026-02-24T15:30:00Z") */
  timestamp: z.string()
    .datetime({ offset: true })
    .describe('When this config was generated'),

  /** Source of generation ("generacy-cloud" or "generacy-cli") */
  generatedBy: z.enum(['generacy-cloud', 'generacy-cli'])
    .describe('Which service generated this config'),

  /** Template schema version for forward compatibility */
  version: z.string()
    .regex(/^\d+\.\d+\.\d+$/, 'Version must be semver format (e.g., "1.0.0")')
    .default('1.0.0')
    .describe('Schema version for migration support'),
});

export type MetadataContext = z.infer<typeof MetadataContextSchema>;

// ============================================================================
// Complete Template Context
// ============================================================================

/**
 * Complete context passed to template renderer
 * All templates receive this full context structure
 */
export const TemplateContextSchema = z.object({
  /** Project metadata */
  project: ProjectContextSchema,

  /** Repository configuration */
  repos: ReposContextSchema,

  /** Default settings */
  defaults: DefaultsContextSchema,

  /** Orchestrator config (multi-repo only, but always present for template simplicity) */
  orchestrator: OrchestratorContextSchema,

  /** Dev Container configuration */
  devcontainer: DevContainerContextSchema,

  /** Template generation metadata */
  metadata: MetadataContextSchema,
});

export type TemplateContext = z.infer<typeof TemplateContextSchema>;

// ============================================================================
// Context Builder Input Types
// ============================================================================

/**
 * Input for building single-repo template context
 */
export const SingleRepoInputSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  primaryRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  baseImage: z.string().optional(),
  releaseStream: z.enum(['stable', 'preview']).optional(),
  baseBranch: z.string().optional(),
});

export type SingleRepoInput = z.infer<typeof SingleRepoInputSchema>;

/**
 * Input for building multi-repo template context
 */
export const MultiRepoInputSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  primaryRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  devRepos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).min(1),
  cloneRepos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional(),
  baseImage: z.string().optional(),
  releaseStream: z.enum(['stable', 'preview']).optional(),
  baseBranch: z.string().optional(),
  workerCount: z.number().int().min(1).max(20).optional(),
  pollIntervalMs: z.number().int().min(5000).optional(),
});

export type MultiRepoInput = z.infer<typeof MultiRepoInputSchema>;

// ============================================================================
// Extensions.json Types
// ============================================================================

/**
 * VS Code extensions.json schema
 */
export const ExtensionsJsonSchema = z.object({
  /** Recommended extensions */
  recommendations: z.array(z.string()).default([]),

  /** Extensions to not recommend */
  unwantedRecommendations: z.array(z.string()).optional(),
});

export type ExtensionsJson = z.infer<typeof ExtensionsJsonSchema>;

/**
 * Generacy's required VS Code extensions
 */
export const GENERACY_EXTENSIONS = [
  'generacy-ai.agency',
  'generacy-ai.generacy',
] as const;

// ============================================================================
// Template Metadata Types
// ============================================================================

/**
 * Optional front matter for template files
 */
export const TemplateMetadataSchema = z.object({
  /** Schema version for this template */
  schema_version: z.string(),

  /** Target file path in user's repo */
  target_path: z.string(),

  /** Required context fields (dot notation) */
  required_context: z.array(z.string()).optional(),
});

export type TemplateMetadata = z.infer<typeof TemplateMetadataSchema>;

// ============================================================================
// Template Migration Types
// ============================================================================

/**
 * Migration function for updating context between schema versions
 */
export interface TemplateMigration {
  /** Source schema version */
  fromVersion: string;

  /** Target schema version */
  toVersion: string;

  /** Migration function to transform context */
  migrate: (oldContext: any) => TemplateContext;
}

// ============================================================================
// Validation Result Types
// ============================================================================

/**
 * Result of context validation
 */
export interface ValidationResult {
  /** Whether validation passed */
  success: boolean;

  /** Validated context (if success=true) */
  data?: TemplateContext;

  /** Validation errors (if success=false) */
  errors?: Array<{
    path: string[];
    message: string;
  }>;
}

// ============================================================================
// Rendered File Map Type
// ============================================================================

/**
 * Map of target file paths to rendered content
 *
 * @example
 * {
 *   '.generacy/config.yaml': '...',
 *   '.devcontainer/devcontainer.json': '...',
 * }
 */
export type RenderedFileMap = Map<string, string>;

// ============================================================================
// Template Selection Types
// ============================================================================

/**
 * Template information for rendering
 */
export interface TemplateInfo {
  /** Template file path relative to templates directory */
  templatePath: string;

  /** Target path in user's repository */
  targetPath: string;

  /** Whether this template requires special handling (merge, etc.) */
  requiresMerge: boolean;

  /** Whether this is a static file (no rendering) */
  isStatic: boolean;
}

/**
 * Type of project (determines template selection)
 */
export type ProjectType = 'single-repo' | 'multi-repo';
