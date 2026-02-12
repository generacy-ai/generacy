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
import {
  createWorkflowCodeLensProvider,
  createWorkflowCodeActionProvider,
} from './views/local/editor';
import {
  runWorkflow,
  runPhase,
  validateWorkflow as runValidateWorkflow,
  initializeRunner,
} from './commands/runner';
import { createWorkflow } from './commands/workflow';
import { initializeExecutionStatusBar } from './providers';
import { registerDebugAdapter } from './debug';
import { registerCloudCommands, initializeCloudServices } from './commands/cloud';

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

  // Register CodeLens and Code Action providers for editor features
  createWorkflowCodeLensProvider(context);
  createWorkflowCodeActionProvider(context);
  logger.info('Editor features registered');

  // Initialize workflow runner
  initializeRunner(context);
  logger.info('Workflow runner initialized');

  // Initialize execution status bar
  initializeExecutionStatusBar(context);
  logger.info('Execution status bar initialized');

  // Register debug adapter
  registerDebugAdapter(context);
  logger.info('Debug adapter registered');

  // Initialize cloud services and register cloud commands
  registerCloudCommands(context);
  void initializeCloudServices(context);
  logger.info('Cloud services initialized');

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
      id: COMMANDS.runPhase,
      handler: withErrorHandling(handleRunPhase, { showOutput: true }),
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
    {
      id: COMMANDS.submitJob,
      handler: withErrorHandling(handleSubmitJob, { showOutput: true }),
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
  await createWorkflow();
}

async function handleRunWorkflow(arg?: unknown): Promise<void> {
  await runWorkflow(arg);
}

async function handleRunPhase(arg?: unknown): Promise<void> {
  await runPhase(arg);
}

async function handleDebugWorkflow(arg?: unknown): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Debug Workflow');

  // Get workflow file to debug
  let workflowPath: string | undefined;

  if (arg instanceof vscode.Uri) {
    workflowPath = arg.fsPath;
  } else if (arg && isWorkflowTreeItem(arg as vscode.TreeItem)) {
    workflowPath = (arg as WorkflowTreeItem).uri.fsPath;
  } else {
    // Try to get from active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      workflowPath = activeEditor.document.uri.fsPath;
    }
  }

  if (!workflowPath) {
    await vscode.window.showWarningMessage('No workflow file selected to debug');
    return;
  }

  // Start debug session
  const config: vscode.DebugConfiguration = {
    type: 'generacy',
    name: 'Debug Workflow',
    request: 'launch',
    workflow: workflowPath,
    stopOnEntry: true,
  };

  await vscode.debug.startDebugging(undefined, config);
}

async function handleValidateWorkflow(arg?: unknown): Promise<void> {
  await runValidateWorkflow(arg);
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
 * Submit a job to the orchestrator via command palette.
 * Prompts for a GitHub issue URL/number, resolves it, and POSTs to the orchestrator.
 */
async function handleSubmitJob(): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Submit Job');

  // Prompt for issue URL/number or description
  const value = await vscode.window.showInputBox({
    title: 'Submit Job to Orchestrator',
    prompt: 'Enter a GitHub issue URL, issue number (#123), or job description',
    placeHolder: 'https://github.com/org/repo/issues/123 or #61 or "Fix login bug"',
    ignoreFocusOut: true,
  });

  if (value === undefined || !value.trim()) {
    return;
  }

  // Try to resolve as GitHub issue
  let jobName = value.trim();
  let issueUrl: string | undefined;
  let issueNumber: number | undefined;
  let issueBody: string | undefined;

  const isIssueRef = value.match(/github\.com\/.*\/issues\/\d+/) || value.match(/^#?\d+$/);
  if (isIssueRef) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const urlMatch = value.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
      const numberMatch = value.match(/^#?(\d+)$/);

      const args = ['issue', 'view', '--json', 'number,title,body,url'];
      if (urlMatch) {
        args.push(urlMatch[3]!, '--repo', `${urlMatch[1]}/${urlMatch[2]}`);
      } else if (numberMatch) {
        args.push(numberMatch[1]!);
      }

      const { stdout } = await execFileAsync('gh', args, { cwd, timeout: 15000 });
      const issue = JSON.parse(stdout);
      jobName = issue.title;
      issueUrl = issue.url;
      issueNumber = issue.number;
      issueBody = issue.body || '';
      logger.info(`Resolved issue #${issue.number}: ${issue.title}`);
    } catch {
      vscode.window.showWarningMessage(`Could not fetch issue "${value}". Using as description.`);
    }
  }

  // Select workflow type
  const workflowType = await vscode.window.showQuickPick(
    [
      { label: 'speckit-feature', description: 'Full spec-driven feature development' },
      { label: 'speckit-bugfix', description: 'Bug fix workflow' },
      { label: 'custom', description: 'Custom workflow name' },
    ],
    { title: 'Select workflow type', placeHolder: 'Which workflow should run?' }
  );

  if (!workflowType) {
    return;
  }

  let workflow = workflowType.label;
  if (workflow === 'custom') {
    const customName = await vscode.window.showInputBox({
      prompt: 'Enter workflow name',
      placeHolder: 'my-workflow',
    });
    if (!customName) return;
    workflow = customName;
  }

  // Get orchestrator URL from config or default
  const config = getConfig();
  const orchestratorUrl = config.get('orchestratorUrl') || 'http://localhost:3100';

  // Build job payload
  const jobPayload = {
    name: jobName,
    workflow,
    priority: 'normal',
    inputs: {
      description: jobName,
      ...(issueUrl && { issue_url: issueUrl }),
      ...(issueNumber && { issue_number: issueNumber }),
      ...(issueBody && { issue_body: issueBody }),
    },
    metadata: {
      source: 'vscode-extension',
      submittedAt: new Date().toISOString(),
    },
  };

  // Submit to orchestrator
  try {
    const http = await import('http');
    const url = new URL('/api/jobs', orchestratorUrl);

    const result = await new Promise<{ jobId: string; status: string }>((resolve, reject) => {
      const body = JSON.stringify(jobPayload);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode === 201) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`Orchestrator returned ${res.statusCode}: ${data}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const issueLabel = issueNumber ? ` (issue #${issueNumber})` : '';
    vscode.window.showInformationMessage(
      `Job submitted${issueLabel}: ${result.jobId.substring(0, 8)}... [${result.status}]`
    );
    logger.info('Job submitted to orchestrator', { jobId: result.jobId, name: jobName });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to submit job: ${msg}`);
    throw new GeneracyError(ErrorCode.ApiConnectionError, `Failed to submit job: ${msg}`);
  }
}

/**
 * Get the extension version from package.json
 */
function getExtensionVersion(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  return extension?.packageJSON?.version ?? 'unknown';
}
