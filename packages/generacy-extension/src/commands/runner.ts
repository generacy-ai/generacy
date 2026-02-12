/**
 * Runner commands for workflow execution.
 * Provides commands to run workflows, phases, and validate.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'yaml';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getConfig, getLogger, GeneracyError, ErrorCode } from '../utils';
import { WORKFLOW_EXTENSIONS } from '../constants';
import {
  getWorkflowExecutor,
  getRunnerOutputChannel,
  getWorkflowTerminal,
  getEnvConfigManager,
  type ExecutableWorkflow,
  type ExecutionOptions,
  type ExecutionMode,
} from '../views/local/runner';

const execFileAsync = promisify(execFile);

/**
 * Parse a workflow YAML file into an executable workflow
 */
async function parseWorkflowFile(uri: vscode.Uri): Promise<ExecutableWorkflow> {
  const content = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder().decode(content);

  try {
    const parsed = yaml.parse(text);

    if (!parsed || typeof parsed !== 'object') {
      throw new GeneracyError(
        ErrorCode.WorkflowValidationError,
        'Invalid workflow file: not a valid YAML object'
      );
    }

    // Extract workflow structure
    const workflow: ExecutableWorkflow = {
      name: parsed.name || path.basename(uri.fsPath, path.extname(uri.fsPath)),
      description: parsed.description,
      phases: [],
      env: parsed.env || {},
      timeout: parsed.timeout,
      inputs: parsed.inputs,
    };

    // Parse phases
    if (Array.isArray(parsed.phases)) {
      for (const phase of parsed.phases) {
        if (!phase || typeof phase !== 'object') {
          continue;
        }

        const phaseData = {
          name: phase.name || 'unnamed',
          condition: phase.condition,
          steps: [] as ExecutableWorkflow['phases'][0]['steps'],
        };

        // Parse steps
        if (Array.isArray(phase.steps)) {
          for (const step of phase.steps) {
            if (!step || typeof step !== 'object') {
              continue;
            }

            phaseData.steps.push({
              name: step.name || 'unnamed',
              action: step.action || 'shell',
              uses: step.uses,
              with: step.with,
              command: step.command,
              script: step.script,
              timeout: step.timeout,
              continueOnError: step.continueOnError || step['continue-on-error'] || false,
              condition: step.condition,
              env: step.env || {},
            });
          }
        }

        workflow.phases.push(phaseData);
      }
    }

    return workflow;
  } catch (error) {
    if (error instanceof GeneracyError) {
      throw error;
    }
    throw new GeneracyError(
      ErrorCode.WorkflowValidationError,
      `Failed to parse workflow: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get workflow file URI from context or active editor
 */
async function getWorkflowUri(arg?: unknown): Promise<vscode.Uri | undefined> {
  // If arg is a URI, use it
  if (arg instanceof vscode.Uri) {
    return arg;
  }

  // If arg is a tree item with uri, use that
  if (arg && typeof arg === 'object' && 'uri' in arg) {
    const item = arg as { uri: vscode.Uri };
    return item.uri;
  }

  // Try active editor
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const uri = activeEditor.document.uri;
    const ext = path.extname(uri.fsPath).toLowerCase();
    if (WORKFLOW_EXTENSIONS.includes(ext as typeof WORKFLOW_EXTENSIONS[number])) {
      return uri;
    }
  }

  // Show file picker
  const config = getConfig();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }

  const workflowDir = config.get('workflowDirectory');
  const pattern = new vscode.RelativePattern(
    vscode.Uri.joinPath(workspaceFolder.uri, workflowDir),
    `**/*{${WORKFLOW_EXTENSIONS.join(',')}}`
  );

  const files = await vscode.workspace.findFiles(pattern);
  if (files.length === 0) {
    throw new GeneracyError(
      ErrorCode.FileNotFound,
      `No workflow files found in ${workflowDir}`
    );
  }

  const items = files.map(file => ({
    label: path.basename(file.fsPath, path.extname(file.fsPath)),
    description: path.relative(workspaceFolder.uri.fsPath, file.fsPath),
    uri: file,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a workflow to run',
    title: 'Run Workflow',
  });

  return selected?.uri;
}

/**
 * Fetch GitHub issue details via `gh` CLI.
 * Returns null if the issue cannot be fetched.
 */
async function fetchGitHubIssue(
  input: string,
  cwd?: string
): Promise<{ number: number; title: string; body: string; url: string } | null> {
  try {
    // Parse issue URL: https://github.com/owner/repo/issues/123
    const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    // Or just a plain number: 123 or #123
    const numberMatch = input.match(/^#?(\d+)$/);

    const args = ['issue', 'view', '--json', 'number,title,body,url'];

    if (urlMatch) {
      args.push(urlMatch[3]!, '--repo', `${urlMatch[1]}/${urlMatch[2]}`);
    } else if (numberMatch) {
      args.push(numberMatch[1]!);
    } else {
      return null; // Not an issue reference
    }

    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      timeout: 15000,
    });

    const data = JSON.parse(stdout);
    return {
      number: data.number,
      title: data.title,
      body: data.body || '',
      url: data.url,
    };
  } catch {
    return null;
  }
}

/**
 * Smart input collection for speckit workflows.
 * Accepts an issue URL, issue number, or plain description in a single prompt.
 * When an issue is detected, auto-populates description and issue_url.
 */
async function collectSpeckitInputs(
  workflowName: string,
  logger: ReturnType<typeof getLogger>
): Promise<Record<string, unknown> | null> {
  const value = await vscode.window.showInputBox({
    title: `${workflowName}`,
    prompt: 'Enter a GitHub issue URL, issue number (#123), or feature description',
    placeHolder: 'https://github.com/org/repo/issues/123 or #2 or "Add dark mode"',
    ignoreFocusOut: true,
  });

  if (value === undefined) {
    logger.info('Run cancelled - user cancelled input');
    return null;
  }

  if (!value.trim()) {
    vscode.window.showErrorMessage('A description or issue reference is required.');
    return null;
  }

  const inputs: Record<string, unknown> = {};
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Check if it looks like an issue reference
  const isIssueRef = value.match(/github\.com\/.*\/issues\/\d+/) || value.match(/^#?\d+$/);

  if (isIssueRef) {
    const issue = await fetchGitHubIssue(value.trim(), cwd);
    if (issue) {
      inputs['description'] = issue.title;
      inputs['issue_url'] = issue.url;
      inputs['issue_number'] = issue.number;
      logger.info(`Resolved issue #${issue.number}: ${issue.title}`);
      vscode.window.showInformationMessage(
        `Resolved issue #${issue.number}: ${issue.title}`
      );
    } else {
      vscode.window.showWarningMessage(
        `Could not fetch issue "${value}". Using as description instead.`
      );
      inputs['description'] = value.trim();
    }
  } else {
    inputs['description'] = value.trim();
  }

  // Optionally ask for short_name
  const shortName = await vscode.window.showInputBox({
    title: `${workflowName}: branch name`,
    prompt: 'Optional short name for the branch (e.g., "dark-mode")',
    placeHolder: '(optional, press Enter to skip)',
    ignoreFocusOut: true,
  });

  if (shortName === undefined) {
    logger.info('Run cancelled - user cancelled input');
    return null;
  }

  if (shortName) {
    inputs['short_name'] = shortName;
  }

  return inputs;
}

/**
 * Run a workflow command handler
 */
export async function runWorkflow(arg?: unknown): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Run Workflow');

  const executor = getWorkflowExecutor();
  const outputChannel = getRunnerOutputChannel();
  const envManager = getEnvConfigManager();

  // Get workflow file
  const uri = await getWorkflowUri(arg);
  if (!uri) {
    logger.info('Run cancelled - no workflow selected');
    return;
  }

  // Parse workflow
  const workflow = await parseWorkflowFile(uri);
  logger.info(`Running workflow: ${workflow.name}`);

  // Check if already running
  if (executor.isRunning()) {
    const action = await vscode.window.showWarningMessage(
      'A workflow is already running. Do you want to cancel it?',
      'Cancel & Run',
      'View Current'
    );

    if (action === 'Cancel & Run') {
      executor.cancel();
    } else if (action === 'View Current') {
      outputChannel.show();
      return;
    } else {
      return;
    }
  }

  // Collect workflow inputs - smart issue-aware collection for speckit workflows
  const workflowInputs: Record<string, unknown> = {};
  const inputNames = (workflow.inputs || []).map(i => i.name);
  const isSpeckitWorkflow = inputNames.includes('description') &&
    (inputNames.includes('issue_url') || inputNames.includes('issue_number'));

  if (isSpeckitWorkflow) {
    // Smart single-prompt for speckit workflows
    const inputResult = await collectSpeckitInputs(workflow.name, logger);
    if (!inputResult) return; // cancelled
    Object.assign(workflowInputs, inputResult);
  } else if (workflow.inputs && workflow.inputs.length > 0) {
    // Generic input collection for non-speckit workflows
    for (const input of workflow.inputs) {
      const defaultValue = input.default !== undefined ? String(input.default) : undefined;
      const value = await vscode.window.showInputBox({
        title: `${workflow.name}: ${input.name}`,
        prompt: input.description || `Enter value for "${input.name}"`,
        value: defaultValue,
        placeHolder: input.required ? '(required)' : '(optional)',
        ignoreFocusOut: true,
      });

      if (value === undefined) {
        logger.info('Run cancelled - user cancelled input');
        return;
      }

      if (value || input.required) {
        workflowInputs[input.name] = value || defaultValue || '';
      }
    }
  }

  // Show execution mode selection
  const modeItems: (vscode.QuickPickItem & { mode: ExecutionMode })[] = [
    {
      label: '$(play) Run',
      description: 'Execute the workflow',
      mode: 'normal',
    },
    {
      label: '$(eye) Dry Run',
      description: 'Validate without executing commands',
      mode: 'dry-run',
    },
  ];

  const selectedMode = await vscode.window.showQuickPick(modeItems, {
    title: `Run: ${workflow.name}`,
    placeHolder: 'Select execution mode',
  });

  if (!selectedMode) {
    return;
  }

  // Show environment configuration
  const envResult = await envManager.showEnvConfiguration(
    workflow.name,
    workflow.env
  );

  if (envResult.cancelled) {
    return;
  }

  // Get working directory
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath;

  // Build execution options
  const options: ExecutionOptions = {
    mode: selectedMode.mode,
    env: envResult.env,
    cwd,
    verbose: true,
  };

  // Show output channel
  outputChannel.show(true);

  // Show progress notification
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Running workflow: ${workflow.name}`,
      cancellable: true,
    },
    async (_progress, token) => {
      // Set up cancellation
      token.onCancellationRequested(() => {
        executor.cancel();
      });

      // Execute workflow
      const result = await executor.execute(workflow, options, workflowInputs);

      // Show result notification
      if (result.status === 'completed') {
        vscode.window.showInformationMessage(
          `Workflow "${workflow.name}" completed successfully`
        );
      } else if (result.status === 'cancelled') {
        vscode.window.showWarningMessage(
          `Workflow "${workflow.name}" was cancelled`
        );
      } else {
        vscode.window.showErrorMessage(
          `Workflow "${workflow.name}" failed`
        );
      }

      return result;
    }
  );
}

/**
 * Run a specific phase command handler
 */
export async function runPhase(arg?: unknown): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Run Phase');

  const executor = getWorkflowExecutor();
  const outputChannel = getRunnerOutputChannel();
  const envManager = getEnvConfigManager();

  // Get workflow file
  const uri = await getWorkflowUri(arg);
  if (!uri) {
    logger.info('Run cancelled - no workflow selected');
    return;
  }

  // Parse workflow
  const workflow = await parseWorkflowFile(uri);

  // Check if there are phases to run
  if (workflow.phases.length === 0) {
    throw new GeneracyError(
      ErrorCode.WorkflowValidationError,
      'Workflow has no phases to run'
    );
  }

  // Show phase selection
  const phaseItems = workflow.phases.map((phase, index) => ({
    label: phase.name,
    description: `${phase.steps.length} step${phase.steps.length !== 1 ? 's' : ''}`,
    detail: `Phase ${index + 1} of ${workflow.phases.length}`,
    phaseName: phase.name,
  }));

  const selectedPhase = await vscode.window.showQuickPick(phaseItems, {
    title: `Run Phase: ${workflow.name}`,
    placeHolder: 'Select a phase to run',
  });

  if (!selectedPhase) {
    return;
  }

  // Check if already running
  if (executor.isRunning()) {
    const action = await vscode.window.showWarningMessage(
      'A workflow is already running.',
      'Cancel & Run',
      'View Current'
    );

    if (action === 'Cancel & Run') {
      executor.cancel();
    } else if (action === 'View Current') {
      outputChannel.show();
      return;
    } else {
      return;
    }
  }

  // Show environment configuration
  const envResult = await envManager.showEnvConfiguration(
    workflow.name,
    workflow.env
  );

  if (envResult.cancelled) {
    return;
  }

  // Get working directory
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath;

  // Build execution options
  const options: ExecutionOptions = {
    mode: 'normal',
    env: envResult.env,
    cwd,
    startPhase: selectedPhase.phaseName,
    verbose: true,
  };

  // Show output channel
  outputChannel.show(true);

  // Show progress notification
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Running phase: ${selectedPhase.phaseName}`,
      cancellable: true,
    },
    async (_progress, token) => {
      // Set up cancellation
      token.onCancellationRequested(() => {
        executor.cancel();
      });

      // Find the phase
      const phase = workflow.phases.find(p => p.name === selectedPhase.phaseName);
      if (!phase) {
        throw new GeneracyError(
          ErrorCode.WorkflowValidationError,
          `Phase "${selectedPhase.phaseName}" not found`
        );
      }

      // Execute just this phase
      const result = await executor.executePhase(
        phase,
        workflow.phases.indexOf(phase),
        workflow.phases.length,
        options,
        workflow.name
      );

      // Show result notification
      if (result.status === 'completed') {
        vscode.window.showInformationMessage(
          `Phase "${selectedPhase.phaseName}" completed successfully`
        );
      } else {
        vscode.window.showErrorMessage(
          `Phase "${selectedPhase.phaseName}" failed`
        );
      }

      return result;
    }
  );
}

/**
 * Validate workflow command handler (dry-run)
 */
export async function validateWorkflow(arg?: unknown): Promise<void> {
  const logger = getLogger();
  logger.info('Command: Validate Workflow');

  const executor = getWorkflowExecutor();
  const outputChannel = getRunnerOutputChannel();

  // Get workflow file
  const uri = await getWorkflowUri(arg);
  if (!uri) {
    logger.info('Validate cancelled - no workflow selected');
    return;
  }

  // Parse workflow
  const workflow = await parseWorkflowFile(uri);
  logger.info(`Validating workflow: ${workflow.name}`);

  // Get working directory
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath;

  // Build execution options for dry-run
  const options: ExecutionOptions = {
    mode: 'dry-run',
    env: workflow.env,
    cwd,
    verbose: true,
  };

  // Show output channel
  outputChannel.show(true);

  // Execute dry-run
  const result = await executor.execute(workflow, options);

  // Show result notification
  if (result.status === 'completed') {
    vscode.window.showInformationMessage(
      `Workflow "${workflow.name}" is valid`
    );
  } else {
    vscode.window.showErrorMessage(
      `Workflow "${workflow.name}" validation failed`
    );
  }
}

/**
 * Initialize runner commands
 */
export function initializeRunner(context: vscode.ExtensionContext): void {
  const outputChannel = getRunnerOutputChannel();
  const terminal = getWorkflowTerminal();

  outputChannel.initialize(context);
  terminal.initialize(context);
}
