/**
 * Editor features for Generacy workflow YAML files.
 * Provides CodeLens, Code Actions, IntelliSense, diagnostics, hover, and formatting.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils';
import { registerCompletionProvider as _registerCompletion } from './completion';
import { registerDiagnosticProvider as _registerDiagnostics } from './diagnostics';
import { registerHoverProvider as _registerHover } from './hover';
import { registerFormattingProvider as _registerFormatting } from './yaml-formatter';

// CodeLens and Code Action providers
export {
  WorkflowCodeLensProvider,
  WorkflowCodeActionProvider,
  createWorkflowCodeLensProvider,
  createWorkflowCodeActionProvider,
} from './codelens';

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
  disposables.push(..._registerCompletion(context));

  // Register diagnostic provider
  disposables.push(_registerDiagnostics(context));

  // Register hover provider
  disposables.push(..._registerHover(context));

  // Register formatting provider
  disposables.push(..._registerFormatting(context));

  logger.info('Workflow editor features registered');

  return disposables;
}
