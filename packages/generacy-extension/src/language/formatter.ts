/**
 * Validation error formatter for VS Code diagnostics.
 * Converts validation errors into VS Code-compatible diagnostic objects.
 */
import * as vscode from 'vscode';
import { ValidationError, ValidationResult, ValidationSeverity, Range } from './validator';

/**
 * Converts a ValidationSeverity to VS Code DiagnosticSeverity
 */
function toVsCodeSeverity(severity: ValidationSeverity): vscode.DiagnosticSeverity {
  switch (severity) {
    case ValidationSeverity.Error:
      return vscode.DiagnosticSeverity.Error;
    case ValidationSeverity.Warning:
      return vscode.DiagnosticSeverity.Warning;
    case ValidationSeverity.Info:
      return vscode.DiagnosticSeverity.Information;
    case ValidationSeverity.Hint:
      return vscode.DiagnosticSeverity.Hint;
  }
}

/**
 * Converts a validation Range to a VS Code Range
 * Note: VS Code ranges are 0-based, validation ranges are 1-based
 */
function toVsCodeRange(range: Range | undefined, document: vscode.TextDocument): vscode.Range {
  if (range) {
    return new vscode.Range(
      new vscode.Position(range.start.line - 1, range.start.column - 1),
      new vscode.Position(range.end.line - 1, range.end.column - 1)
    );
  }
  // Default to first line if no range is available
  return new vscode.Range(0, 0, 0, document.lineAt(0).text.length);
}

/**
 * Formats a path array as a human-readable string
 */
function formatPath(path: (string | number)[]): string {
  if (path.length === 0) {
    return '';
  }

  return path
    .map((segment, index) => {
      if (typeof segment === 'number') {
        return `[${segment}]`;
      }
      return index === 0 ? segment : `.${segment}`;
    })
    .join('');
}

/**
 * Creates a diagnostic message with path context
 */
function formatDiagnosticMessage(error: ValidationError): string {
  const pathStr = formatPath(error.path);
  const locationPrefix = pathStr ? `${pathStr}: ` : '';
  let message = `${locationPrefix}${error.message}`;

  if (error.suggestions && error.suggestions.length > 0) {
    message += `\n\nSuggestions:\n${error.suggestions.map((s) => `  - ${s}`).join('\n')}`;
  }

  return message;
}

/**
 * Converts a single validation error to a VS Code Diagnostic
 */
export function toDiagnostic(
  error: ValidationError,
  document: vscode.TextDocument
): vscode.Diagnostic {
  const range = toVsCodeRange(error.range, document);
  const message = formatDiagnosticMessage(error);
  const severity = toVsCodeSeverity(error.severity);

  const diagnostic = new vscode.Diagnostic(range, message, severity);

  // Add diagnostic code for quick fixes
  if (error.code) {
    diagnostic.code = error.code;
  }

  // Mark as coming from Generacy
  diagnostic.source = 'Generacy';

  // Add related information if there are suggestions
  if (error.suggestions && error.suggestions.length > 0) {
    diagnostic.relatedInformation = error.suggestions.map((suggestion) => ({
      location: new vscode.Location(document.uri, range),
      message: suggestion,
    }));
  }

  return diagnostic;
}

/**
 * Converts a validation result to an array of VS Code Diagnostics
 */
export function toDiagnostics(
  result: ValidationResult,
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  return result.errors.map((error) => toDiagnostic(error, document));
}

/**
 * Diagnostic collection for managing workflow diagnostics
 */
export class WorkflowDiagnosticCollection {
  private collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('generacy');
  }

  /**
   * Sets diagnostics for a document from a validation result
   */
  public set(document: vscode.TextDocument, result: ValidationResult): void {
    const diagnostics = toDiagnostics(result, document);
    this.collection.set(document.uri, diagnostics);
  }

  /**
   * Sets diagnostics directly for a URI
   */
  public setDiagnostics(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void {
    this.collection.set(uri, diagnostics);
  }

  /**
   * Clears diagnostics for a document
   */
  public clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  /**
   * Clears all diagnostics
   */
  public clearAll(): void {
    this.collection.clear();
  }

  /**
   * Gets the underlying diagnostic collection for disposal
   */
  public getCollection(): vscode.DiagnosticCollection {
    return this.collection;
  }

  /**
   * Disposes the diagnostic collection
   */
  public dispose(): void {
    this.collection.dispose();
  }
}

/**
 * Formats validation errors as a human-readable summary
 */
export function formatValidationSummary(result: ValidationResult): string {
  if (result.valid) {
    return 'Workflow validation passed';
  }

  const errorCount = result.errors.filter((e) => e.severity === ValidationSeverity.Error).length;
  const warningCount = result.errors.filter((e) => e.severity === ValidationSeverity.Warning).length;
  const infoCount = result.errors.filter((e) => e.severity === ValidationSeverity.Info).length;

  const parts: string[] = [];
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
  if (warningCount > 0) parts.push(`${warningCount} warning${warningCount > 1 ? 's' : ''}`);
  if (infoCount > 0) parts.push(`${infoCount} info message${infoCount > 1 ? 's' : ''}`);

  return `Workflow validation failed: ${parts.join(', ')}`;
}

/**
 * Formats validation errors as detailed text output
 */
export function formatValidationDetails(result: ValidationResult): string {
  if (result.valid) {
    return 'No issues found';
  }

  const lines: string[] = [];

  for (const error of result.errors) {
    const severityLabel = error.severity.toUpperCase();
    const pathStr = formatPath(error.path);
    const location = pathStr ? ` at ${pathStr}` : '';
    const rangeStr = error.range
      ? ` (line ${error.range.start.line}, col ${error.range.start.column})`
      : '';

    lines.push(`[${severityLabel}]${location}${rangeStr}: ${error.message}`);

    if (error.suggestions && error.suggestions.length > 0) {
      for (const suggestion of error.suggestions) {
        lines.push(`  - ${suggestion}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Quick fix action types for workflow validation errors
 */
export enum QuickFixAction {
  AddRequiredProperty = 'addRequiredProperty',
  RemoveUnknownProperty = 'removeUnknownProperty',
  FixPropertyType = 'fixPropertyType',
  FixPropertyValue = 'fixPropertyValue',
}

/**
 * Interface for quick fix suggestions
 */
export interface QuickFix {
  title: string;
  action: QuickFixAction;
  params: Record<string, unknown>;
}

/**
 * Generates quick fix suggestions for a validation error
 */
export function getQuickFixes(error: ValidationError): QuickFix[] {
  const fixes: QuickFix[] = [];

  switch (error.code) {
    case 'invalid_type':
      fixes.push({
        title: `Fix type for ${formatPath(error.path)}`,
        action: QuickFixAction.FixPropertyType,
        params: { path: error.path },
      });
      break;

    case 'unrecognized_keys':
      fixes.push({
        title: 'Remove unrecognized properties',
        action: QuickFixAction.RemoveUnknownProperty,
        params: { path: error.path },
      });
      break;

    case 'invalid_string':
      if (error.suggestions && error.suggestions.length > 0) {
        fixes.push({
          title: 'Fix value format',
          action: QuickFixAction.FixPropertyValue,
          params: { path: error.path, suggestions: error.suggestions },
        });
      }
      break;
  }

  return fixes;
}
