/**
 * Reusable error message templates for common scenarios.
 * Each template follows the What-Why-How pattern and includes default recovery actions.
 */
import * as vscode from 'vscode';
import { ErrorCode, GeneracyError, ErrorDisplayOptions } from './errors';
import { getLogger } from './logger';

/**
 * Error template for configuration errors (missing/invalid config)
 */
export function configurationError(
  settingKey: string,
  details?: string
): { error: GeneracyError; options: ErrorDisplayOptions } {
  const message = details
    ? `Configuration setting "${settingKey}" is invalid. ${details}. Update this setting in your workspace or user settings.`
    : `Required configuration setting "${settingKey}" is missing. Set this value in your workspace or user settings to continue.`;

  return {
    error: new GeneracyError(ErrorCode.ConfigMissing, message, {
      details: { settingKey },
    }),
    options: {
      actions: [
        {
          label: 'Open Settings',
          action: () =>
            vscode.commands.executeCommand(
              'workbench.action.openSettings',
              `@ext:generacy ${settingKey}`
            ),
        },
      ],
      showOutput: true,
    },
  };
}

/**
 * Error template for file system errors (not found, permission denied)
 */
export function fileSystemError(
  operation: 'read' | 'write' | 'delete' | 'create',
  filePath: string,
  reason?: string
): { error: GeneracyError; options: ErrorDisplayOptions } {
  const operations = {
    read: {
      what: 'Unable to read file',
      why: reason ?? 'The file may not exist, may be locked, or you may not have read permissions',
      code: ErrorCode.FileReadError,
    },
    write: {
      what: 'Unable to write file',
      why: reason ?? 'The file may be read-only, locked, or you may not have write permissions',
      code: ErrorCode.FileWriteError,
    },
    delete: {
      what: 'Unable to delete file',
      why: reason ?? 'The file may be in use by another program or you may not have delete permissions',
      code: ErrorCode.FileWriteError,
    },
    create: {
      what: 'Unable to create file',
      why: reason ?? 'The directory may not exist or you may not have write permissions',
      code: ErrorCode.FileWriteError,
    },
  };

  const op = operations[operation];
  const message = `${op.what}: ${filePath}. ${op.why}. Check file permissions and ensure the file is not open in another program.`;

  return {
    error: new GeneracyError(op.code, message, {
      details: { operation, filePath },
    }),
    options: {
      actions: [
        {
          label: 'Show in Explorer',
          action: () =>
            vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(filePath)
            ),
        },
        {
          label: 'Show Logs',
          action: () => getLogger().show(),
        },
      ],
      showOutput: true,
    },
  };
}

/**
 * Error template for network errors (offline, timeout, rate limited)
 */
export function networkError(
  type: 'offline' | 'timeout' | 'rate-limited' | 'server-error',
  endpoint?: string
): { error: GeneracyError; options: ErrorDisplayOptions } {
  const errors = {
    offline: {
      message:
        'Unable to connect to Generacy API. Your internet connection may be offline or the service may be temporarily unavailable. Check your connection and try again.',
      code: ErrorCode.ApiConnectionError,
      actions: [
        { label: 'Retry', action: async () => { /* Will be overridden by caller */ } },
        { label: 'Work Offline', action: () => vscode.commands.executeCommand('generacy.enableOfflineMode') },
      ],
    },
    timeout: {
      message:
        'Request to Generacy API timed out. The server may be experiencing high load or your connection may be slow. Try again in a moment.',
      code: ErrorCode.ApiConnectionError,
      actions: [
        { label: 'Retry', action: async () => { /* Will be overridden by caller */ } },
      ],
    },
    'rate-limited': {
      message:
        'Too many requests to Generacy API. You have exceeded the rate limit. Wait a few minutes before trying again, or upgrade your plan for higher limits.',
      code: ErrorCode.ApiRateLimited,
      actions: [
        { label: 'View Plans', action: () => vscode.env.openExternal(vscode.Uri.parse('https://generacy.ai/pricing')) },
      ],
    },
    'server-error': {
      message:
        'Generacy API returned an error. The server encountered a problem processing your request. This may be temporary - try again in a moment.',
      code: ErrorCode.ApiRequestError,
      actions: [
        { label: 'Retry', action: async () => { /* Will be overridden by caller */ } },
        { label: 'Check Status', action: () => vscode.env.openExternal(vscode.Uri.parse('https://status.generacy.ai')) },
      ],
    },
  };

  const error = errors[type];
  const message = endpoint ? `${error.message} (Endpoint: ${endpoint})` : error.message;

  return {
    error: new GeneracyError(error.code, message, {
      details: { type, endpoint },
    }),
    options: {
      actions: error.actions,
      showOutput: true,
    },
  };
}

/**
 * Error template for authentication errors (required, expired, failed)
 */
export function authenticationError(
  type: 'required' | 'expired' | 'failed'
): { error: GeneracyError; options: ErrorDisplayOptions } {
  const errors = {
    required: {
      message:
        'Authentication required. You must sign in to Generacy to use cloud features. Click "Sign In" below to authenticate with your account.',
      code: ErrorCode.AuthRequired,
      actions: [
        { label: 'Sign In', action: () => vscode.commands.executeCommand('generacy.signIn') },
      ],
    },
    expired: {
      message:
        'Authentication has expired. Your session has timed out for security reasons. Sign in again to continue using cloud features.',
      code: ErrorCode.AuthExpired,
      actions: [
        { label: 'Sign In', action: () => vscode.commands.executeCommand('generacy.signIn') },
      ],
    },
    failed: {
      message:
        'Authentication failed. Your credentials could not be verified. Check your username and password, or contact support if you continue to experience issues.',
      code: ErrorCode.AuthFailed,
      actions: [
        { label: 'Try Again', action: () => vscode.commands.executeCommand('generacy.signIn') },
        { label: 'Get Help', action: () => vscode.env.openExternal(vscode.Uri.parse('https://generacy.ai/support')) },
      ],
    },
  };

  const error = errors[type];

  return {
    error: new GeneracyError(error.code, error.message),
    options: {
      actions: error.actions,
      modal: true,
    },
  };
}

/**
 * Error template for workflow validation errors
 */
export function validationError(
  field: string,
  issue: string,
  filePath?: string,
  line?: number
): { error: GeneracyError; options: ErrorDisplayOptions } {
  const location = line ? ` (line ${line})` : '';
  const message = `Workflow validation failed: ${issue} in field "${field}"${location}. Review your workflow file and correct the validation errors.`;

  const actions: Array<{ label: string; action: () => void | Promise<void> }> = [
    {
      label: 'View Schema',
      action: () => vscode.commands.executeCommand('generacy.showSchema'),
    },
  ];

  if (filePath && line) {
    actions.unshift({
      label: 'Go to Error',
      action: async () => {
        const document = await vscode.workspace.openTextDocument(filePath);
        const editor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      },
    });
  }

  return {
    error: new GeneracyError(ErrorCode.WorkflowValidationError, message, {
      details: { field, issue, filePath, line },
    }),
    options: {
      actions,
      showOutput: true,
    },
  };
}

/**
 * Error template for workflow execution errors
 */
export function executionError(
  phase: string,
  step: string,
  reason: string,
  exitCode?: number
): { error: GeneracyError; options: ErrorDisplayOptions } {
  const codeInfo = exitCode !== undefined ? ` (exit code: ${exitCode})` : '';
  const message = `Workflow execution failed in phase "${phase}", step "${step}"${codeInfo}. ${reason}. Check the output logs for detailed error information.`;

  return {
    error: new GeneracyError(ErrorCode.WorkflowExecutionError, message, {
      details: { phase, step, reason, exitCode },
    }),
    options: {
      actions: [
        {
          label: 'View Output',
          action: () => getLogger().show(),
        },
        {
          label: 'Debug',
          action: () => vscode.commands.executeCommand('generacy.debugWorkflow'),
        },
      ],
      showOutput: true,
    },
  };
}

/**
 * Error template for directory not found errors
 */
export function directoryNotFoundError(
  dirPath: string
): { error: GeneracyError; options: ErrorDisplayOptions } {
  const message = `Directory not found: ${dirPath}. The workflow directory may not exist or may have been moved. Create the directory or update your settings.`;

  return {
    error: new GeneracyError(ErrorCode.DirectoryNotFound, message, {
      details: { dirPath },
    }),
    options: {
      actions: [
        {
          label: 'Create Directory',
          action: async () => {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
            vscode.window.showInformationMessage(`Created directory: ${dirPath}`);
          },
        },
        {
          label: 'Choose Directory',
          action: async () => {
            const uri = await vscode.window.showOpenDialog({
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
              title: 'Select Workflow Directory',
            });
            if (uri?.[0]) {
              await vscode.workspace
                .getConfiguration('generacy')
                .update('workflowDirectory', uri[0].fsPath, vscode.ConfigurationTarget.Workspace);
              vscode.window.showInformationMessage(`Updated workflow directory to: ${uri[0].fsPath}`);
            }
          },
        },
      ],
      showOutput: true,
    },
  };
}

/**
 * Error template for file not found errors with browse action
 */
export function fileNotFoundError(
  filePath: string,
  fileType: 'workflow' | 'config' | 'data' = 'workflow'
): { error: GeneracyError; options: ErrorDisplayOptions } {
  const message = `${fileType.charAt(0).toUpperCase() + fileType.slice(1)} file not found: ${filePath}. The file may have been moved, renamed, or deleted. Check the path and try refreshing.`;

  return {
    error: new GeneracyError(ErrorCode.FileNotFound, message, {
      details: { filePath, fileType },
    }),
    options: {
      actions: [
        {
          label: 'Browse Files',
          action: async () => {
            const uri = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              filters: fileType === 'workflow' ? { 'Workflows': ['yaml', 'yml'] } : undefined,
              title: `Select ${fileType.charAt(0).toUpperCase() + fileType.slice(1)} File`,
            });
            if (uri?.[0]) {
              vscode.window.showInformationMessage(`Selected: ${uri[0].fsPath}`);
              // Caller should handle the selected file
            }
          },
        },
        {
          label: 'Refresh Explorer',
          action: () => vscode.commands.executeCommand('generacy.refreshExplorer'),
        },
      ],
      showOutput: true,
    },
  };
}

/**
 * Helper to create a retry action with a custom handler
 */
export function createRetryAction(handler: () => Promise<void>): { label: string; action: () => Promise<void> } {
  return {
    label: 'Retry',
    action: handler,
  };
}

/**
 * Helper to create a "Show Logs" action
 */
export function createShowLogsAction(): { label: string; action: () => void } {
  return {
    label: 'Show Logs',
    action: () => getLogger().show(),
  };
}

/**
 * Helper to create a "Get Help" action
 */
export function createGetHelpAction(): { label: string; action: () => void } {
  return {
    label: 'Get Help',
    action: () => vscode.env.openExternal(vscode.Uri.parse('https://generacy.ai/docs')),
  };
}
