/**
 * @generacy-ai/templates - Onboarding PR Template System
 *
 * This package provides a template system for generating onboarding PRs that add
 * Generacy configuration and dev container setup to user repositories.
 *
 * Templates support both single-repo and multi-repo projects using Handlebars
 * for variable substitution and conditional logic.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { buildSingleRepoContext, renderProject } from '@generacy-ai/templates';
 *
 * // Build context for a single-repo project
 * const context = buildSingleRepoContext({
 *   projectId: 'proj_abc123',
 *   projectName: 'My API',
 *   primaryRepo: 'acme/main-api',
 *   releaseStream: 'stable',
 * });
 *
 * // Render all templates
 * const files = await renderProject(context);
 *
 * // Write files to disk
 * for (const [path, content] of files) {
 *   await writeFile(path, content);
 * }
 * ```
 */

// ============================================================================
// Renderer Exports
// ============================================================================

/**
 * Render all templates for a project
 *
 * Returns a Map of target file paths to rendered content. The caller is
 * responsible for writing files to disk (allows for dry-run, validation, etc).
 *
 * @param context - Template context containing all variables for rendering
 * @param existingFiles - Optional map of existing file content for merging (e.g., extensions.json)
 * @returns Map of target paths to rendered content
 * @throws Error if any template fails to render or validate
 *
 * @example
 * ```typescript
 * const files = await renderProject(context);
 * console.log(`Generated ${files.size} files`);
 * for (const [path, content] of files) {
 *   console.log(`  ${path}: ${content.length} bytes`);
 * }
 * ```
 */
export { renderProject } from './renderer.js';

/**
 * Render a single template with context
 *
 * @param templatePath - Path to template file (relative to templates directory)
 * @param context - Template context object
 * @returns Rendered template content
 * @throws Error if template cannot be loaded or rendered
 *
 * @example
 * ```typescript
 * const yaml = await renderTemplate('shared/config.yaml.hbs', context);
 * console.log(yaml);
 * ```
 */
export { renderTemplate } from './renderer.js';

/**
 * Render extensions.json with smart merging
 *
 * If existing extensions.json content is provided, merges Generacy extensions
 * into the existing recommendations array. Otherwise, creates a new file.
 *
 * @param context - Template context
 * @param existingContent - Existing extensions.json content (optional)
 * @returns Rendered extensions.json content
 * @throws Error if existing content is invalid JSON
 *
 * @example
 * ```typescript
 * // Create new extensions.json
 * const newFile = await renderExtensionsJson(context);
 *
 * // Merge with existing extensions.json
 * const existing = await readFile('.vscode/extensions.json', 'utf-8');
 * const merged = await renderExtensionsJson(context, existing);
 * ```
 */
export { renderExtensionsJson } from './renderer.js';

/**
 * Load template file from disk
 *
 * @param templatePath - Path relative to templates directory (e.g., "shared/config.yaml.hbs")
 * @returns Template content as string
 * @throws Error if template file cannot be read
 *
 * @example
 * ```typescript
 * const template = await loadTemplate('shared/config.yaml.hbs');
 * ```
 */
export { loadTemplate } from './renderer.js';

/**
 * Select templates to render based on project context
 *
 * @param context - Template context
 * @returns Array of template information for rendering
 *
 * @example
 * ```typescript
 * const templates = selectTemplates(context);
 * console.log(`Will render ${templates.length} templates`);
 * ```
 */
export { selectTemplates } from './renderer.js';

/**
 * Get list of all template paths that would be rendered
 *
 * Useful for documentation, testing, or validation
 *
 * @param context - Template context
 * @returns Array of template paths
 *
 * @example
 * ```typescript
 * const paths = getTemplatePaths(context);
 * console.log('Templates:', paths);
 * ```
 */
export { getTemplatePaths } from './renderer.js';

/**
 * Get list of all target paths that would be generated
 *
 * Useful for documentation, testing, or validation
 *
 * @param context - Template context
 * @returns Array of target file paths
 *
 * @example
 * ```typescript
 * const targets = getTargetPaths(context);
 * console.log('Will generate:', targets);
 * ```
 */
export { getTargetPaths } from './renderer.js';

/**
 * Get mapping of template paths to target paths
 *
 * @param context - Template context
 * @returns Map of template paths to target paths
 *
 * @example
 * ```typescript
 * const mapping = getTemplateMapping(context);
 * for (const [template, target] of mapping) {
 *   console.log(`${template} -> ${target}`);
 * }
 * ```
 */
export { getTemplateMapping } from './renderer.js';

// ============================================================================
// Validator Exports
// ============================================================================

/**
 * Validate template context against schema
 *
 * Uses Zod schema validation to ensure all required fields are present
 * and have correct types before rendering templates.
 *
 * @param context - Unknown context object to validate
 * @returns Validated and typed TemplateContext
 * @throws ValidationError with detailed error messages if validation fails
 *
 * @example
 * ```typescript
 * try {
 *   const validContext = validateContext(userInput);
 *   // Safe to use validContext for rendering
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     console.error('Validation failed:');
 *     error.errors.forEach(e => console.error(`  ${e.path}: ${e.message}`));
 *   }
 * }
 * ```
 */
export { validateContext } from './validators.js';

/**
 * Validate rendered config.yaml content
 *
 * Parses YAML and checks for required fields to ensure the template
 * rendered correctly.
 *
 * @param yamlContent - Rendered YAML content
 * @throws Error if YAML is invalid or missing required fields
 *
 * @example
 * ```typescript
 * const rendered = await renderTemplate('shared/config.yaml.hbs', context);
 * validateRenderedConfig(rendered); // Throws if invalid
 * ```
 */
export { validateRenderedConfig } from './validators.js';

/**
 * Validate rendered devcontainer.json content
 *
 * Parses JSON and checks for required fields based on single-repo
 * or multi-repo configuration.
 *
 * @param jsonContent - Rendered JSON content
 * @throws Error if JSON is invalid or missing required fields
 *
 * @example
 * ```typescript
 * const rendered = await renderTemplate('single-repo/devcontainer.json.hbs', context);
 * validateRenderedDevContainer(rendered); // Throws if invalid
 * ```
 */
export { validateRenderedDevContainer } from './validators.js';

/**
 * Validate rendered docker-compose.yml content
 *
 * Parses YAML and checks for required services and configuration
 * for multi-repo projects.
 *
 * @param yamlContent - Rendered YAML content
 * @throws Error if YAML is invalid or missing required services
 *
 * @example
 * ```typescript
 * const rendered = await renderTemplate('multi-repo/docker-compose.yml.hbs', context);
 * validateRenderedDockerCompose(rendered); // Throws if invalid
 * ```
 */
export { validateRenderedDockerCompose } from './validators.js';

/**
 * Validate rendered extensions.json content
 *
 * Parses JSON and checks that Generacy extensions are included.
 *
 * @param jsonContent - Rendered JSON content
 * @throws Error if JSON is invalid or missing Generacy extensions
 *
 * @example
 * ```typescript
 * const rendered = await renderExtensionsJson(context);
 * validateRenderedExtensionsJson(rendered); // Throws if invalid
 * ```
 */
export { validateRenderedExtensionsJson } from './validators.js';

/**
 * Validate rendered .env.template content
 *
 * Checks that the environment template is non-empty and contains
 * required variable placeholders for cluster operation.
 *
 * @param content - Rendered .env.template content
 * @throws Error if content is empty or missing required variables
 */
export { validateRenderedEnvTemplate } from './validators.js';

/**
 * Validate all rendered files from renderProject output
 *
 * Applies appropriate validation to each file based on its type.
 *
 * @param files - Map of file paths to rendered content
 * @throws Error if any file fails validation
 *
 * @example
 * ```typescript
 * const files = await renderProject(context);
 * validateAllRenderedFiles(files); // Throws on first validation error
 * ```
 */
export { validateAllRenderedFiles } from './validators.js';

/**
 * Check if rendered content contains undefined template variables
 *
 * Helps catch cases where template variables weren't substituted correctly.
 *
 * @param content - Rendered template content
 * @returns Array of undefined variable names found (empty if none)
 *
 * @example
 * ```typescript
 * const rendered = await renderTemplate('config.yaml.hbs', context);
 * const undefined = findUndefinedVariables(rendered);
 * if (undefined.length > 0) {
 *   console.warn(`Template has undefined variables: ${undefined.join(', ')}`);
 * }
 * ```
 */
export { findUndefinedVariables } from './validators.js';

/**
 * Validation error with user-friendly formatting
 *
 * Thrown by validateContext when the template context fails schema validation.
 * Contains detailed error messages with field paths.
 *
 * @example
 * ```typescript
 * try {
 *   validateContext(invalidInput);
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     // Access structured errors
 *     error.errors.forEach(e => {
 *       console.log(`${e.path}: ${e.message}`);
 *     });
 *   }
 * }
 * ```
 */
export { ValidationError } from './validators.js';

// ============================================================================
// Builder Exports
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
export { buildSingleRepoContext } from './builders.js';

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
export { buildMultiRepoContext } from './builders.js';

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
export { withGeneratedBy } from './builders.js';

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
export { withBaseImage } from './builders.js';

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
export { withBaseBranch } from './builders.js';

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
export { withOrchestrator } from './builders.js';

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
export { withVariant } from './builders.js';

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
 * const files = await renderProject(context);
 * ```
 */
export { quickSingleRepo } from './builders.js';

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
 * const files = await renderProject(context);
 * ```
 */
export { quickMultiRepo } from './builders.js';

// ============================================================================
// Type Exports
// ============================================================================

/**
 * Complete context passed to template renderer
 * All templates receive this full context structure
 */
export type { TemplateContext } from './schema.js';

/**
 * Project metadata
 */
export type { ProjectContext } from './schema.js';

/**
 * Repository configuration
 * Uses GitHub shorthand format: "owner/repo"
 */
export type { ReposContext } from './schema.js';

/**
 * Default settings for the project
 */
export type { DefaultsContext } from './schema.js';

/**
 * Orchestrator configuration (multi-repo only)
 */
export type { OrchestratorContext } from './schema.js';

/**
 * Dev Container configuration
 */
export type { DevContainerContext } from './schema.js';

/**
 * Template generation metadata
 */
export type { MetadataContext } from './schema.js';

/**
 * Input for building single-repo template context
 */
export type { SingleRepoInput } from './schema.js';

/**
 * Input for building multi-repo template context
 */
export type { MultiRepoInput } from './schema.js';

/**
 * VS Code extensions.json schema
 */
export type { ExtensionsJson } from './schema.js';

/**
 * Optional front matter for template files
 */
export type { TemplateMetadata } from './schema.js';

/**
 * Migration function for updating context between schema versions
 */
export type { TemplateMigration } from './schema.js';

/**
 * Result of context validation
 */
export type { ValidationResult } from './schema.js';

/**
 * Map of target file paths to rendered content
 *
 * @example
 * {
 *   '.generacy/config.yaml': '...',
 *   '.devcontainer/devcontainer.json': '...',
 * }
 */
export type { RenderedFileMap } from './schema.js';

/**
 * Template information for rendering
 */
export type { TemplateInfo } from './schema.js';

/**
 * Type of project (determines template selection)
 */
export type { ProjectType } from './schema.js';

/**
 * Cluster variant type: 'standard' (DooD) or 'microservices' (DinD)
 */
export type { ClusterVariant } from './schema.js';

/**
 * Cluster configuration context
 */
export type { ClusterContext } from './schema.js';

/**
 * Generacy's required VS Code extensions
 *
 * @constant
 * @example
 * ['generacy-ai.agency', 'generacy-ai.generacy']
 */
export { GENERACY_EXTENSIONS } from './schema.js';

// ============================================================================
// Schema Exports (for advanced usage)
// ============================================================================

/**
 * Zod schema for complete template context
 *
 * Export schemas for consumers who need to do their own validation
 * or extend the schema for custom use cases.
 */
export {
  TemplateContextSchema,
  ProjectContextSchema,
  ReposContextSchema,
  DefaultsContextSchema,
  OrchestratorContextSchema,
  DevContainerContextSchema,
  MetadataContextSchema,
  SingleRepoInputSchema,
  MultiRepoInputSchema,
  ExtensionsJsonSchema,
  TemplateMetadataSchema,
  ClusterVariantSchema,
  ClusterContextSchema,
} from './schema.js';
