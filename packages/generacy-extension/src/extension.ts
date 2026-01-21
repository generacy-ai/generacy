import * as vscode from 'vscode';
import { EXTENSION_ID, COMMANDS } from './constants';
import { getConfig, getLogger, getTelemetry, withErrorHandling, ErrorCode, GeneracyError } from './utils';

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
 * Register all extension commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
  const logger = getLogger();
  const telemetry = getTelemetry();

  const commands: Array<{ id: string; handler: () => void | Promise<void> }> = [
    {
      id: COMMANDS.createWorkflow,
      handler: withErrorHandling(handleCreateWorkflow, { showOutput: true }),
    },
    {
      id: COMMANDS.runWorkflow,
      handler: withErrorHandling(handleRunWorkflow, { showOutput: true }),
    },
    {
      id: COMMANDS.debugWorkflow,
      handler: withErrorHandling(handleDebugWorkflow, { showOutput: true }),
    },
    {
      id: COMMANDS.validateWorkflow,
      handler: withErrorHandling(handleValidateWorkflow, { showOutput: true }),
    },
    {
      id: COMMANDS.refreshExplorer,
      handler: handleRefreshExplorer,
    },
  ];

  for (const { id, handler } of commands) {
    const wrappedHandler = async () => {
      const startTime = Date.now();
      logger.debug(`Executing command: ${id}`);
      try {
        await handler();
        telemetry.trackCommand(id, Date.now() - startTime);
      } catch (error) {
        telemetry.trackError(
          error instanceof GeneracyError ? error.code : ErrorCode.Unknown,
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    };

    const disposable = vscode.commands.registerCommand(id, wrappedHandler);
    context.subscriptions.push(disposable);
    logger.debug(`Registered command: ${id}`);
  }
}

/**
 * Command handlers
 */
async function handleCreateWorkflow(): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Create Workflow');
  await vscode.window.showInformationMessage('Create Workflow - Not yet implemented');
}

async function handleRunWorkflow(): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Run Workflow');
  await vscode.window.showInformationMessage('Run Workflow - Not yet implemented');
}

async function handleDebugWorkflow(): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Debug Workflow');
  await vscode.window.showInformationMessage('Debug Workflow - Not yet implemented');
}

async function handleValidateWorkflow(): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Validate Workflow');
  await vscode.window.showInformationMessage('Validate Workflow - Not yet implemented');
}

function handleRefreshExplorer(): void {
  const logger = getLogger();
  logger.info('Command: Refresh Explorer');
  // Tree view refresh will be implemented in a future task
}

/**
 * Get the extension version from package.json
 */
function getExtensionVersion(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  return extension?.packageJSON?.version ?? 'unknown';
}
