/**
 * Editor features for Generacy workflow YAML files.
 * Provides IntelliSense, diagnostics, hover, and formatting.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils';

// Completion provider
export { WorkflowCompletionProvider, registerCompletionProvider } from './completion';

// Diagnostic provider
export {
  WorkflowDiagnosticProvider,
  getDiagnosticProvider,
  registerDiagnosticProvider,
  validateDocument,
} from './diagnostics';

// Hover provider
export { WorkflowHoverProvider, registerHoverProvider } from './hover';

// YAML formatter
export {
  WorkflowFormattingProvider,
  registerFormattingProvider,
  formatWorkflowYaml,
  formatYaml,
} from './yaml-formatter';

export type { FormatterOptions } from './yaml-formatter';

/**
 * Registers all editor features for workflow files
 */
export function registerEditorFeatures(context: vscode.ExtensionContext): vscode.Disposable[] {
  const logger = getLogger();
  const disposables: vscode.Disposable[] = [];

  logger.info('Registering workflow editor features');

  // Register completion provider
  const { registerCompletionProvider } = require('./completion');
  disposables.push(...registerCompletionProvider(context));

  // Register diagnostic provider
  const { registerDiagnosticProvider } = require('./diagnostics');
  disposables.push(registerDiagnosticProvider(context));

  // Register hover provider
  const { registerHoverProvider } = require('./hover');
  disposables.push(...registerHoverProvider(context));

  // Register formatting provider
  const { registerFormattingProvider } = require('./yaml-formatter');
  disposables.push(...registerFormattingProvider(context));

  logger.info('Workflow editor features registered');

  return disposables;
}
