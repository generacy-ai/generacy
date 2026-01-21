/**
 * Schema loader for Generacy workflow YAML files.
 * Registers the workflow schema with the YAML extension for IntelliSense support.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { getLogger } from '../utils';
import { WORKFLOW_FILE_PATTERNS } from '../constants';

/**
 * Schema configuration for the YAML extension
 */
interface YamlSchemaSettings {
  [schemaUri: string]: string | string[];
}

/**
 * Gets the URI of the workflow schema file bundled with the extension
 */
export function getWorkflowSchemaUri(context: vscode.ExtensionContext): string {
  const schemaPath = path.join(context.extensionPath, 'schemas', 'workflow.schema.json');
  return vscode.Uri.file(schemaPath).toString();
}

/**
 * Registers the workflow schema with the YAML extension.
 * This enables IntelliSense, validation, and hover documentation for workflow files.
 */
export async function registerWorkflowSchema(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();
  const schemaUri = getWorkflowSchemaUri(context);

  logger.info('Registering workflow schema with YAML extension');
  logger.debug(`Schema URI: ${schemaUri}`);

  // Get the file patterns to associate with the schema
  const filePatterns = [
    WORKFLOW_FILE_PATTERNS.yaml,
    WORKFLOW_FILE_PATTERNS.yml,
    // Also match files with .generacy.yaml/.generacy.yml extensions
    '**/*.generacy.yaml',
    '**/*.generacy.yml',
  ];

  // Try to configure the Red Hat YAML extension
  const yamlExtension = vscode.extensions.getExtension('redhat.vscode-yaml');

  if (yamlExtension) {
    logger.info('Red Hat YAML extension found');

    // Wait for the extension to activate if it hasn't already
    if (!yamlExtension.isActive) {
      logger.debug('Waiting for YAML extension to activate');
      await yamlExtension.activate();
    }

    // Configure schema via workspace settings
    await configureSchemaInSettings(schemaUri, filePatterns);

    // Also try to use the YAML extension API if available
    await registerSchemaViaApi(yamlExtension, schemaUri, filePatterns);
  } else {
    logger.warn('Red Hat YAML extension not found. Schema validation will be limited.');
    logger.info('Install the "YAML" extension by Red Hat for full IntelliSense support.');

    // Still configure settings in case the extension is installed later
    await configureSchemaInSettings(schemaUri, filePatterns);
  }
}

/**
 * Configures the schema in VS Code workspace settings.
 * This is the standard way to associate schemas with file patterns.
 */
async function configureSchemaInSettings(schemaUri: string, filePatterns: string[]): Promise<void> {
  const logger = getLogger();
  const config = vscode.workspace.getConfiguration('yaml');

  // Get current schema associations
  const currentSchemas = config.get<YamlSchemaSettings>('schemas') ?? {};

  // Check if our schema is already configured
  const existingPatterns = currentSchemas[schemaUri];
  if (existingPatterns) {
    const existingArray = Array.isArray(existingPatterns) ? existingPatterns : [existingPatterns];
    const allPatternsPresent = filePatterns.every((p) => existingArray.includes(p));
    if (allPatternsPresent) {
      logger.debug('Schema already configured in settings');
      return;
    }
  }

  // Update the schema configuration
  const updatedSchemas: YamlSchemaSettings = {
    ...currentSchemas,
    [schemaUri]: filePatterns,
  };

  try {
    await config.update('schemas', updatedSchemas, vscode.ConfigurationTarget.Workspace);
    logger.info('Schema configuration updated in workspace settings');
  } catch (error) {
    // This can fail if there's no workspace folder
    logger.debug('Could not update workspace settings, trying global settings');
    try {
      await config.update('schemas', updatedSchemas, vscode.ConfigurationTarget.Global);
      logger.info('Schema configuration updated in global settings');
    } catch (globalError) {
      logger.warn('Could not configure schema in settings', globalError as Error);
    }
  }
}

/**
 * Attempts to register the schema via the YAML extension's API.
 * This provides dynamic schema registration without modifying settings.
 */
async function registerSchemaViaApi(
  yamlExtension: vscode.Extension<unknown>,
  schemaUri: string,
  filePatterns: string[]
): Promise<void> {
  const logger = getLogger();

  try {
    // The YAML extension may expose a schema registration API
    const api = yamlExtension.exports as {
      registerContributor?: (
        schemaContent: string,
        requestSchema: (resource: string) => string | null,
        requestSchemaContent: (uri: string) => string | null,
        label?: string
      ) => void;
    } | undefined;

    if (api?.registerContributor) {
      logger.debug('Using YAML extension contributor API');

      // Create a schema request handler
      api.registerContributor(
        'generacy', // Contributor ID
        (resource: string): string | null => {
          // Check if the resource matches our file patterns
          for (const pattern of filePatterns) {
            if (matchesGlobPattern(resource, pattern)) {
              return schemaUri;
            }
          }
          return null;
        },
        (_uri: string): string | null => {
          // We don't need to provide schema content dynamically
          // The schema file is bundled with the extension
          return null;
        },
        'Generacy Workflow Schema'
      );

      logger.info('Registered schema via YAML extension API');
    } else {
      logger.debug('YAML extension API not available, using settings-based configuration');
    }
  } catch (error) {
    logger.debug('Could not use YAML extension API', error as Error);
  }
}

/**
 * Simple glob pattern matching for file paths.
 * Supports ** for recursive matching and * for single segment matching.
 */
function matchesGlobPattern(filePath: string, pattern: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Convert glob pattern to regex
  const regexPattern = normalizedPattern
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*\*/g, '{{DOUBLE_STAR}}') // Temporarily replace **
    .replace(/\*/g, '[^/]*') // * matches any character except /
    .replace(/{{DOUBLE_STAR}}/g, '.*'); // ** matches anything including /

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(normalizedPath);
}

/**
 * Unregisters the workflow schema (for cleanup on deactivation).
 * Note: VS Code doesn't provide a clean way to unregister schemas,
 * so this is a best-effort cleanup.
 */
export async function unregisterWorkflowSchema(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();
  const schemaUri = getWorkflowSchemaUri(context);

  logger.debug('Unregistering workflow schema');

  try {
    const config = vscode.workspace.getConfiguration('yaml');
    const currentSchemas = config.get<YamlSchemaSettings>('schemas') ?? {};

    if (schemaUri in currentSchemas) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [schemaUri]: _, ...remainingSchemas } = currentSchemas;
      await config.update('schemas', remainingSchemas, vscode.ConfigurationTarget.Workspace);
      logger.info('Schema unregistered from workspace settings');
    }
  } catch (error) {
    logger.debug('Could not unregister schema', error as Error);
  }
}

/**
 * Checks if the YAML extension is installed and provides schema support
 */
export function isYamlExtensionAvailable(): boolean {
  return vscode.extensions.getExtension('redhat.vscode-yaml') !== undefined;
}

/**
 * Gets the recommended extensions for full workflow editing support
 */
export function getRecommendedExtensions(): Array<{ id: string; name: string; description: string }> {
  return [
    {
      id: 'redhat.vscode-yaml',
      name: 'YAML',
      description: 'Provides IntelliSense, validation, and formatting for YAML files',
    },
  ];
}

/**
 * Prompts the user to install recommended extensions if not present
 */
export async function promptForRecommendedExtensions(): Promise<void> {
  const logger = getLogger();
  const missing = getRecommendedExtensions().filter(
    (ext) => !vscode.extensions.getExtension(ext.id)
  );

  if (missing.length === 0) {
    return;
  }

  logger.info(`Missing recommended extensions: ${missing.map((e) => e.name).join(', ')}`);

  const message = `For the best Generacy workflow editing experience, we recommend installing: ${missing.map((e) => e.name).join(', ')}`;
  const action = 'Install Extensions';
  const dismiss = 'Dismiss';

  const selection = await vscode.window.showInformationMessage(message, action, dismiss);

  if (selection === action) {
    for (const ext of missing) {
      await vscode.commands.executeCommand('extension.open', ext.id);
    }
  }
}
