/**
 * Workflow CRUD commands for Generacy VS Code extension.
 * Handles create, rename, delete, and duplicate operations for workflow files.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig, getLogger, GeneracyError, ErrorCode } from '../utils';
import { WORKFLOW_TEMPLATES, WORKFLOW_EXTENSIONS } from '../constants';

/**
 * Template definitions for workflow creation
 */
const WORKFLOW_TEMPLATE_CONTENT: Record<string, string> = {
  basic: `# Basic Workflow
name: my-workflow
description: A basic workflow template

phases:
  - name: main
    steps:
      - name: step-1
        action: shell
        command: echo "Hello, Generacy!"
`,
  'multi-phase': `# Multi-Phase Workflow
name: my-workflow
description: A multi-phase workflow template

phases:
  - name: setup
    steps:
      - name: prepare
        action: shell
        command: echo "Setting up..."

  - name: build
    steps:
      - name: compile
        action: shell
        command: echo "Building..."

  - name: deploy
    steps:
      - name: publish
        action: shell
        command: echo "Deploying..."
`,
  'with-triggers': `# Workflow with Triggers
name: my-workflow
description: A workflow with trigger configuration

triggers:
  - type: webhook
    path: /trigger
  - type: schedule
    cron: "0 0 * * *"

phases:
  - name: main
    steps:
      - name: process
        action: shell
        command: echo "Processing triggered workflow..."
`,
};

/**
 * Quick pick item for template selection
 */
interface TemplateQuickPickItem extends vscode.QuickPickItem {
  label: string;
  description: string;
  detail: string;
  templateKey: string;
}

/**
 * Create a new workflow file with template selection
 */
export async function createWorkflow(): Promise<void> {
  const logger = getLogger();
  const config = getConfig();

  logger.info('Command: Create Workflow');

  // Get workspace folder
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new GeneracyError(
      ErrorCode.DirectoryNotFound,
      'No workspace folder open. Please open a folder to create workflows.'
    );
  }

  // Show template selection
  const templateItems: TemplateQuickPickItem[] = [
    {
      label: '$(file) Basic',
      description: 'Single phase with one step',
      detail: 'Best for simple workflows and getting started',
      templateKey: WORKFLOW_TEMPLATES.basic,
    },
    {
      label: '$(layers) Multi-Phase',
      description: 'Setup, build, and deploy phases',
      detail: 'Best for CI/CD and multi-stage workflows',
      templateKey: WORKFLOW_TEMPLATES.multiPhase,
    },
    {
      label: '$(zap) With Triggers',
      description: 'Webhook and schedule triggers',
      detail: 'Best for automated workflows that respond to events',
      templateKey: WORKFLOW_TEMPLATES.withTriggers,
    },
  ];

  const selectedTemplate = await vscode.window.showQuickPick(templateItems, {
    placeHolder: 'Select a workflow template',
    title: 'Create New Workflow',
  });

  if (!selectedTemplate) {
    logger.info('Workflow creation cancelled - no template selected');
    return;
  }

  // Prompt for workflow name
  const workflowName = await vscode.window.showInputBox({
    prompt: 'Enter workflow name',
    placeHolder: 'my-workflow',
    validateInput: validateWorkflowName,
  });

  if (!workflowName) {
    logger.info('Workflow creation cancelled - no name provided');
    return;
  }

  // Create the workflow file
  const workflowDir = config.get('workflowDirectory');
  const workflowDirUri = vscode.Uri.joinPath(workspaceFolder.uri, workflowDir);
  const workflowFileUri = vscode.Uri.joinPath(workflowDirUri, `${workflowName}.yaml`);

  // Ensure workflow directory exists
  try {
    await vscode.workspace.fs.createDirectory(workflowDirUri);
  } catch {
    // Directory may already exist, which is fine
  }

  // Check if file already exists
  try {
    await vscode.workspace.fs.stat(workflowFileUri);
    throw new GeneracyError(
      ErrorCode.FileWriteError,
      `Workflow "${workflowName}" already exists. Please choose a different name.`
    );
  } catch (error: unknown) {
    if (error instanceof GeneracyError) {
      throw error;
    }
    // File doesn't exist, which is what we want
  }

  // Get template content and customize
  const rawTemplate = WORKFLOW_TEMPLATE_CONTENT[selectedTemplate.templateKey];
  if (!rawTemplate) {
    throw new GeneracyError(
      ErrorCode.ConfigInvalid,
      `Unknown template: ${selectedTemplate.templateKey}`
    );
  }
  const templateContent = rawTemplate.replace(/name: my-workflow/g, `name: ${workflowName}`);

  // Write the file
  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(workflowFileUri, encoder.encode(templateContent));

  logger.info(`Created workflow: ${workflowFileUri.fsPath}`);

  // Open the new file
  const document = await vscode.workspace.openTextDocument(workflowFileUri);
  await vscode.window.showTextDocument(document);

  await vscode.window.showInformationMessage(`Created workflow: ${workflowName}`);
}

/**
 * Rename an existing workflow file
 */
export async function renameWorkflow(uri?: vscode.Uri): Promise<void> {
  const logger = getLogger();

  logger.info('Command: Rename Workflow');

  // Get the workflow file URI
  const workflowUri = uri ?? await selectWorkflowFile('Select workflow to rename');
  if (!workflowUri) {
    logger.info('Rename cancelled - no workflow selected');
    return;
  }

  // Get current name without extension
  const currentName = path.basename(workflowUri.fsPath, path.extname(workflowUri.fsPath));

  // Prompt for new name
  const newName = await vscode.window.showInputBox({
    prompt: 'Enter new workflow name',
    value: currentName,
    validateInput: validateWorkflowName,
  });

  if (!newName || newName === currentName) {
    logger.info('Rename cancelled - same name or cancelled');
    return;
  }

  // Build new URI
  const directory = path.dirname(workflowUri.fsPath);
  const extension = path.extname(workflowUri.fsPath);
  const newUri = vscode.Uri.file(path.join(directory, `${newName}${extension}`));

  // Check if target exists
  try {
    await vscode.workspace.fs.stat(newUri);
    throw new GeneracyError(
      ErrorCode.FileWriteError,
      `A workflow named "${newName}" already exists.`
    );
  } catch (error) {
    if (error instanceof GeneracyError) {
      throw error;
    }
    // Target doesn't exist, which is what we want
  }

  // Rename the file
  await vscode.workspace.fs.rename(workflowUri, newUri);

  logger.info(`Renamed workflow: ${currentName} -> ${newName}`);
  await vscode.window.showInformationMessage(`Renamed workflow to: ${newName}`);
}

/**
 * Delete a workflow file with confirmation
 */
export async function deleteWorkflow(uri?: vscode.Uri): Promise<void> {
  const logger = getLogger();

  logger.info('Command: Delete Workflow');

  // Get the workflow file URI
  const workflowUri = uri ?? await selectWorkflowFile('Select workflow to delete');
  if (!workflowUri) {
    logger.info('Delete cancelled - no workflow selected');
    return;
  }

  const workflowName = path.basename(workflowUri.fsPath, path.extname(workflowUri.fsPath));

  // Show confirmation dialog
  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to delete "${workflowName}"?`,
    { modal: true },
    'Delete'
  );

  if (confirm !== 'Delete') {
    logger.info('Delete cancelled by user');
    return;
  }

  // Close the file if it's open
  const openEditors = vscode.window.tabGroups.all
    .flatMap((group: vscode.TabGroup) => group.tabs)
    .filter((tab: vscode.Tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === workflowUri.fsPath);

  for (const tab of openEditors) {
    await vscode.window.tabGroups.close(tab);
  }

  // Delete the file
  await vscode.workspace.fs.delete(workflowUri);

  logger.info(`Deleted workflow: ${workflowName}`);
  await vscode.window.showInformationMessage(`Deleted workflow: ${workflowName}`);
}

/**
 * Duplicate a workflow file
 */
export async function duplicateWorkflow(uri?: vscode.Uri): Promise<void> {
  const logger = getLogger();

  logger.info('Command: Duplicate Workflow');

  // Get the workflow file URI
  const workflowUri = uri ?? await selectWorkflowFile('Select workflow to duplicate');
  if (!workflowUri) {
    logger.info('Duplicate cancelled - no workflow selected');
    return;
  }

  const currentName = path.basename(workflowUri.fsPath, path.extname(workflowUri.fsPath));
  const directory = path.dirname(workflowUri.fsPath);
  const extension = path.extname(workflowUri.fsPath);

  // Generate unique name
  let newName = `${currentName}-copy`;
  let counter = 1;
  let newUri = vscode.Uri.file(path.join(directory, `${newName}${extension}`));

  while (true) {
    try {
      await vscode.workspace.fs.stat(newUri);
      // File exists, try next number
      counter++;
      newName = `${currentName}-copy-${counter}`;
      newUri = vscode.Uri.file(path.join(directory, `${newName}${extension}`));
    } catch {
      // File doesn't exist, we can use this name
      break;
    }
  }

  // Prompt for name (pre-filled with generated name)
  const finalName = await vscode.window.showInputBox({
    prompt: 'Enter name for the duplicate workflow',
    value: newName,
    validateInput: validateWorkflowName,
  });

  if (!finalName) {
    logger.info('Duplicate cancelled - no name provided');
    return;
  }

  const finalUri = vscode.Uri.file(path.join(directory, `${finalName}${extension}`));

  // Check if target exists (if user changed the name)
  if (finalName !== newName) {
    try {
      await vscode.workspace.fs.stat(finalUri);
      throw new GeneracyError(
        ErrorCode.FileWriteError,
        `A workflow named "${finalName}" already exists.`
      );
    } catch (error) {
      if (error instanceof GeneracyError) {
        throw error;
      }
      // Target doesn't exist, which is what we want
    }
  }

  // Read the original file
  const content = await vscode.workspace.fs.readFile(workflowUri);
  const textContent = new TextDecoder().decode(content);

  // Update the name in the content
  const updatedContent = textContent.replace(
    /^name:\s*.+$/m,
    `name: ${finalName}`
  );

  // Write the duplicate
  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(finalUri, encoder.encode(updatedContent));

  logger.info(`Duplicated workflow: ${currentName} -> ${finalName}`);

  // Open the new file
  const document = await vscode.workspace.openTextDocument(finalUri);
  await vscode.window.showTextDocument(document);

  await vscode.window.showInformationMessage(`Created duplicate: ${finalName}`);
}

/**
 * Validate workflow name
 */
function validateWorkflowName(name: string): string | undefined {
  if (!name) {
    return 'Workflow name is required';
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores';
  }

  if (name.length > 64) {
    return 'Name must be 64 characters or less';
  }

  return undefined;
}

/**
 * Show quick pick to select a workflow file
 */
async function selectWorkflowFile(placeholder: string): Promise<vscode.Uri | undefined> {
  const config = getConfig();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    throw new GeneracyError(
      ErrorCode.DirectoryNotFound,
      'No workspace folder open.'
    );
  }

  const workflowDir = config.get('workflowDirectory');
  const workflowDirUri = vscode.Uri.joinPath(workspaceFolder.uri, workflowDir);

  // Find all workflow files
  const pattern = new vscode.RelativePattern(
    workflowDirUri,
    `**/*{${WORKFLOW_EXTENSIONS.join(',')}}`
  );

  const files = await vscode.workspace.findFiles(pattern);

  if (files.length === 0) {
    throw new GeneracyError(
      ErrorCode.FileNotFound,
      `No workflow files found in ${workflowDir}. Create one first with "Generacy: Create Workflow".`
    );
  }

  // Build quick pick items
  const items = files.map((file: vscode.Uri) => ({
    label: path.basename(file.fsPath, path.extname(file.fsPath)),
    description: path.relative(workflowDirUri.fsPath, file.fsPath),
    uri: file,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: placeholder,
  });

  return selected?.uri;
}
