import * as vscode from 'vscode';
import { EXTENSION_ID, COMMANDS } from './constants';
import { getConfig, getLogger, getTelemetry, withErrorHandling, ErrorCode, GeneracyError } from './utils';
import { registerCommands as registerBaseCommands, setRefreshExplorerCallback } from './commands';
import {
  WorkflowTreeProvider,
  createWorkflowTreeProvider,
  registerWorkflowDecorationProvider,
  WorkflowTreeItem,
  isWorkflowTreeItem,
} from './views/local/explorer';

// Module-level provider reference for command handlers
let workflowTreeProvider: WorkflowTreeProvider | undefined;

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

  // Register base commands from commands module
  registerBaseCommands(context);

  // Register tree view-specific commands
  registerTreeViewCommands(context);

  // Register workflow tree view and decoration provider
  workflowTreeProvider = createWorkflowTreeProvider(context);
  registerWorkflowDecorationProvider(context);

  // Set the refresh callback so the commands module can trigger refreshes
  setRefreshExplorerCallback(() => workflowTreeProvider?.refresh());

  logger.info('Workflow explorer registered');

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
 * Register tree view-specific commands that need access to the workflowTreeProvider
 */
function registerTreeViewCommands(context: vscode.ExtensionContext): void {
  const logger = getLogger();
  const telemetry = getTelemetry();

  const commands: Array<{
    id: string;
    handler: (...args: unknown[]) => void | Promise<void>;
  }> = [
    {
      id: COMMANDS.openWorkflow,
      handler: withErrorHandling(handleOpenWorkflow, { showOutput: true }),
    },
    {
      id: COMMANDS.revealInExplorer,
      handler: withErrorHandling(handleRevealInExplorer, { showOutput: true }),
    },
  ];

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
}

/**
 * Helper to get workflow item from command argument or active editor
 */
async function getWorkflowItem(arg: unknown): Promise<WorkflowTreeItem | undefined> {
  // If arg is a WorkflowTreeItem, use it directly
  if (arg && isWorkflowTreeItem(arg as vscode.TreeItem)) {
    return arg as WorkflowTreeItem;
  }

  // If arg is a URI, look up the workflow
  if (arg instanceof vscode.Uri) {
    return workflowTreeProvider?.getWorkflowByUri(arg);
  }

  // Try to get from active editor
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const uri = activeEditor.document.uri;
    const config = getConfig();
    const workflowDir = config.get('workflowDirectory');

    // Check if the file is in the workflow directory
    if (uri.fsPath.includes(workflowDir)) {
      return workflowTreeProvider?.getWorkflowByUri(uri);
    }
  }

  return undefined;
}

/**
 * Tree view-specific command handlers
 */
async function handleOpenWorkflow(arg?: unknown): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Open Workflow');

  const item = await getWorkflowItem(arg);
  if (!item) {
    await vscode.window.showWarningMessage('No workflow selected');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(item.uri);
  await vscode.window.showTextDocument(doc);
}

async function handleRevealInExplorer(arg?: unknown): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Reveal in Explorer');

  const item = await getWorkflowItem(arg);
  if (!item) {
    await vscode.window.showWarningMessage('No workflow selected');
    return;
  }

  await vscode.commands.executeCommand('revealInExplorer', item.uri);
}

/**
 * Get the extension version from package.json
 */
function getExtensionVersion(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  return extension?.packageJSON?.version ?? 'unknown';
}
