import * as vscode from 'vscode';
import { EXTENSION_ID } from './constants';
import { getConfig, getLogger, getTelemetry } from './utils';
import { registerCommands } from './commands';

/**
 * Called when the extension is activated.
 * Activation happens based on the activationEvents defined in package.json:
 * - When a workspace contains .generacy/*.yaml or .generacy/*.yml files
 */
export function activate(context: vscode.ExtensionContext): void {
  // Initialize utilities
  const logger = getLogger();
  logger.initialize(context);

  const config = getConfig();
  config.initialize(context);

  const telemetry = getTelemetry();
  telemetry.initialize(context);

  // Log activation
  logger.info(`Generacy extension v${getExtensionVersion()} activated`);
  logger.info(`Workflow directory: ${config.get('workflowDirectory')}`);

  // Register commands
  registerCommands(context);

  // Listen for configuration changes
  context.subscriptions.push(
    config.onDidChange((event) => {
      logger.info(`Configuration changed: ${event.key}`, {
        oldValue: event.oldValue as string | number | boolean,
        newValue: event.newValue as string | number | boolean,
      });
    })
  );

  logger.info('Extension initialization complete');
}

/**
 * Called when the extension is deactivated.
 * Clean up resources here.
 */
export function deactivate(): void {
  const logger = getLogger();
  logger.info('Generacy extension deactivating');

  // Clean up utilities
  getTelemetry().dispose();
  getConfig().dispose();
  logger.dispose();
}


/**
 * Get the extension version from package.json
 */
function getExtensionVersion(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  return extension?.packageJSON?.version ?? 'unknown';
}
