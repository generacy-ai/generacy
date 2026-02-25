/**
 * Template rendering engine
 *
 * Handles Handlebars template loading, rendering, and special cases
 * like extensions.json merging and static file copying.
 */

import Handlebars from 'handlebars';
import { readFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type {
  TemplateContext,
  RenderedFileMap,
  TemplateInfo,
  ExtensionsJson,
} from './schema.js';
import { GENERACY_EXTENSIONS } from './schema.js';

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Template root directory - templates are in src/, not dist/
// When running from dist/renderer.js, __dirname will be .../dist
// We need to go back to the package root and then into src
const isInDist = __dirname.endsWith('dist') || __dirname.includes('/dist/');
const TEMPLATES_ROOT = isInDist
  ? join(__dirname, '..', 'src')
  : __dirname;

// ============================================================================
// Handlebars Helper Registration
// ============================================================================

/**
 * Register custom Handlebars helpers
 *
 * Registers template helpers that can be used in .hbs files:
 * - repoName: Extract repository name from "owner/repo" format
 * - json: Pretty-print objects as JSON
 * - urlEncode: URL-encode strings
 * - eq: Strict equality comparison for conditionals
 *
 * Called automatically when module is imported.
 *
 * @example
 * ```handlebars
 * {{repoName repos.primary}}  // "main-api" from "acme/main-api"
 * {{json project}}             // Pretty-printed JSON
 * {{urlEncode project.name}}   // URL-safe string
 * {{#if (eq defaults.releaseStream "stable")}}...{{/if}}
 * ```
 */
function registerHelpers(): void {
  /**
   * Extract repository name from shorthand format
   *
   * @param shorthand - Repository in "owner/repo" format
   * @returns Repository name (the part after /)
   * @example {{repoName "acme/main-api"}} → "main-api"
   */
  Handlebars.registerHelper('repoName', (shorthand: unknown): string => {
    if (typeof shorthand !== 'string' || !shorthand) {
      return '';
    }
    const parts = shorthand.split('/');
    return parts.length === 2 ? parts[1] ?? '' : shorthand;
  });

  /**
   * Pretty-print JSON object
   *
   * @param obj - Any object to serialize
   * @returns Formatted JSON string with 2-space indentation
   * @example {{json project}} → formatted JSON
   */
  Handlebars.registerHelper('json', (obj: unknown): string => {
    return JSON.stringify(obj, null, 2);
  });

  /**
   * URL encode a string
   *
   * @param str - String to encode
   * @returns URL-encoded string
   * @example {{urlEncode "string with spaces"}} → "string%20with%20spaces"
   */
  Handlebars.registerHelper('urlEncode', (str: unknown): string => {
    if (!str || typeof str !== 'string') {
      return '';
    }
    return encodeURIComponent(str);
  });

  /**
   * Strict equality check helper
   *
   * Provides reliable equality comparison in templates.
   * Built-in eq doesn't always work as expected.
   *
   * @param a - First value to compare
   * @param b - Second value to compare
   * @returns True if values are strictly equal (===)
   * @example {{#if (eq value "test")}}...{{/if}}
   */
  Handlebars.registerHelper('eq', (a: unknown, b: unknown): boolean => {
    return a === b;
  });
}

// Register helpers on module load
registerHelpers();

// ============================================================================
// Template Loading
// ============================================================================

/**
 * Load template file from disk
 *
 * @param templatePath - Path relative to templates directory (e.g., "shared/config.yaml.hbs")
 * @returns Template content as string
 * @throws Error if template file cannot be read
 */
export async function loadTemplate(templatePath: string): Promise<string> {
  try {
    const fullPath = resolve(TEMPLATES_ROOT, templatePath);
    const content = await readFile(fullPath, 'utf-8');
    return content;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to load template "${templatePath}": ${error.message}`
      );
    }
    throw new Error(`Failed to load template "${templatePath}": Unknown error`);
  }
}

/**
 * Check if a file is a static file (no Handlebars rendering needed)
 *
 * Static files are copied as-is without template variable substitution.
 * These are identified by the absence of the .hbs extension.
 *
 * @param templatePath - Template path to check
 * @returns True if file should be copied without rendering
 *
 * @example
 * ```typescript
 * isStaticFile('shared/gitignore.template')     // true
 * isStaticFile('shared/config.yaml.hbs') // false
 * ```
 */
function isStaticFile(templatePath: string): boolean {
  // Static files don't have .hbs extension
  return !templatePath.endsWith('.hbs');
}

// ============================================================================
// Template Selection
// ============================================================================

/**
 * Select templates to render based on project context
 *
 * @param context - Template context
 * @returns Array of template information for rendering
 */
export function selectTemplates(context: TemplateContext): TemplateInfo[] {
  const templates: TemplateInfo[] = [
    // Shared templates (always included)
    {
      templatePath: 'shared/config.yaml.hbs',
      targetPath: '.generacy/config.yaml',
      requiresMerge: false,
      isStatic: false,
    },
    {
      templatePath: 'shared/generacy.env.template.hbs',
      targetPath: '.generacy/generacy.env.template',
      requiresMerge: false,
      isStatic: false,
    },
    {
      templatePath: 'shared/gitignore.template',
      targetPath: '.generacy/.gitignore',
      requiresMerge: false,
      isStatic: true,
    },
    {
      templatePath: 'shared/extensions.json.hbs',
      targetPath: '.vscode/extensions.json',
      requiresMerge: true, // Special handling for merge
      isStatic: false,
    },
  ];

  // Add type-specific templates
  if (context.repos.isMultiRepo) {
    templates.push(
      {
        templatePath: 'multi-repo/devcontainer.json.hbs',
        targetPath: '.devcontainer/devcontainer.json',
        requiresMerge: false,
        isStatic: false,
      },
      {
        templatePath: 'multi-repo/docker-compose.yml.hbs',
        targetPath: '.devcontainer/docker-compose.yml',
        requiresMerge: false,
        isStatic: false,
      }
    );
  } else {
    templates.push({
      templatePath: 'single-repo/devcontainer.json.hbs',
      targetPath: '.devcontainer/devcontainer.json',
      requiresMerge: false,
      isStatic: false,
    });
  }

  return templates;
}

// ============================================================================
// Template Rendering
// ============================================================================

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
 * ```
 */
export async function renderTemplate(
  templatePath: string,
  context: TemplateContext
): Promise<string> {
  try {
    // Load template content
    const templateContent = await loadTemplate(templatePath);

    // If static file, return as-is
    if (isStaticFile(templatePath)) {
      return templateContent;
    }

    // Compile and render with Handlebars
    const template = Handlebars.compile(templateContent, {
      strict: true, // Throw on undefined variables
      noEscape: false, // Allow HTML escaping (safer default)
    });

    const rendered = template(context);

    return rendered;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to render template "${templatePath}": ${error.message}`
      );
    }
    throw new Error(
      `Failed to render template "${templatePath}": Unknown error`
    );
  }
}

// ============================================================================
// Extensions.json Special Handling
// ============================================================================

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
 * // Create new
 * const newFile = await renderExtensionsJson(context);
 *
 * // Merge with existing
 * const merged = await renderExtensionsJson(context, existingJson);
 * ```
 */
export async function renderExtensionsJson(
  context: TemplateContext,
  existingContent?: string
): Promise<string> {
  try {
    // If no existing content, render template as-is
    if (!existingContent) {
      return await renderTemplate('shared/extensions.json.hbs', context);
    }

    // Parse existing content
    let existing: ExtensionsJson;
    try {
      existing = JSON.parse(existingContent) as ExtensionsJson;
    } catch (parseError) {
      throw new Error(
        `Invalid JSON in existing extensions.json: ${
          parseError instanceof Error ? parseError.message : 'Parse error'
        }`
      );
    }

    // Ensure recommendations array exists
    const existingRecommendations = existing.recommendations || [];

    // Merge recommendations using Set to deduplicate
    const mergedRecommendations = [
      ...new Set([...existingRecommendations, ...GENERACY_EXTENSIONS]),
    ];

    // Build merged object, preserving other properties
    const merged: ExtensionsJson = {
      ...existing,
      recommendations: mergedRecommendations,
    };

    // Return formatted JSON
    return JSON.stringify(merged, null, 2) + '\n';
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to render extensions.json: ${error.message}`);
    }
    throw new Error('Failed to render extensions.json: Unknown error');
  }
}

// ============================================================================
// Project Rendering
// ============================================================================

/**
 * Render all templates for a project
 *
 * Returns a Map of target file paths to rendered content. The caller is
 * responsible for writing files to disk (allows for dry-run, validation, etc).
 *
 * @param context - Template context
 * @param existingFiles - Optional map of existing file content for merging
 * @returns Map of target paths to rendered content
 * @throws Error if any template fails to render
 *
 * @example
 * ```typescript
 * const files = await renderProject(context);
 * for (const [path, content] of files) {
 *   console.log(`${path}: ${content.length} bytes`);
 * }
 * ```
 */
export async function renderProject(
  context: TemplateContext,
  existingFiles?: Map<string, string>
): Promise<RenderedFileMap> {
  const fileMap: RenderedFileMap = new Map();
  const templates = selectTemplates(context);

  // Render all templates
  for (const templateInfo of templates) {
    const { templatePath, targetPath, requiresMerge } = templateInfo;

    try {
      let content: string;

      // Handle special merge case for extensions.json
      if (requiresMerge && targetPath === '.vscode/extensions.json') {
        const existingContent = existingFiles?.get(targetPath);
        content = await renderExtensionsJson(context, existingContent);
      } else {
        // Normal template rendering
        content = await renderTemplate(templatePath, context);
      }

      fileMap.set(targetPath, content);
    } catch (error) {
      // Re-throw with context about which file failed
      if (error instanceof Error) {
        throw new Error(
          `Failed to render ${targetPath} (template: ${templatePath}): ${error.message}`
        );
      }
      throw new Error(
        `Failed to render ${targetPath} (template: ${templatePath}): Unknown error`
      );
    }
  }

  return fileMap;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get list of all template paths that would be rendered
 *
 * Useful for documentation, testing, or validation
 *
 * @param context - Template context
 * @returns Array of template paths
 */
export function getTemplatePaths(context: TemplateContext): string[] {
  return selectTemplates(context).map((t) => t.templatePath);
}

/**
 * Get list of all target paths that would be generated
 *
 * Useful for documentation, testing, or validation
 *
 * @param context - Template context
 * @returns Array of target file paths
 */
export function getTargetPaths(context: TemplateContext): string[] {
  return selectTemplates(context).map((t) => t.targetPath);
}

/**
 * Get mapping of template paths to target paths
 *
 * @param context - Template context
 * @returns Map of template paths to target paths
 */
export function getTemplateMapping(
  context: TemplateContext
): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const template of selectTemplates(context)) {
    mapping.set(template.templatePath, template.targetPath);
  }
  return mapping;
}
