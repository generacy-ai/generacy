/**
 * CodeLens provider for Generacy workflow YAML files.
 * Provides clickable actions above phases and steps:
 * - "Run Phase" above each phase definition
 * - "Debug Step" above each step
 * - "Validate" at document top
 */
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import { COMMANDS, WORKFLOW_FILE_PATTERNS } from '../../../constants';
import { getLogger } from '../../../utils';

/**
 * Position information for a YAML node
 */
interface NodePosition {
  line: number;
  column: number;
}

/**
 * Phase information extracted from YAML
 */
interface PhaseInfo {
  name: string;
  position: NodePosition;
  steps: StepInfo[];
}

/**
 * Step information extracted from YAML
 */
interface StepInfo {
  name: string;
  position: NodePosition;
  phaseIndex: number;
  stepIndex: number;
}

/**
 * CodeLens provider for workflow files
 */
export class WorkflowCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  /**
   * Refresh CodeLenses when documents change
   */
  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Provide CodeLenses for a document
   */
  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const logger = getLogger();

    // Only provide CodeLenses for workflow files
    if (!this.isWorkflowFile(document)) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];

    try {
      // Parse the YAML document
      const content = document.getText();
      const doc = yaml.parseDocument(content, { keepSourceTokens: true });

      if (doc.errors.length > 0) {
        // Document has parse errors, just add validate lens at top
        codeLenses.push(this.createValidateCodeLens(document, 0));
        return codeLenses;
      }

      // Add "Validate" CodeLens at document top
      codeLenses.push(this.createValidateCodeLens(document, 0));

      // Extract phases and steps
      const phases = this.extractPhases(doc, content);

      // Add CodeLenses for phases and steps
      for (const phase of phases) {
        // Add "Run Phase" CodeLens above each phase
        codeLenses.push(this.createRunPhaseCodeLens(document, phase));

        // Add "Debug Step" CodeLens above each step
        for (const step of phase.steps) {
          codeLenses.push(this.createDebugStepCodeLens(document, step, phase.name));
        }
      }
    } catch (error) {
      logger.debug('Error parsing workflow for CodeLens', { error: String(error) });
      // Return just the validate lens on parse error
      codeLenses.push(this.createValidateCodeLens(document, 0));
    }

    return codeLenses;
  }

  /**
   * Check if document is a workflow file
   */
  private isWorkflowFile(document: vscode.TextDocument): boolean {
    const filePath = document.uri.fsPath;

    // Quick check for workflow file patterns:
    // 1. Files in .generacy directory with .yaml/.yml extension
    // 2. Files with .generacy.yaml or .generacy.yml extension
    if (
      (filePath.includes('.generacy') || filePath.includes('/.generacy/')) &&
      (filePath.endsWith('.yaml') || filePath.endsWith('.yml'))
    ) {
      return true;
    }

    // Additional pattern matching for more complex cases
    const patterns = [
      WORKFLOW_FILE_PATTERNS.yaml,
      WORKFLOW_FILE_PATTERNS.yml,
      '**/*.generacy.yaml',
      '**/*.generacy.yml',
    ];

    for (const pattern of patterns) {
      if (this.matchesGlobPattern(filePath, pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Simple glob pattern matching
   */
  private matchesGlobPattern(filePath: string, pattern: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    const regexPattern = normalizedPattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '{{DOUBLE_STAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/{{DOUBLE_STAR}}/g, '.*');

    const regex = new RegExp(`${regexPattern}$`, 'i');
    return regex.test(normalizedPath);
  }

  /**
   * Extract phase and step information from YAML document
   */
  private extractPhases(doc: yaml.Document, content: string): PhaseInfo[] {
    const phases: PhaseInfo[] = [];
    const root = doc.contents;

    if (!yaml.isMap(root)) {
      return phases;
    }

    // Find the 'phases' key
    const phasesNode = root.items.find((item) => {
      const key = item.key;
      return yaml.isScalar(key) && key.value === 'phases';
    });

    if (!phasesNode || !yaml.isSeq(phasesNode.value)) {
      return phases;
    }

    const phasesArray = phasesNode.value;

    for (let phaseIndex = 0; phaseIndex < phasesArray.items.length; phaseIndex++) {
      const phaseNode = phasesArray.items[phaseIndex];

      if (!yaml.isMap(phaseNode)) {
        continue;
      }

      // Get phase name
      const nameNode = phaseNode.items.find((item) => {
        const key = item.key;
        return yaml.isScalar(key) && key.value === 'name';
      });

      const phaseName = nameNode && yaml.isScalar(nameNode.value)
        ? String(nameNode.value.value)
        : `Phase ${phaseIndex + 1}`;

      // Get phase position
      const phasePosition = this.getNodePosition(phaseNode, content);

      // Extract steps
      const steps = this.extractSteps(phaseNode, content, phaseIndex);

      phases.push({
        name: phaseName,
        position: phasePosition,
        steps,
      });
    }

    return phases;
  }

  /**
   * Extract step information from a phase node
   */
  private extractSteps(
    phaseNode: yaml.YAMLMap,
    content: string,
    phaseIndex: number
  ): StepInfo[] {
    const steps: StepInfo[] = [];

    // Find the 'steps' key
    const stepsNode = phaseNode.items.find((item) => {
      const key = item.key;
      return yaml.isScalar(key) && key.value === 'steps';
    });

    if (!stepsNode || !yaml.isSeq(stepsNode.value)) {
      return steps;
    }

    const stepsArray = stepsNode.value;

    for (let stepIndex = 0; stepIndex < stepsArray.items.length; stepIndex++) {
      const stepNode = stepsArray.items[stepIndex];

      if (!yaml.isMap(stepNode)) {
        continue;
      }

      // Get step name
      const nameNode = stepNode.items.find((item) => {
        const key = item.key;
        return yaml.isScalar(key) && key.value === 'name';
      });

      const stepName = nameNode && yaml.isScalar(nameNode.value)
        ? String(nameNode.value.value)
        : `Step ${stepIndex + 1}`;

      // Get step position
      const stepPosition = this.getNodePosition(stepNode, content);

      steps.push({
        name: stepName,
        position: stepPosition,
        phaseIndex,
        stepIndex,
      });
    }

    return steps;
  }

  /**
   * Get the position of a YAML node in the document
   */
  private getNodePosition(node: yaml.Node, content: string): NodePosition {
    if (node.range) {
      const offset = node.range[0];
      return this.offsetToPosition(content, offset);
    }
    return { line: 0, column: 0 };
  }

  /**
   * Convert offset to line/column position
   */
  private offsetToPosition(content: string, offset: number): NodePosition {
    let line = 0;
    let column = 0;
    let currentOffset = 0;

    for (const char of content) {
      if (currentOffset >= offset) break;

      if (char === '\n') {
        line++;
        column = 0;
      } else {
        column++;
      }
      currentOffset++;
    }

    return { line, column };
  }

  /**
   * Create "Validate" CodeLens at document top
   */
  private createValidateCodeLens(document: vscode.TextDocument, line: number): vscode.CodeLens {
    const range = new vscode.Range(line, 0, line, 0);
    return new vscode.CodeLens(range, {
      title: '$(check) Validate',
      tooltip: 'Validate this workflow file',
      command: COMMANDS.validateWorkflow,
      arguments: [document.uri],
    });
  }

  /**
   * Create "Run Phase" CodeLens above a phase
   */
  private createRunPhaseCodeLens(document: vscode.TextDocument, phase: PhaseInfo): vscode.CodeLens {
    const range = new vscode.Range(phase.position.line, 0, phase.position.line, 0);
    return new vscode.CodeLens(range, {
      title: `$(play) Run Phase: ${phase.name}`,
      tooltip: `Run the "${phase.name}" phase`,
      command: COMMANDS.runWorkflow,
      arguments: [document.uri, { phase: phase.name }],
    });
  }

  /**
   * Create "Debug Step" CodeLens above a step
   */
  private createDebugStepCodeLens(
    document: vscode.TextDocument,
    step: StepInfo,
    phaseName: string
  ): vscode.CodeLens {
    const range = new vscode.Range(step.position.line, 0, step.position.line, 0);
    return new vscode.CodeLens(range, {
      title: `$(debug) Debug Step: ${step.name}`,
      tooltip: `Debug the "${step.name}" step in phase "${phaseName}"`,
      command: COMMANDS.debugWorkflow,
      arguments: [document.uri, { phase: phaseName, step: step.name }],
    });
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}

/**
 * Code action provider for workflow files.
 * Provides quick fixes for common validation errors.
 */
export class WorkflowCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Refactor,
  ];

  /**
   * Provide code actions for diagnostics
   */
  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] | undefined {
    // Only provide actions for workflow files
    if (!this.isWorkflowFile(document)) {
      return undefined;
    }

    const actions: vscode.CodeAction[] = [];

    // Process each diagnostic and create appropriate fixes
    for (const diagnostic of context.diagnostics) {
      const fix = this.createFixForDiagnostic(document, diagnostic);
      if (fix) {
        actions.push(fix);
      }
    }

    // Add general refactoring actions if in a relevant position
    const refactorActions = this.createRefactorActions(document, range);
    actions.push(...refactorActions);

    return actions.length > 0 ? actions : undefined;
  }

  /**
   * Check if document is a workflow file
   */
  private isWorkflowFile(document: vscode.TextDocument): boolean {
    const filePath = document.uri.fsPath;
    return filePath.includes('.generacy') &&
           (filePath.endsWith('.yaml') || filePath.endsWith('.yml'));
  }

  /**
   * Create a fix for a specific diagnostic
   */
  private createFixForDiagnostic(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const message = diagnostic.message.toLowerCase();

    // Fix: Missing required field
    if (message.includes('required')) {
      return this.createAddRequiredFieldFix(document, diagnostic);
    }

    // Fix: Duplicate name (check before generic "name" check)
    if (message.includes('duplicate')) {
      return this.createRenameDuplicateFix(document, diagnostic);
    }

    // Fix: Invalid name format
    if (message.includes('must start with a letter') || message.includes('invalid') && message.includes('name')) {
      return this.createFixNameFormatFix(document, diagnostic);
    }

    // Fix: Invalid version format
    if (message.includes('semantic versioning') || message.includes('version')) {
      return this.createFixVersionFormatFix(document, diagnostic);
    }

    // Fix: Unrecognized property
    if (message.includes('unrecognized') || message.includes('unknown property')) {
      return this.createRemoveUnknownPropertyFix(document, diagnostic);
    }

    // Fix: Step must have either "uses" or "run"
    if (message.includes('uses') && message.includes('run')) {
      return this.createAddRunOrUsesFix(document, diagnostic);
    }

    return undefined;
  }

  /**
   * Create fix for missing required field
   */
  private createAddRequiredFieldFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    // Extract field name from message
    const match = diagnostic.message.match(/['"](\w+)['"]/);
    if (!match) return undefined;

    const fieldName = match[1];
    const action = new vscode.CodeAction(
      `Add required field: ${fieldName}`,
      vscode.CodeActionKind.QuickFix
    );

    action.diagnostics = [diagnostic];
    action.isPreferred = true;

    // Create edit to add the field
    const line = diagnostic.range.end.line;
    const indent = this.getIndentation(document, line);
    const newText = `${indent}${fieldName}: \n`;

    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(
      document.uri,
      new vscode.Position(line + 1, 0),
      newText
    );

    return action;
  }

  /**
   * Create fix for invalid name format
   */
  private createFixNameFormatFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const lineText = document.lineAt(diagnostic.range.start.line).text;
    const match = lineText.match(/name:\s*['"]*([^'"]+)['"]*$/);
    if (!match || !match[1]) return undefined;

    const currentName = match[1].trim();
    // Convert to valid name: remove special chars, replace spaces with hyphens
    const fixedName = currentName
      .replace(/[^a-zA-Z0-9\s-_]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^[^a-zA-Z]+/, '')
      .toLowerCase();

    if (!fixedName || fixedName === currentName) return undefined;

    const action = new vscode.CodeAction(
      `Fix name format: "${fixedName}"`,
      vscode.CodeActionKind.QuickFix
    );

    action.diagnostics = [diagnostic];
    action.isPreferred = true;

    action.edit = new vscode.WorkspaceEdit();
    const nameMatch = lineText.match(/(name:\s*)['"]*[^'"]+['"]*$/);
    if (nameMatch) {
      const start = lineText.indexOf(nameMatch[0]);
      action.edit.replace(
        document.uri,
        new vscode.Range(
          diagnostic.range.start.line,
          start,
          diagnostic.range.start.line,
          lineText.length
        ),
        `name: ${fixedName}`
      );
    }

    return action;
  }

  /**
   * Create fix for invalid version format
   */
  private createFixVersionFormatFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const action = new vscode.CodeAction(
      'Fix version format: "1.0.0"',
      vscode.CodeActionKind.QuickFix
    );

    action.diagnostics = [diagnostic];
    action.isPreferred = true;

    const lineText = document.lineAt(diagnostic.range.start.line).text;
    const versionMatch = lineText.match(/(version:\s*)['"]*[^'"]+['"]*$/);

    if (versionMatch) {
      const start = lineText.indexOf(versionMatch[0]);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(
        document.uri,
        new vscode.Range(
          diagnostic.range.start.line,
          start,
          diagnostic.range.start.line,
          lineText.length
        ),
        'version: "1.0.0"'
      );
    }

    return action;
  }

  /**
   * Create fix to remove unknown property
   */
  private createRemoveUnknownPropertyFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const action = new vscode.CodeAction(
      'Remove unrecognized property',
      vscode.CodeActionKind.QuickFix
    );

    action.diagnostics = [diagnostic];

    // Remove the entire line containing the unknown property
    const line = diagnostic.range.start.line;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.delete(
      document.uri,
      new vscode.Range(line, 0, line + 1, 0)
    );

    return action;
  }

  /**
   * Create fix to rename duplicate
   */
  private createRenameDuplicateFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const lineText = document.lineAt(diagnostic.range.start.line).text;
    // Match name: in various contexts (including YAML sequence items with - prefix)
    const match = lineText.match(/(?:^|\s)-?\s*name:\s*['"]*([^'"\n]+)['"]*$/);
    if (!match || !match[1]) return undefined;

    const currentName = match[1].trim();
    const newName = `${currentName}-2`;

    const action = new vscode.CodeAction(
      `Rename to: "${newName}"`,
      vscode.CodeActionKind.QuickFix
    );

    action.diagnostics = [diagnostic];

    const nameMatch = lineText.match(/(name:\s*)['"]*[^'"]+['"]*$/);
    if (nameMatch) {
      const start = lineText.indexOf(nameMatch[0]);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(
        document.uri,
        new vscode.Range(
          diagnostic.range.start.line,
          start,
          diagnostic.range.start.line,
          lineText.length
        ),
        `name: ${newName}`
      );
    }

    return action;
  }

  /**
   * Create fix to add run or uses to step
   */
  private createAddRunOrUsesFix(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const action = new vscode.CodeAction(
      'Add "run" command to step',
      vscode.CodeActionKind.QuickFix
    );

    action.diagnostics = [diagnostic];
    action.isPreferred = true;

    const line = diagnostic.range.end.line;
    const indent = this.getIndentation(document, line) + '  ';
    const newText = `${indent}run: echo "TODO: Add command"\n`;

    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(
      document.uri,
      new vscode.Position(line + 1, 0),
      newText
    );

    return action;
  }

  /**
   * Create refactoring actions based on cursor position
   */
  private createRefactorActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const lineText = document.lineAt(range.start.line).text;

    // Add "Extract Step" action if on a run command
    if (lineText.includes('run:')) {
      const extractAction = new vscode.CodeAction(
        'Extract to new step',
        vscode.CodeActionKind.RefactorExtract
      );
      extractAction.command = {
        title: 'Extract Step',
        command: 'generacy.extractStep',
        arguments: [document.uri, range.start.line],
      };
      actions.push(extractAction);
    }

    // Add "Add condition" action if on a step
    if (lineText.trimStart().startsWith('- name:')) {
      const addConditionAction = new vscode.CodeAction(
        'Add condition to step',
        vscode.CodeActionKind.Refactor
      );
      const indent = this.getIndentation(document, range.start.line) + '  ';
      addConditionAction.edit = new vscode.WorkspaceEdit();
      addConditionAction.edit.insert(
        document.uri,
        new vscode.Position(range.start.line + 1, 0),
        `${indent}condition: \${{ true }}\n`
      );
      actions.push(addConditionAction);
    }

    return actions;
  }

  /**
   * Get the indentation of a line
   */
  private getIndentation(document: vscode.TextDocument, line: number): string {
    const lineText = document.lineAt(line).text;
    const match = lineText.match(/^(\s*)/);
    return match?.[1] ?? '';
  }
}

/**
 * Create and register the CodeLens provider
 */
export function createWorkflowCodeLensProvider(
  context: vscode.ExtensionContext
): WorkflowCodeLensProvider {
  const logger = getLogger();
  const provider = new WorkflowCodeLensProvider();

  // Register for workflow YAML files
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', pattern: WORKFLOW_FILE_PATTERNS.yaml },
    { scheme: 'file', pattern: WORKFLOW_FILE_PATTERNS.yml },
    { scheme: 'file', pattern: '**/*.generacy.yaml' },
    { scheme: 'file', pattern: '**/*.generacy.yml' },
  ];

  const disposable = vscode.languages.registerCodeLensProvider(selector, provider);
  context.subscriptions.push(disposable);

  // Refresh on document change
  const changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
    if (selector.some((s) => {
      const pattern = typeof s === 'object' && 'pattern' in s ? s.pattern : undefined;
      return pattern && provider['matchesGlobPattern'](event.document.uri.fsPath, pattern as string);
    })) {
      provider.refresh();
    }
  });
  context.subscriptions.push(changeDisposable);

  logger.info('Workflow CodeLens provider registered');

  return provider;
}

/**
 * Create and register the Code Action provider
 */
export function createWorkflowCodeActionProvider(
  context: vscode.ExtensionContext
): WorkflowCodeActionProvider {
  const logger = getLogger();
  const provider = new WorkflowCodeActionProvider();

  // Register for workflow YAML files
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', pattern: WORKFLOW_FILE_PATTERNS.yaml },
    { scheme: 'file', pattern: WORKFLOW_FILE_PATTERNS.yml },
    { scheme: 'file', pattern: '**/*.generacy.yaml' },
    { scheme: 'file', pattern: '**/*.generacy.yml' },
  ];

  const disposable = vscode.languages.registerCodeActionsProvider(
    selector,
    provider,
    {
      providedCodeActionKinds: WorkflowCodeActionProvider.providedCodeActionKinds,
    }
  );
  context.subscriptions.push(disposable);

  logger.info('Workflow Code Action provider registered');

  return provider;
}
