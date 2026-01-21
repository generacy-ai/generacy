/**
 * Diagnostic provider for Generacy workflow YAML files.
 * Provides real-time validation and error reporting.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils';
import { LANGUAGE_IDS, WORKFLOW_FILE_PATTERNS } from '../../../constants';
import {
  validateWorkflowFull,
  ValidationResult,
  ValidationError,
  ValidationSeverity,
} from '../../../language/validator';

/**
 * Diagnostic collection name
 */
const DIAGNOSTIC_COLLECTION_NAME = 'generacy';

/**
 * Debounce delay for validation (ms)
 */
const VALIDATION_DEBOUNCE_MS = 300;

/**
 * Diagnostic provider for workflow validation
 */
export class WorkflowDiagnosticProvider implements vscode.Disposable {
  private readonly logger = getLogger().child('diagnostics');
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly validationTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION_NAME);

    // Subscribe to document events
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.onDocumentOpened(doc)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onDocumentClosed(doc)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSaved(doc))
    );

    // Validate all open workflow documents
    this.validateOpenDocuments();

    this.logger.info('Diagnostic provider initialized');
  }

  /**
   * Validates all currently open workflow documents
   */
  private validateOpenDocuments(): void {
    for (const document of vscode.workspace.textDocuments) {
      if (this.isWorkflowDocument(document)) {
        this.validateDocument(document);
      }
    }
  }

  /**
   * Called when a document is opened
   */
  private onDocumentOpened(document: vscode.TextDocument): void {
    if (this.isWorkflowDocument(document)) {
      this.validateDocument(document);
    }
  }

  /**
   * Called when a document changes
   */
  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (this.isWorkflowDocument(event.document)) {
      this.scheduleValidation(event.document);
    }
  }

  /**
   * Called when a document is closed
   */
  private onDocumentClosed(document: vscode.TextDocument): void {
    // Clear diagnostics for closed document
    this.diagnosticCollection.delete(document.uri);

    // Cancel any pending validation
    const timer = this.validationTimers.get(document.uri.toString());
    if (timer) {
      clearTimeout(timer);
      this.validationTimers.delete(document.uri.toString());
    }
  }

  /**
   * Called when a document is saved
   */
  private onDocumentSaved(document: vscode.TextDocument): void {
    if (this.isWorkflowDocument(document)) {
      // Validate immediately on save
      this.validateDocument(document);
    }
  }

  /**
   * Checks if a document is a workflow file
   */
  private isWorkflowDocument(document: vscode.TextDocument): boolean {
    // Check language ID
    if (document.languageId === LANGUAGE_IDS.workflow) {
      return true;
    }

    // Check if it's a YAML file in the .generacy directory
    if (document.languageId === LANGUAGE_IDS.yaml || document.languageId === 'yaml') {
      const path = document.uri.fsPath;
      return path.includes('.generacy') && (path.endsWith('.yaml') || path.endsWith('.yml'));
    }

    return false;
  }

  /**
   * Schedules validation with debouncing
   */
  private scheduleValidation(document: vscode.TextDocument): void {
    const uri = document.uri.toString();

    // Cancel existing timer
    const existingTimer = this.validationTimers.get(uri);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new validation
    const timer = setTimeout(() => {
      this.validationTimers.delete(uri);
      this.validateDocument(document);
    }, VALIDATION_DEBOUNCE_MS);

    this.validationTimers.set(uri, timer);
  }

  /**
   * Validates a document and updates diagnostics
   */
  public validateDocument(document: vscode.TextDocument): void {
    try {
      const content = document.getText();

      if (!content.trim()) {
        // Empty document - clear diagnostics
        this.diagnosticCollection.set(document.uri, []);
        return;
      }

      // Perform validation
      const result = validateWorkflowFull(content);

      // Convert validation errors to diagnostics
      const diagnostics = this.convertToDiagnostics(document, result);

      // Update diagnostic collection
      this.diagnosticCollection.set(document.uri, diagnostics);

      this.logger.debug(`Validated ${document.uri.fsPath}: ${result.valid ? 'valid' : `${result.errors.length} errors`}`);
    } catch (error) {
      this.logger.error('Error validating document', error as Error);

      // Show a single error diagnostic for unexpected errors
      this.diagnosticCollection.set(document.uri, [
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          vscode.DiagnosticSeverity.Error
        ),
      ]);
    }
  }

  /**
   * Converts validation result to VS Code diagnostics
   */
  private convertToDiagnostics(document: vscode.TextDocument, result: ValidationResult): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];

    for (const error of result.errors) {
      const diagnostic = this.createDiagnostic(document, error);
      diagnostics.push(diagnostic);
    }

    return diagnostics;
  }

  /**
   * Creates a VS Code Diagnostic from a validation error
   */
  private createDiagnostic(document: vscode.TextDocument, error: ValidationError): vscode.Diagnostic {
    // Get the range for the error
    const range = this.getErrorRange(document, error);

    // Map severity
    const severity = this.mapSeverity(error.severity);

    // Create diagnostic
    const diagnostic = new vscode.Diagnostic(range, error.message, severity);

    // Set source
    diagnostic.source = 'Generacy';

    // Set error code if available
    if (error.code) {
      diagnostic.code = error.code;
    }

    // Add related information for path
    if (error.path.length > 0) {
      const pathString = error.path.join('.');
      diagnostic.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(document.uri, range),
          `At path: ${pathString}`
        ),
      ];
    }

    return diagnostic;
  }

  /**
   * Gets the range for an error in the document
   */
  private getErrorRange(document: vscode.TextDocument, error: ValidationError): vscode.Range {
    // If the error has a range, use it
    if (error.range) {
      return new vscode.Range(
        new vscode.Position(error.range.start.line - 1, error.range.start.column - 1),
        new vscode.Position(error.range.end.line - 1, error.range.end.column - 1)
      );
    }

    // Try to find the range from the path
    if (error.path.length > 0) {
      const range = this.findRangeFromPath(document, error.path);
      if (range) {
        return range;
      }
    }

    // Default to the first line
    return new vscode.Range(0, 0, 0, document.lineAt(0).text.length);
  }

  /**
   * Finds a range in the document from a path
   */
  private findRangeFromPath(document: vscode.TextDocument, path: (string | number)[]): vscode.Range | null {
    const text = document.getText();
    const lines = text.split('\n');

    // Build a search pattern based on the path
    // For example, ['phases', 0, 'steps', 1, 'name'] should find the second step's name in the first phase

    let currentIndent = 0;
    let foundLine = -1;

    for (let pathIdx = 0; pathIdx < path.length; pathIdx++) {
      const segment = path[pathIdx];
      const isLast = pathIdx === path.length - 1;

      if (typeof segment === 'number') {
        // Array index - count occurrences
        let count = 0;
        for (let i = foundLine + 1; i < lines.length; i++) {
          const line = lines[i];
          const lineIndent = this.getIndent(line);

          if (lineIndent <= currentIndent && line.trim() && !line.trim().startsWith('#')) {
            // We've exited the current context
            break;
          }

          if (line.trim().startsWith('-') && lineIndent === currentIndent + 2) {
            if (count === segment) {
              foundLine = i;
              currentIndent = lineIndent;
              break;
            }
            count++;
          }
        }
      } else {
        // Property name - search for key
        const searchPattern = new RegExp(`^\\s{${currentIndent}}${segment}:`);
        const arrayItemPattern = new RegExp(`^\\s{${currentIndent}}-\\s*${segment}:`);

        for (let i = foundLine + 1; i < lines.length; i++) {
          const line = lines[i];

          if (searchPattern.test(line) || arrayItemPattern.test(line)) {
            foundLine = i;
            currentIndent = this.getIndent(line) + 2;

            if (isLast) {
              // Found the target - return the range
              const startCol = line.indexOf(segment);
              return new vscode.Range(
                i,
                startCol,
                i,
                startCol + segment.length
              );
            }
            break;
          }
        }
      }
    }

    // If we found something, return its line
    if (foundLine >= 0) {
      const line = lines[foundLine];
      return new vscode.Range(foundLine, 0, foundLine, line.length);
    }

    return null;
  }

  /**
   * Gets the indentation level of a line
   */
  private getIndent(line: string): number {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }

  /**
   * Maps validation severity to VS Code diagnostic severity
   */
  private mapSeverity(severity: ValidationSeverity): vscode.DiagnosticSeverity {
    switch (severity) {
      case ValidationSeverity.Error:
        return vscode.DiagnosticSeverity.Error;
      case ValidationSeverity.Warning:
        return vscode.DiagnosticSeverity.Warning;
      case ValidationSeverity.Info:
        return vscode.DiagnosticSeverity.Information;
      case ValidationSeverity.Hint:
        return vscode.DiagnosticSeverity.Hint;
      default:
        return vscode.DiagnosticSeverity.Error;
    }
  }

  /**
   * Clears all diagnostics
   */
  public clearAll(): void {
    this.diagnosticCollection.clear();
  }

  /**
   * Clears diagnostics for a specific URI
   */
  public clear(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri);
  }

  /**
   * Disposes the provider
   */
  public dispose(): void {
    // Clear all timers
    for (const timer of this.validationTimers.values()) {
      clearTimeout(timer);
    }
    this.validationTimers.clear();

    // Dispose of subscriptions
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    // Clear and dispose diagnostic collection
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();

    this.logger.info('Diagnostic provider disposed');
  }
}

/**
 * Global diagnostic provider instance
 */
let diagnosticProvider: WorkflowDiagnosticProvider | undefined;

/**
 * Gets or creates the diagnostic provider
 */
export function getDiagnosticProvider(): WorkflowDiagnosticProvider {
  if (!diagnosticProvider) {
    diagnosticProvider = new WorkflowDiagnosticProvider();
  }
  return diagnosticProvider;
}

/**
 * Registers the diagnostic provider
 */
export function registerDiagnosticProvider(context: vscode.ExtensionContext): vscode.Disposable {
  const logger = getLogger();

  // Create and register the provider
  diagnosticProvider = new WorkflowDiagnosticProvider();

  // Register a validate command
  const validateCommand = vscode.commands.registerCommand('generacy.validateWorkflow', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && diagnosticProvider) {
      diagnosticProvider.validateDocument(editor.document);
      vscode.window.showInformationMessage('Workflow validated');
    }
  });

  logger.info('Registered diagnostic provider');

  // Return a disposable that cleans up everything
  return vscode.Disposable.from(diagnosticProvider, validateCommand);
}

/**
 * Validates a workflow document and returns the result
 */
export function validateDocument(document: vscode.TextDocument): ValidationResult {
  const content = document.getText();
  return validateWorkflowFull(content);
}
