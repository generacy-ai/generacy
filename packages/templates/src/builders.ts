/**
 * Context builder utilities for template rendering
 *
 * Provides helper functions to construct valid TemplateContext objects
 * from simpler input objects. Used by both CLI and cloud service.
 */

import {
  type TemplateContext,
  type SingleRepoInput,
  type MultiRepoInput,
  type ClusterVariant,
  SingleRepoInputSchema,
  MultiRepoInputSchema,
} from './schema.js';
import { validateContext } from './validators.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate ISO 8601 UTC timestamp
 *
 * Creates a timestamp for the metadata.timestamp field to track
 * when the configuration was generated.
 *
 * @returns Timestamp string in format "2026-02-24T15:30:00Z"
 *
 * @example
 * ```typescript
 * const timestamp = generateTimestamp();
 * // "2026-02-24T15:30:00.123Z"
 * ```
 */
function generateTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Convert release stream to Dev Container Feature tag
 *
 * Maps user-friendly release stream names to the actual Dev Container
 * Feature tag format used in devcontainer.json.
 *
 * @param releaseStream - 'stable' or 'preview'
 * @returns Feature tag (":1" for stable, ":preview" for preview)
 *
 * @example
 * ```typescript
 * releaseStreamToFeatureTag('stable')  // ":1"
 * releaseStreamToFeatureTag('preview') // ":preview"
 * ```
 */
function releaseStreamToFeatureTag(
  releaseStream: 'stable' | 'preview'
): ':1' | ':preview' {
  return releaseStream === 'stable' ? ':1' : ':preview';
}

/**
 * Get base branch default based on repository name
 *
 * Infers the default base branch for PRs. Currently defaults to 'main'
 * as it's the modern Git standard, but could be extended with heuristics
 * based on repository conventions.
 *
 * Common conventions:
 * - 'main' - Modern standard (GitHub default since 2020)
 * - 'develop' - GitFlow branching model
 * - 'master' - Legacy naming
 *
 * @param primaryRepo - Repository in "owner/repo" format
 * @returns Default base branch name (currently always 'main')
 *
 * @example
 * ```typescript
 * inferBaseBranch('acme/api') // "main"
 * ```
 */
function inferBaseBranch(primaryRepo: string): string {
  // Could add heuristics here based on repo name or other signals
  // For now, default to 'main' as it's the modern standard
  return 'main';
}

// ============================================================================
// Single-Repo Context Builder
// ============================================================================

/**
 * Build template context for single-repository projects
 *
 * Single-repo projects have only one repository (the primary repo) and use
 * a direct dev container without Docker Compose.
 *
 * @param options - Single-repo project configuration
 * @returns Validated TemplateContext ready for rendering
 * @throws ValidationError if the built context is invalid
 *
 * @example
 * ```typescript
 * const context = buildSingleRepoContext({
 *   projectId: 'proj_abc123',
 *   projectName: 'My API',
 *   primaryRepo: 'acme/main-api',
 *   releaseStream: 'stable',
 * });
 *
 * const files = await renderProject(context);
 * ```
 */
export function buildSingleRepoContext(options: SingleRepoInput): TemplateContext {
  // Validate input
  const validated = SingleRepoInputSchema.parse(options);

  // Apply defaults
  const releaseStream = validated.releaseStream ?? 'stable';
  const baseImage =
    validated.baseImage ?? 'mcr.microsoft.com/devcontainers/base:ubuntu';
  const baseBranch = validated.baseBranch ?? inferBaseBranch(validated.primaryRepo);

  // Build context
  const context: TemplateContext = {
    project: {
      id: validated.projectId,
      name: validated.projectName,
    },
    repos: {
      primary: validated.primaryRepo,
      dev: [],
      clone: [],
      hasDevRepos: false,
      hasCloneRepos: false,
      isMultiRepo: false,
    },
    defaults: {
      agent: validated.agent ?? 'claude-code',
      baseBranch,
      releaseStream,
    },
    orchestrator: {
      pollIntervalMs: 5000,
      workerCount: 0, // Single-repo doesn't use workers
    },
    devcontainer: {
      baseImage,
      featureTag: releaseStreamToFeatureTag(releaseStream),
    },
    metadata: {
      timestamp: generateTimestamp(),
      generatedBy: 'generacy-cli', // Default to CLI, caller can override
      version: '1.0.0',
    },
    cluster: {
      variant: validated.variant ?? 'standard',
    },
  };

  // Validate the built context
  return validateContext(context);
}

// ============================================================================
// Multi-Repo Context Builder
// ============================================================================

/**
 * Build template context for multi-repository projects
 *
 * Multi-repo projects have multiple development repositories and use Docker
 * Compose with orchestrator/worker architecture.
 *
 * @param options - Multi-repo project configuration
 * @returns Validated TemplateContext ready for rendering
 * @throws ValidationError if the built context is invalid
 *
 * @example
 * ```typescript
 * const context = buildMultiRepoContext({
 *   projectId: 'proj_xyz789',
 *   projectName: 'Acme Platform',
 *   primaryRepo: 'acme/orchestrator',
 *   devRepos: ['acme/api', 'acme/frontend'],
 *   cloneRepos: ['acme/shared-lib'],
 *   workerCount: 3,
 * });
 *
 * const files = await renderProject(context);
 * ```
 */
export function buildMultiRepoContext(options: MultiRepoInput): TemplateContext {
  // Validate input
  const validated = MultiRepoInputSchema.parse(options);

  // Apply defaults
  const releaseStream = validated.releaseStream ?? 'stable';
  const baseImage =
    validated.baseImage ?? 'mcr.microsoft.com/devcontainers/base:ubuntu';
  const baseBranch = validated.baseBranch ?? inferBaseBranch(validated.primaryRepo);
  const workerCount = validated.workerCount ?? 2;
  const pollIntervalMs = validated.pollIntervalMs ?? 5000;
  const cloneRepos = validated.cloneRepos ?? [];

  // Build context
  const context: TemplateContext = {
    project: {
      id: validated.projectId,
      name: validated.projectName,
    },
    repos: {
      primary: validated.primaryRepo,
      dev: validated.devRepos,
      clone: cloneRepos,
      hasDevRepos: validated.devRepos.length > 0,
      hasCloneRepos: cloneRepos.length > 0,
      isMultiRepo: true,
    },
    defaults: {
      agent: validated.agent ?? 'claude-code',
      baseBranch,
      releaseStream,
    },
    orchestrator: {
      pollIntervalMs,
      workerCount,
    },
    devcontainer: {
      baseImage,
      featureTag: releaseStreamToFeatureTag(releaseStream),
    },
    metadata: {
      timestamp: generateTimestamp(),
      generatedBy: 'generacy-cli', // Default to CLI, caller can override
      version: '1.0.0',
    },
    cluster: {
      variant: validated.variant ?? 'standard',
    },
  };

  // Validate the built context
  return validateContext(context);
}

// ============================================================================
// Context Modification Helpers
// ============================================================================

/**
 * Override the metadata.generatedBy field
 *
 * Useful when the cloud service generates contexts, to distinguish from CLI-generated ones.
 *
 * @param context - Existing template context
 * @param generatedBy - Source of generation ('generacy-cloud' or 'generacy-cli')
 * @returns New context with updated metadata
 *
 * @example
 * ```typescript
 * const cliContext = buildSingleRepoContext(options);
 * const cloudContext = withGeneratedBy(cliContext, 'generacy-cloud');
 * ```
 */
export function withGeneratedBy(
  context: TemplateContext,
  generatedBy: 'generacy-cloud' | 'generacy-cli'
): TemplateContext {
  return {
    ...context,
    metadata: {
      ...context.metadata,
      generatedBy,
    },
  };
}

/**
 * Override the devcontainer.baseImage field
 *
 * Useful for language-specific customization after context is built.
 *
 * @param context - Existing template context
 * @param baseImage - Docker image to use for dev container
 * @returns New context with updated base image
 *
 * @example
 * ```typescript
 * const context = buildSingleRepoContext(options);
 * const pythonContext = withBaseImage(context, 'mcr.microsoft.com/devcontainers/python:3.11');
 * ```
 */
export function withBaseImage(
  context: TemplateContext,
  baseImage: string
): TemplateContext {
  return {
    ...context,
    devcontainer: {
      ...context.devcontainer,
      baseImage,
    },
  };
}

/**
 * Override the defaults.baseBranch field
 *
 * Useful when base branch needs to be customized per-project.
 *
 * @param context - Existing template context
 * @param baseBranch - Default base branch name
 * @returns New context with updated base branch
 *
 * @example
 * ```typescript
 * const context = buildSingleRepoContext(options);
 * const developContext = withBaseBranch(context, 'develop');
 * ```
 */
export function withBaseBranch(
  context: TemplateContext,
  baseBranch: string
): TemplateContext {
  return {
    ...context,
    defaults: {
      ...context.defaults,
      baseBranch,
    },
  };
}

/**
 * Override the orchestrator configuration
 *
 * Useful for customizing worker count or poll interval after context is built.
 *
 * @param context - Existing template context
 * @param orchestrator - Partial orchestrator configuration to merge
 * @returns New context with updated orchestrator settings
 *
 * @example
 * ```typescript
 * const context = buildMultiRepoContext(options);
 * const tuned = withOrchestrator(context, { workerCount: 5, pollIntervalMs: 3000 });
 * ```
 */
export function withOrchestrator(
  context: TemplateContext,
  orchestrator: Partial<{ workerCount: number; pollIntervalMs: number }>
): TemplateContext {
  return {
    ...context,
    orchestrator: {
      ...context.orchestrator,
      ...orchestrator,
    },
  };
}

/**
 * Override the cluster variant
 *
 * Useful for switching between standard (DooD) and microservices (DinD) after context is built.
 *
 * @param context - Existing template context
 * @param variant - Cluster variant ('standard' or 'microservices')
 * @returns New context with updated cluster variant
 *
 * @example
 * ```typescript
 * const context = buildSingleRepoContext(options);
 * const dindContext = withVariant(context, 'microservices');
 * ```
 */
export function withVariant(
  context: TemplateContext,
  variant: ClusterVariant
): TemplateContext {
  return {
    ...context,
    cluster: {
      ...context.cluster,
      variant,
    },
  };
}

// ============================================================================
// Quick Builder Helpers
// ============================================================================

/**
 * Build context for a minimal single-repo project
 *
 * Uses all defaults with minimal required fields.
 *
 * @param projectId - Project ID
 * @param projectName - Human-readable project name
 * @param primaryRepo - Repository in "owner/repo" format
 * @returns Validated TemplateContext
 *
 * @example
 * ```typescript
 * const context = quickSingleRepo('proj_123', 'My App', 'acme/app');
 * ```
 */
export function quickSingleRepo(
  projectId: string,
  projectName: string,
  primaryRepo: string,
  variant?: ClusterVariant
): TemplateContext {
  return buildSingleRepoContext({
    projectId,
    projectName,
    primaryRepo,
    variant,
  });
}

/**
 * Build context for a minimal multi-repo project
 *
 * Uses all defaults with minimal required fields.
 *
 * @param projectId - Project ID
 * @param projectName - Human-readable project name
 * @param primaryRepo - Primary repository in "owner/repo" format
 * @param devRepos - Development repositories in "owner/repo" format
 * @returns Validated TemplateContext
 *
 * @example
 * ```typescript
 * const context = quickMultiRepo(
 *   'proj_456',
 *   'Platform',
 *   'acme/orchestrator',
 *   ['acme/api', 'acme/frontend']
 * );
 * ```
 */
export function quickMultiRepo(
  projectId: string,
  projectName: string,
  primaryRepo: string,
  devRepos: string[],
  variant?: ClusterVariant
): TemplateContext {
  return buildMultiRepoContext({
    projectId,
    projectName,
    primaryRepo,
    devRepos,
    variant,
  });
}
