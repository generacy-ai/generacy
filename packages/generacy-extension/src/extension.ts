import * as vscode from 'vscode';
import { EXTENSION_ID, COMMANDS, CONFIG_KEYS } from './constants';

/**
 * Extension activation state
 */
let outputChannel: vscode.OutputChannel | undefined;

/**
 * Called when the extension is activated.
 * Activation happens based on the activationEvents defined in package.json:
 * - When a workspace contains .generacy/*.yaml or .generacy/*.yml files
 */
export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Generacy');
  outputChannel.appendLine(`Generacy extension v${getExtensionVersion()} activated`);

  // Register commands
  registerCommands(context);

  // Log configuration
  const config = vscode.workspace.getConfiguration('generacy');
  const workflowDir = config.get<string>(CONFIG_KEYS.workflowDirectory);
  outputChannel.appendLine(`Workflow directory: ${workflowDir}`);

  // Set up configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('generacy')) {
        onConfigurationChanged();
      }
    })
  );

  outputChannel.appendLine('Extension initialization complete');
}

/**
 * Called when the extension is deactivated.
 * Clean up resources here.
 */
export function deactivate(): void {
  if (outputChannel) {
    outputChannel.appendLine('Generacy extension deactivated');
    outputChannel.dispose();
    outputChannel = undefined;
  }
}

/**
 * Register all extension commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
  const commands: Array<{ id: string; handler: () => void | Promise<void> }> = [
    {
      id: COMMANDS.createWorkflow,
      handler: handleCreateWorkflow,
    },
    {
      id: COMMANDS.runWorkflow,
      handler: handleRunWorkflow,
    },
    {
      id: COMMANDS.debugWorkflow,
      handler: handleDebugWorkflow,
    },
    {
      id: COMMANDS.validateWorkflow,
      handler: handleValidateWorkflow,
    },
    {
      id: COMMANDS.refreshExplorer,
      handler: handleRefreshExplorer,
    },
  ];

  for (const { id, handler } of commands) {
    const disposable = vscode.commands.registerCommand(id, handler);
    context.subscriptions.push(disposable);
    outputChannel?.appendLine(`Registered command: ${id}`);
  }
}

/**
 * Command handlers
 */
async function handleCreateWorkflow(): Promise<void> {
  outputChannel?.appendLine('Command: Create Workflow');
  await vscode.window.showInformationMessage('Create Workflow - Not yet implemented');
}

async function handleRunWorkflow(): Promise<void> {
  outputChannel?.appendLine('Command: Run Workflow');
  await vscode.window.showInformationMessage('Run Workflow - Not yet implemented');
}

async function handleDebugWorkflow(): Promise<void> {
  outputChannel?.appendLine('Command: Debug Workflow');
  await vscode.window.showInformationMessage('Debug Workflow - Not yet implemented');
}

async function handleValidateWorkflow(): Promise<void> {
  outputChannel?.appendLine('Command: Validate Workflow');
  await vscode.window.showInformationMessage('Validate Workflow - Not yet implemented');
}

function handleRefreshExplorer(): void {
  outputChannel?.appendLine('Command: Refresh Explorer');
  // Tree view refresh will be implemented in a future task
}

/**
 * Handle configuration changes
 */
function onConfigurationChanged(): void {
  outputChannel?.appendLine('Configuration changed');
  const config = vscode.workspace.getConfiguration('generacy');
  const workflowDir = config.get<string>(CONFIG_KEYS.workflowDirectory);
  outputChannel?.appendLine(`New workflow directory: ${workflowDir}`);
}

/**
 * Get the extension version from package.json
 */
function getExtensionVersion(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  return extension?.packageJSON?.version ?? 'unknown';
}
