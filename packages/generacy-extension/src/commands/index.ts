/**
 * Command registration module for Generacy VS Code extension.
 * Central registry for all extension commands.
 */
import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { getLogger, getTelemetry, withErrorHandling, GeneracyError, ErrorCode } from '../utils';
import { createWorkflow, renameWorkflow, deleteWorkflow, duplicateWorkflow } from './workflow';

/**
 * Command definition with handler and metadata
 */
interface CommandDefinition {
  /** Command identifier from COMMANDS constant */
  id: string;
  /** Command handler function */
  handler: (...args: unknown[]) => void | Promise<void>;
  /** Whether to show error output channel on error */
  showOutputOnError?: boolean;
}

/**
 * Register all extension commands
 * @param context VS Code extension context for disposable management
 */
export function registerCommands(context: vscode.ExtensionContext): void {
  const logger = getLogger();
  const telemetry = getTelemetry();

  const commands: CommandDefinition[] = [
    // Workflow CRUD commands
    {
      id: COMMANDS.createWorkflow,
      handler: withErrorHandling(createWorkflow, { showOutput: true }),
      showOutputOnError: true,
    },
    {
      id: COMMANDS.renameWorkflow,
      handler: withErrorHandling(renameWorkflow, { showOutput: true }),
      showOutputOnError: true,
    },
    {
      id: COMMANDS.deleteWorkflow,
      handler: withErrorHandling(deleteWorkflow, { showOutput: true }),
      showOutputOnError: true,
    },
    {
      id: COMMANDS.duplicateWorkflow,
      handler: withErrorHandling(duplicateWorkflow, { showOutput: true }),
      showOutputOnError: true,
    },

    // Runner commands (stubs - to be implemented in future tasks)
    {
      id: COMMANDS.runWorkflow,
      handler: withErrorHandling(handleRunWorkflow, { showOutput: true }),
      showOutputOnError: true,
    },
    {
      id: COMMANDS.debugWorkflow,
      handler: withErrorHandling(handleDebugWorkflow, { showOutput: true }),
      showOutputOnError: true,
    },
    {
      id: COMMANDS.validateWorkflow,
      handler: withErrorHandling(handleValidateWorkflow, { showOutput: true }),
      showOutputOnError: true,
    },

    // Explorer commands
    {
      id: COMMANDS.refreshExplorer,
      handler: handleRefreshExplorer,
    },
  ];

  // Register each command
  for (const { id, handler } of commands) {
    const wrappedHandler = async (...args: unknown[]) => {
      const startTime = Date.now();
      logger.debug(`Executing command: ${id}`);

      try {
        await handler(...args);
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

  logger.info(`Registered ${commands.length} commands`);
}

/**
 * Stub handlers for commands to be implemented in future tasks
 */

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

// Callback for refresh explorer - set by extension.ts when tree provider is created
let refreshExplorerCallback: (() => void) | undefined;

/**
 * Set the callback for refreshing the explorer tree view
 * @param callback Function to call when refresh is triggered
 */
export function setRefreshExplorerCallback(callback: () => void): void {
  refreshExplorerCallback = callback;
}

function handleRefreshExplorer(): void {
  const logger = getLogger();
  logger.info('Command: Refresh Explorer');
  refreshExplorerCallback?.();
}
