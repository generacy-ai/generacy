/**
 * Validation functions for template context and rendered output
 *
 * Provides both pre-render validation (Zod schema checking) and
 * post-render validation (YAML/JSON parsing and structure validation).
 */

import { ZodError } from 'zod';
import yaml from 'js-yaml';
import { TemplateContextSchema, type TemplateContext } from './schema.js';

// ============================================================================
// Pre-Render Validation
// ============================================================================

/**
 * Validation error with user-friendly formatting
 *
 * Custom error class for template context validation failures.
 * Provides structured error information with field paths and messages.
 *
 * @example
 * ```typescript
 * try {
 *   validateContext(invalidData);
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     console.error(error.message);
 *     error.errors.forEach(e => {
 *       console.error(`  ${e.path}: ${e.message}`);
 *     });
 *   }
 * }
 * ```
 */
export class ValidationError extends Error {
  /**
   * Create a new ValidationError
   *
   * @param message - Human-readable error summary
   * @param errors - Array of detailed error objects with path and message
   */
  constructor(
    message: string,
    public readonly errors: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Format Zod errors into readable error messages
 *
 * Transforms Zod's internal error format into a simpler structure
 * with dot-notation paths and human-readable messages.
 *
 * @param error - Zod validation error from schema.parse()
 * @returns Array of formatted error objects with path and message
 *
 * @example
 * ```typescript
 * // Input: ZodError with path ['project', 'id'] and message "Required"
 * // Output: [{ path: 'project.id', message: 'Required' }]
 * ```
 */
function formatZodErrors(
  error: ZodError
): Array<{ path: string; message: string }> {
  return error.errors.map((err) => ({
    path: err.path.join('.'),
    message: err.message,
  }));
}

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
export function validateContext(context: unknown): TemplateContext {
  try {
    // Parse with Zod schema
    const validated = TemplateContextSchema.parse(context);
    return validated;
  } catch (error) {
    if (error instanceof ZodError) {
      const formattedErrors = formatZodErrors(error);

      // Build user-friendly error message
      const errorMessages = formattedErrors
        .map((e) => `  - ${e.path}: ${e.message}`)
        .join('\n');

      const message = `Template context validation failed:\n${errorMessages}`;

      throw new ValidationError(message, formattedErrors);
    }

    // Re-throw unexpected errors
    throw error;
  }
}

// ============================================================================
// Post-Render Validation
// ============================================================================

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
export function validateRenderedConfig(yamlContent: string): void {
  let parsed: any;

  try {
    parsed = yaml.load(yamlContent);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown YAML parsing error';
    throw new Error(`Invalid YAML in config.yaml: ${message}`);
  }

  // Check for required top-level fields
  const required = ['project', 'repos'];
  const missing: string[] = [];

  for (const field of required) {
    if (!parsed || typeof parsed !== 'object' || !(field in parsed)) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `config.yaml missing required fields: ${missing.join(', ')}`
    );
  }

  // Check project.id exists
  if (
    !parsed.project ||
    typeof parsed.project !== 'object' ||
    !parsed.project.id
  ) {
    throw new Error('config.yaml missing required field: project.id');
  }

  // Check repos.primary exists
  if (
    !parsed.repos ||
    typeof parsed.repos !== 'object' ||
    !parsed.repos.primary
  ) {
    throw new Error('config.yaml missing required field: repos.primary');
  }

  // If isMultiRepo is true, orchestrator config should exist
  if (parsed.repos.isMultiRepo === true) {
    if (!parsed.orchestrator || typeof parsed.orchestrator !== 'object') {
      throw new Error(
        'config.yaml for multi-repo project missing orchestrator configuration'
      );
    }
  }
}

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
export function validateRenderedDevContainer(jsonContent: string): void {
  let parsed: any;

  try {
    parsed = JSON.parse(jsonContent);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown JSON parsing error';
    throw new Error(`Invalid JSON in devcontainer.json: ${message}`);
  }

  // Check for required name field
  if (!parsed || typeof parsed !== 'object' || !parsed.name) {
    throw new Error('devcontainer.json missing required field: name');
  }

  // Must have either 'image' (single-repo) or 'dockerComposeFile' (multi-repo)
  const hasImage = 'image' in parsed && parsed.image;
  const hasDockerCompose =
    'dockerComposeFile' in parsed && parsed.dockerComposeFile;

  if (!hasImage && !hasDockerCompose) {
    throw new Error(
      'devcontainer.json must have either "image" (single-repo) or "dockerComposeFile" (multi-repo)'
    );
  }

  // If using docker-compose, must have service name
  if (hasDockerCompose && !parsed.service) {
    throw new Error(
      'devcontainer.json with dockerComposeFile must specify "service" name'
    );
  }

  // Check for features or customizations (at least one should exist)
  const hasFeatures = parsed.features && typeof parsed.features === 'object';
  const hasCustomizations =
    parsed.customizations && typeof parsed.customizations === 'object';

  if (!hasFeatures && !hasCustomizations) {
    // This is a warning scenario, but for strict validation we can throw
    // Comment out the throw if you want to allow minimal devcontainers
    throw new Error(
      'devcontainer.json should have either "features" or "customizations"'
    );
  }

  // Validate features contain Generacy feature (if features exist)
  if (hasFeatures) {
    const featureKeys = Object.keys(parsed.features);
    const hasGeneracyFeature = featureKeys.some((key) =>
      /generacy-ai\/.*\/generacy/.test(key)
    );

    if (!hasGeneracyFeature) {
      throw new Error(
        'devcontainer.json features should include Generacy Dev Container Feature'
      );
    }
  }
}

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
export function validateRenderedDockerCompose(yamlContent: string): void {
  let parsed: any;

  try {
    parsed = yaml.load(yamlContent);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown YAML parsing error';
    throw new Error(`Invalid YAML in docker-compose.yml: ${message}`);
  }

  // Check for services section
  if (!parsed || typeof parsed !== 'object' || !parsed.services) {
    throw new Error('docker-compose.yml missing "services" section');
  }

  const services = parsed.services;

  // Required services for multi-repo setup
  const requiredServices = ['redis', 'orchestrator', 'worker'];
  const missing: string[] = [];

  for (const service of requiredServices) {
    if (!(service in services)) {
      missing.push(service);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `docker-compose.yml missing required services: ${missing.join(', ')}`
    );
  }

  // Validate orchestrator has required configuration
  const orchestrator = services.orchestrator;
  if (!orchestrator || typeof orchestrator !== 'object') {
    throw new Error('docker-compose.yml orchestrator service is malformed');
  }

  // Check for image or build
  if (!orchestrator.image && !orchestrator.build) {
    throw new Error(
      'docker-compose.yml orchestrator service must specify "image" or "build"'
    );
  }

  // Validate Redis service
  const redis = services.redis;
  if (!redis || typeof redis !== 'object' || !redis.image) {
    throw new Error('docker-compose.yml redis service must specify "image"');
  }
}

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
export function validateRenderedExtensionsJson(jsonContent: string): void {
  let parsed: any;

  try {
    parsed = JSON.parse(jsonContent);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown JSON parsing error';
    throw new Error(`Invalid JSON in extensions.json: ${message}`);
  }

  // Check for recommendations array
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.recommendations)) {
    throw new Error('extensions.json must have "recommendations" array');
  }

  // Check that Generacy extensions are included
  const recommendations: string[] = parsed.recommendations;
  const hasAgency = recommendations.includes('generacy-ai.agency');
  const hasGeneracy = recommendations.includes('generacy-ai.generacy');

  if (!hasAgency) {
    throw new Error(
      'extensions.json recommendations missing "generacy-ai.agency"'
    );
  }

  if (!hasGeneracy) {
    throw new Error(
      'extensions.json recommendations missing "generacy-ai.generacy"'
    );
  }
}

// ============================================================================
// Validation Helpers
// ============================================================================

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
export function findUndefinedVariables(content: string): string[] {
  // Match Handlebars syntax: {{variableName}} or {{{variableName}}}
  const pattern = /\{\{?\{?\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}?\}?\}/g;
  const matches = content.matchAll(pattern);

  const undefinedVars: string[] = [];

  for (const match of matches) {
    const varName = match[1];
    if (varName) {
      // Check if this looks like an unrendered variable
      // Rendered content shouldn't have {{ }} syntax
      if (match[0].includes('{{')) {
        undefinedVars.push(varName);
      }
    }
  }

  // Return unique variable names
  return [...new Set(undefinedVars)];
}

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
export function validateAllRenderedFiles(
  files: Map<string, string>
): void {
  for (const [path, content] of files) {
    try {
      // Apply appropriate validator based on file path
      if (path.endsWith('config.yaml')) {
        validateRenderedConfig(content);
      } else if (path.endsWith('devcontainer.json')) {
        validateRenderedDevContainer(content);
      } else if (path.endsWith('docker-compose.yml')) {
        validateRenderedDockerCompose(content);
      } else if (path.endsWith('extensions.json')) {
        validateRenderedExtensionsJson(content);
      }

      // Check for undefined variables in all files
      const undefinedVars = findUndefinedVariables(content);
      if (undefinedVars.length > 0) {
        throw new Error(
          `File contains unrendered template variables: ${undefinedVars.join(', ')}`
        );
      }
    } catch (error) {
      // Add file path context to error
      if (error instanceof Error) {
        throw new Error(`Validation failed for ${path}: ${error.message}`);
      }
      throw new Error(`Validation failed for ${path}: Unknown error`);
    }
  }
}
