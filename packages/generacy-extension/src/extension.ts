import * as vscode from 'vscode';
import * as path from 'path';
import { EXTENSION_ID, COMMANDS } from './constants';
import { getConfig, getLogger, getTelemetry, withErrorHandling, ErrorCode, GeneracyError } from './utils';
import {
  WorkflowTreeProvider,
  createWorkflowTreeProvider,
  registerWorkflowDecorationProvider,
  WorkflowTreeItem,
  isWorkflowTreeItem,
  getTemplateManager,
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

  // Register commands
  registerCommands(context);

  // Initialize template manager
  const templateManager = getTemplateManager();
  templateManager.initialize(context);
  context.subscriptions.push(templateManager);
  logger.info('Template manager initialized');

  // Register workflow tree view and decoration provider
  workflowTreeProvider = createWorkflowTreeProvider(context);
  registerWorkflowDecorationProvider(context);
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
 * Register all extension commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
  const logger = getLogger();
  const telemetry = getTelemetry();

  const commands: Array<{
    id: string;
    handler: (...args: unknown[]) => void | Promise<void>;
  }> = [
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
    {
      id: COMMANDS.renameWorkflow,
      handler: withErrorHandling(handleRenameWorkflow, { showOutput: true }),
    },
    {
      id: COMMANDS.deleteWorkflow,
      handler: withErrorHandling(handleDeleteWorkflow, { showOutput: true }),
    },
    {
      id: COMMANDS.duplicateWorkflow,
      handler: withErrorHandling(handleDuplicateWorkflow, { showOutput: true }),
    },
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
  workflowTreeProvider?.refresh();
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
 * CRUD Command handlers
 */
async function handleRenameWorkflow(arg?: unknown): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Rename Workflow');

  const item = await getWorkflowItem(arg);
  if (!item) {
    await vscode.window.showWarningMessage('No workflow selected');
    return;
  }

  const currentName = path.basename(item.uri.fsPath);
  const newName = await vscode.window.showInputBox({
    prompt: 'Enter new workflow name',
    value: currentName,
    validateInput: (value) => {
      if (!value || value.trim() === '') {
        return 'Name cannot be empty';
      }
      if (!/^[\w\-. ]+\.(yaml|yml)$/i.test(value)) {
        return 'Name must be a valid YAML filename (e.g., my-workflow.yaml)';
      }
      return undefined;
    },
  });

  if (!newName || newName === currentName) {
    return;
  }

  const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(item.uri.fsPath)), newName);

  try {
    await vscode.workspace.fs.rename(item.uri, newUri);
    logger.info(`Renamed workflow: ${currentName} -> ${newName}`);
    workflowTreeProvider?.refresh();
  } catch (error) {
    throw new GeneracyError(
      ErrorCode.FileWriteError,
      `Failed to rename workflow: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function handleDeleteWorkflow(arg?: unknown): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Delete Workflow');

  const item = await getWorkflowItem(arg);
  if (!item) {
    await vscode.window.showWarningMessage('No workflow selected');
    return;
  }

  const fileName = path.basename(item.uri.fsPath);
  const confirmation = await vscode.window.showWarningMessage(
    `Are you sure you want to delete "${fileName}"?`,
    { modal: true },
    'Delete'
  );

  if (confirmation !== 'Delete') {
    return;
  }

  try {
    await vscode.workspace.fs.delete(item.uri);
    logger.info(`Deleted workflow: ${fileName}`);
    workflowTreeProvider?.refresh();
  } catch (error) {
    throw new GeneracyError(
      ErrorCode.FileWriteError,
      `Failed to delete workflow: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function handleDuplicateWorkflow(arg?: unknown): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Duplicate Workflow');

  const item = await getWorkflowItem(arg);
  if (!item) {
    await vscode.window.showWarningMessage('No workflow selected');
    return;
  }

  const currentName = path.basename(item.uri.fsPath);
  const extension = path.extname(currentName);
  const baseName = path.basename(currentName, extension);
  const suggestedName = `${baseName}-copy${extension}`;

  const newName = await vscode.window.showInputBox({
    prompt: 'Enter name for the duplicated workflow',
    value: suggestedName,
    validateInput: (value) => {
      if (!value || value.trim() === '') {
        return 'Name cannot be empty';
      }
      if (!/^[\w\-. ]+\.(yaml|yml)$/i.test(value)) {
        return 'Name must be a valid YAML filename (e.g., my-workflow.yaml)';
      }
      return undefined;
    },
  });

  if (!newName) {
    return;
  }

  const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(item.uri.fsPath)), newName);

  try {
    await vscode.workspace.fs.copy(item.uri, newUri);
    logger.info(`Duplicated workflow: ${currentName} -> ${newName}`);
    workflowTreeProvider?.refresh();

    // Open the new file
    const doc = await vscode.workspace.openTextDocument(newUri);
    await vscode.window.showTextDocument(doc);
  } catch (error) {
    throw new GeneracyError(
      ErrorCode.FileWriteError,
      `Failed to duplicate workflow: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

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
