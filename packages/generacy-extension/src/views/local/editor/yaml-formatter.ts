/**
 * YAML formatter for Generacy workflow files.
 * Formats YAML while respecting workflow structure and conventions.
 */
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import { getLogger } from '../../../utils';
import { LANGUAGE_IDS } from '../../../constants';

/**
 * Formatting options for workflow YAML
 */
export interface FormatterOptions {
  /** Number of spaces for indentation (default: 2) */
  indent: number;
  /** Line width before wrapping (default: 120) */
  lineWidth: number;
  /** Use single quotes instead of double quotes (default: false) */
  singleQuote: boolean;
  /** Preserve comments (default: true) */
  preserveComments: boolean;
  /** Sort keys in objects (default: false) */
  sortKeys: boolean;
  /** Preferred order for top-level workflow keys */
  workflowKeyOrder: string[];
  /** Preferred order for phase keys */
  phaseKeyOrder: string[];
  /** Preferred order for step keys */
  stepKeyOrder: string[];
}

/**
 * Default formatting options
 */
const DEFAULT_OPTIONS: FormatterOptions = {
  indent: 2,
  lineWidth: 120,
  singleQuote: false,
  preserveComments: true,
  sortKeys: false,
  workflowKeyOrder: [
    'name',
    'version',
    'description',
    'triggers',
    'env',
    'phases',
    'on_error',
    'timeout',
    'metadata',
  ],
  phaseKeyOrder: [
    'name',
    'description',
    'condition',
    'env',
    'steps',
    'on_error',
    'timeout',
    'retry',
  ],
  stepKeyOrder: [
    'name',
    'description',
    'uses',
    'with',
    'run',
    'condition',
    'env',
    'outputs',
    'timeout',
    'retry',
    'continue_on_error',
  ],
};

/**
 * Formats a workflow YAML document
 */
export function formatWorkflowYaml(content: string, options?: Partial<FormatterOptions>): string {
  const logger = getLogger().child('yaml-formatter');
  const opts = { ...DEFAULT_OPTIONS, ...options };

  try {
    // Handle empty or whitespace-only content
    if (!content || !content.trim()) {
      return content;
    }

    // Parse the document with comments preserved
    const doc = yaml.parseDocument(content, {
      keepSourceTokens: true,
    });

    // Check for parse errors
    if (doc.errors.length > 0) {
      logger.debug('YAML has parse errors, returning original content');
      return content;
    }

    // Apply formatting options to the document
    configureDocument(doc, opts);

    // Sort keys if configured
    if (opts.sortKeys) {
      sortWorkflowKeys(doc, opts);
    }

    // Convert back to string
    const formatted = doc.toString({
      indent: opts.indent,
      lineWidth: opts.lineWidth,
      singleQuote: opts.singleQuote,
    });

    return formatted;
  } catch (error) {
    logger.error('Error formatting YAML', error as Error);
    // Return original content on error
    return content;
  }
}

/**
 * Configures document-level formatting options
 */
function configureDocument(doc: yaml.Document, options: FormatterOptions): void {
  // Set default scalar style for strings
  if (doc.contents && yaml.isMap(doc.contents)) {
    configureMapFormatting(doc.contents, options);
  }
}

/**
 * Recursively configures formatting for a map node
 */
function configureMapFormatting(map: yaml.YAMLMap, options: FormatterOptions): void {
  for (const item of map.items) {
    const value = item.value;

    if (yaml.isMap(value)) {
      configureMapFormatting(value, options);
    } else if (yaml.isSeq(value)) {
      configureSeqFormatting(value, options);
    } else if (yaml.isScalar(value)) {
      configureScalarFormatting(value, options);
    }
  }
}

/**
 * Configures formatting for a sequence node
 */
function configureSeqFormatting(seq: yaml.YAMLSeq, options: FormatterOptions): void {
  for (const item of seq.items) {
    if (yaml.isMap(item)) {
      configureMapFormatting(item, options);
    } else if (yaml.isSeq(item)) {
      configureSeqFormatting(item, options);
    } else if (yaml.isScalar(item)) {
      configureScalarFormatting(item, options);
    }
  }
}

/**
 * Configures formatting for a scalar node
 */
function configureScalarFormatting(scalar: yaml.Scalar, options: FormatterOptions): void {
  const value = scalar.value;

  // For multiline strings, use literal block style
  if (typeof value === 'string' && value.includes('\n')) {
    scalar.type = yaml.Scalar.BLOCK_LITERAL;
  }
  // For strings with special characters, ensure they're quoted
  else if (typeof value === 'string') {
    if (needsQuoting(value)) {
      scalar.type = options.singleQuote ? yaml.Scalar.QUOTE_SINGLE : yaml.Scalar.QUOTE_DOUBLE;
    }
  }
}

/**
 * Checks if a string value needs to be quoted
 */
function needsQuoting(value: string): boolean {
  // Values that might be interpreted as other types
  const reservedPatterns = [
    /^(true|false|yes|no|on|off)$/i,
    /^[0-9]/,
    /^null$/i,
    /^~/,
    /[:{}[\]&*#?|\-<>=!%@`]/,
    /^\s|\s$/,
  ];

  return reservedPatterns.some((pattern) => pattern.test(value));
}

/**
 * Sorts keys in the workflow document according to preferred order
 */
function sortWorkflowKeys(doc: yaml.Document, options: FormatterOptions): void {
  if (!doc.contents || !yaml.isMap(doc.contents)) {
    return;
  }

  // Sort top-level keys
  sortMapKeys(doc.contents, options.workflowKeyOrder);

  // Sort phases and steps
  const phases = doc.contents.get('phases');
  if (phases && yaml.isSeq(phases)) {
    for (const phase of phases.items) {
      if (yaml.isMap(phase)) {
        sortMapKeys(phase, options.phaseKeyOrder);

        const steps = phase.get('steps');
        if (steps && yaml.isSeq(steps)) {
          for (const step of steps.items) {
            if (yaml.isMap(step)) {
              sortMapKeys(step, options.stepKeyOrder);
            }
          }
        }
      }
    }
  }

  // Sort triggers
  const triggers = doc.contents.get('triggers');
  if (triggers && yaml.isSeq(triggers)) {
    const triggerKeyOrder = ['type', 'config', 'filters'];
    for (const trigger of triggers.items) {
      if (yaml.isMap(trigger)) {
        sortMapKeys(trigger, triggerKeyOrder);
      }
    }
  }
}

/**
 * Sorts keys in a map according to the preferred order
 */
function sortMapKeys(map: yaml.YAMLMap, preferredOrder: string[]): void {
  const items = [...map.items];

  items.sort((a, b) => {
    const keyA = yaml.isScalar(a.key) ? String(a.key.value) : '';
    const keyB = yaml.isScalar(b.key) ? String(b.key.value) : '';

    const indexA = preferredOrder.indexOf(keyA);
    const indexB = preferredOrder.indexOf(keyB);

    // Keys in preferredOrder come first
    if (indexA >= 0 && indexB >= 0) {
      return indexA - indexB;
    }
    if (indexA >= 0) return -1;
    if (indexB >= 0) return 1;

    // Other keys maintain their relative order
    return 0;
  });

  // Update the map with sorted items
  map.items = items;
}

/**
 * VS Code document formatting provider
 */
export class WorkflowFormattingProvider
  implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider
{
  private readonly logger = getLogger().child('yaml-formatter');

  /**
   * Formats the entire document
   */
  public provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.TextEdit[]> {
    try {
      const content = document.getText();
      const formatterOptions = this.getFormatterOptions(options);

      const formatted = formatWorkflowYaml(content, formatterOptions);

      // If content unchanged, return empty array
      if (formatted === content) {
        return [];
      }

      // Replace entire document
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(content.length)
      );

      return [vscode.TextEdit.replace(fullRange, formatted)];
    } catch (error) {
      this.logger.error('Error formatting document', error as Error);
      return [];
    }
  }

  /**
   * Formats a range in the document
   */
  public provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.TextEdit[]> {
    // For range formatting, we need to be careful about YAML structure
    // For now, just format the entire document
    // A more sophisticated implementation would handle partial formatting
    return this.provideDocumentFormattingEdits(document, options, _token);
  }

  /**
   * Converts VS Code formatting options to our formatter options
   */
  private getFormatterOptions(options: vscode.FormattingOptions): Partial<FormatterOptions> {
    return {
      indent: options.tabSize,
      // Read additional options from workspace configuration
      ...this.getWorkspaceFormatterOptions(),
    };
  }

  /**
   * Gets formatter options from workspace configuration
   */
  private getWorkspaceFormatterOptions(): Partial<FormatterOptions> {
    const yamlConfig = vscode.workspace.getConfiguration('yaml');

    return {
      lineWidth: yamlConfig.get<number>('format.printWidth', 120),
      singleQuote: yamlConfig.get<boolean>('format.singleQuote', false),
    };
  }
}

/**
 * Registers the formatting provider for workflow files
 */
export function registerFormattingProvider(context: vscode.ExtensionContext): vscode.Disposable[] {
  const logger = getLogger();
  const disposables: vscode.Disposable[] = [];

  const provider = new WorkflowFormattingProvider();

  // Register document formatting provider for generacy-workflow
  disposables.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      { language: LANGUAGE_IDS.workflow },
      provider
    )
  );

  // Register range formatting provider for generacy-workflow
  disposables.push(
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      { language: LANGUAGE_IDS.workflow },
      provider
    )
  );

  // Also register for generic YAML files in .generacy directory
  disposables.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      { language: LANGUAGE_IDS.yaml, pattern: '**/.generacy/**/*.{yaml,yml}' },
      provider
    )
  );

  disposables.push(
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      { language: LANGUAGE_IDS.yaml, pattern: '**/.generacy/**/*.{yaml,yml}' },
      provider
    )
  );

  // Register format command
  const formatCommand = vscode.commands.registerCommand('generacy.formatWorkflow', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await vscode.commands.executeCommand('editor.action.formatDocument');
    }
  });
  disposables.push(formatCommand);

  logger.info('Registered workflow YAML formatting provider');

  return disposables;
}

/**
 * Utility function to format workflow YAML string
 */
export function formatYaml(content: string): string {
  return formatWorkflowYaml(content);
}
