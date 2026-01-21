/**
 * Completion provider for Generacy workflow YAML files.
 * Provides IntelliSense for workflow structure, properties, and expression syntax.
 */
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import { getLogger } from '../../../utils';
import { LANGUAGE_IDS } from '../../../constants';

/**
 * Completion item metadata for workflow schema elements
 */
interface CompletionItemData {
  label: string;
  kind: vscode.CompletionItemKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
}

/**
 * Top-level workflow properties
 */
const WORKFLOW_PROPERTIES: CompletionItemData[] = [
  {
    label: 'name',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string (required)',
    documentation: 'Unique name for the workflow. Must start with a letter and contain only letters, numbers, underscores, and hyphens.',
    insertText: 'name: ${1:my-workflow}',
    sortText: '0name',
  },
  {
    label: 'version',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string (required)',
    documentation: 'Semantic version of the workflow (e.g., 1.0.0)',
    insertText: 'version: ${1:1.0.0}',
    sortText: '0version',
  },
  {
    label: 'description',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Human-readable description of the workflow',
    insertText: 'description: ${1:Workflow description}',
    sortText: '1description',
  },
  {
    label: 'triggers',
    kind: vscode.CompletionItemKind.Property,
    detail: 'array',
    documentation: 'Events that can start this workflow',
    insertText: 'triggers:\n  - type: ${1|manual,schedule,webhook,issue,pull_request,push|}',
    sortText: '2triggers',
  },
  {
    label: 'env',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Environment variables available to all phases',
    insertText: 'env:\n  ${1:VAR_NAME}: ${2:value}',
    sortText: '3env',
  },
  {
    label: 'phases',
    kind: vscode.CompletionItemKind.Property,
    detail: 'array (required)',
    documentation: 'Ordered list of phases to execute',
    insertText: 'phases:\n  - name: ${1:phase-name}\n    steps:\n      - name: ${2:step-name}\n        run: ${3:echo "Hello"}',
    sortText: '0phases',
  },
  {
    label: 'on_error',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Global error handling configuration',
    insertText: 'on_error:\n  strategy: ${1|fail,continue,retry|}',
    sortText: '4on_error',
  },
  {
    label: 'timeout',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Maximum execution time for the entire workflow (e.g., 30m, 2h)',
    insertText: 'timeout: ${1:30m}',
    sortText: '5timeout',
  },
  {
    label: 'metadata',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Custom metadata for the workflow',
    insertText: 'metadata:\n  ${1:key}: ${2:value}',
    sortText: '6metadata',
  },
];

/**
 * Phase properties
 */
const PHASE_PROPERTIES: CompletionItemData[] = [
  {
    label: 'name',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string (required)',
    documentation: 'Unique name for the phase within this workflow',
    insertText: 'name: ${1:phase-name}',
    sortText: '0name',
  },
  {
    label: 'description',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Human-readable description of the phase',
    insertText: 'description: ${1:Phase description}',
    sortText: '1description',
  },
  {
    label: 'condition',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string | object',
    documentation: 'Condition that must be true to execute this phase',
    insertText: 'condition: ${{ ${1:always()} }}',
    sortText: '2condition',
  },
  {
    label: 'env',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Environment variables for this phase (merged with workflow env)',
    insertText: 'env:\n  ${1:VAR_NAME}: ${2:value}',
    sortText: '3env',
  },
  {
    label: 'steps',
    kind: vscode.CompletionItemKind.Property,
    detail: 'array (required)',
    documentation: 'Ordered list of steps to execute in this phase',
    insertText: 'steps:\n  - name: ${1:step-name}\n    run: ${2:echo "Hello"}',
    sortText: '0steps',
  },
  {
    label: 'on_error',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Error handling for this phase',
    insertText: 'on_error:\n  strategy: ${1|fail,continue,retry|}',
    sortText: '4on_error',
  },
  {
    label: 'timeout',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Maximum execution time for this phase',
    insertText: 'timeout: ${1:10m}',
    sortText: '5timeout',
  },
  {
    label: 'retry',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Retry configuration for the entire phase',
    insertText: 'retry:\n  max_attempts: ${1:3}\n  delay: ${2:10s}\n  backoff: ${3|exponential,linear,constant|}',
    sortText: '6retry',
  },
];

/**
 * Step properties
 */
const STEP_PROPERTIES: CompletionItemData[] = [
  {
    label: 'name',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string (required)',
    documentation: 'Unique name for the step within this phase',
    insertText: 'name: ${1:step-name}',
    sortText: '0name',
  },
  {
    label: 'description',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Human-readable description of the step',
    insertText: 'description: ${1:Step description}',
    sortText: '1description',
  },
  {
    label: 'uses',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Action or agent to use for this step (e.g., agent/claude-code, action/shell)',
    insertText: 'uses: ${1|agent/claude-code,action/shell,action/http|}',
    sortText: '0uses',
  },
  {
    label: 'with',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Input parameters for the action/agent',
    insertText: 'with:\n  ${1:param}: ${2:value}',
    sortText: '2with',
  },
  {
    label: 'run',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Shell command to run (alternative to uses)',
    insertText: 'run: ${1:echo "Hello"}',
    sortText: '0run',
  },
  {
    label: 'condition',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string | object',
    documentation: 'Condition that must be true to execute this step',
    insertText: 'condition: ${{ ${1:success()} }}',
    sortText: '3condition',
  },
  {
    label: 'env',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Environment variables for this step',
    insertText: 'env:\n  ${1:VAR_NAME}: ${2:value}',
    sortText: '4env',
  },
  {
    label: 'outputs',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Named outputs from this step',
    insertText: 'outputs:\n  ${1:output_name}: ${2:value}',
    sortText: '5outputs',
  },
  {
    label: 'timeout',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Maximum execution time for this step',
    insertText: 'timeout: ${1:5m}',
    sortText: '6timeout',
  },
  {
    label: 'retry',
    kind: vscode.CompletionItemKind.Property,
    detail: 'object',
    documentation: 'Retry configuration for this step',
    insertText: 'retry:\n  max_attempts: ${1:3}',
    sortText: '7retry',
  },
  {
    label: 'continue_on_error',
    kind: vscode.CompletionItemKind.Property,
    detail: 'boolean',
    documentation: 'Whether to continue execution if this step fails',
    insertText: 'continue_on_error: ${1|true,false|}',
    sortText: '8continue_on_error',
  },
];

/**
 * Trigger types
 */
const TRIGGER_TYPES: CompletionItemData[] = [
  {
    label: 'manual',
    kind: vscode.CompletionItemKind.EnumMember,
    detail: 'Manual trigger',
    documentation: 'Workflow can be started manually',
  },
  {
    label: 'schedule',
    kind: vscode.CompletionItemKind.EnumMember,
    detail: 'Schedule trigger',
    documentation: 'Workflow runs on a schedule (requires cron config)',
  },
  {
    label: 'webhook',
    kind: vscode.CompletionItemKind.EnumMember,
    detail: 'Webhook trigger',
    documentation: 'Workflow starts when a webhook is received',
  },
  {
    label: 'issue',
    kind: vscode.CompletionItemKind.EnumMember,
    detail: 'Issue trigger',
    documentation: 'Workflow starts on issue events',
  },
  {
    label: 'pull_request',
    kind: vscode.CompletionItemKind.EnumMember,
    detail: 'Pull request trigger',
    documentation: 'Workflow starts on pull request events',
  },
  {
    label: 'push',
    kind: vscode.CompletionItemKind.EnumMember,
    detail: 'Push trigger',
    documentation: 'Workflow starts on push events',
  },
];

/**
 * Expression functions available in ${{ }} syntax
 */
const EXPRESSION_FUNCTIONS: CompletionItemData[] = [
  {
    label: 'always()',
    kind: vscode.CompletionItemKind.Function,
    detail: 'boolean',
    documentation: 'Always returns true, causing the step/phase to always execute',
    insertText: 'always()',
  },
  {
    label: 'success()',
    kind: vscode.CompletionItemKind.Function,
    detail: 'boolean',
    documentation: 'Returns true if all previous steps/phases succeeded',
    insertText: 'success()',
  },
  {
    label: 'failure()',
    kind: vscode.CompletionItemKind.Function,
    detail: 'boolean',
    documentation: 'Returns true if any previous step/phase failed',
    insertText: 'failure()',
  },
  {
    label: 'cancelled()',
    kind: vscode.CompletionItemKind.Function,
    detail: 'boolean',
    documentation: 'Returns true if the workflow was cancelled',
    insertText: 'cancelled()',
  },
];

/**
 * Expression context variables
 */
const EXPRESSION_CONTEXTS: CompletionItemData[] = [
  {
    label: 'env',
    kind: vscode.CompletionItemKind.Variable,
    detail: 'object',
    documentation: 'Access environment variables (e.g., env.MY_VAR)',
    insertText: 'env.${1:VAR_NAME}',
  },
  {
    label: 'secrets',
    kind: vscode.CompletionItemKind.Variable,
    detail: 'object',
    documentation: 'Access secrets (e.g., secrets.API_KEY)',
    insertText: 'secrets.${1:SECRET_NAME}',
  },
  {
    label: 'steps',
    kind: vscode.CompletionItemKind.Variable,
    detail: 'object',
    documentation: 'Access outputs from previous steps (e.g., steps.step-name.outputs.value)',
    insertText: 'steps.${1:step-name}.outputs.${2:output-name}',
  },
  {
    label: 'phases',
    kind: vscode.CompletionItemKind.Variable,
    detail: 'object',
    documentation: 'Access outputs from previous phases',
    insertText: 'phases.${1:phase-name}.outputs.${2:output-name}',
  },
  {
    label: 'workflow',
    kind: vscode.CompletionItemKind.Variable,
    detail: 'object',
    documentation: 'Access workflow metadata and context',
    insertText: 'workflow.${1|name,version,run_id|}',
  },
  {
    label: 'trigger',
    kind: vscode.CompletionItemKind.Variable,
    detail: 'object',
    documentation: 'Access information about what triggered the workflow',
    insertText: 'trigger.${1|type,event,payload|}',
  },
];

/**
 * Secret reference completions
 */
const SECRET_COMPLETIONS: CompletionItemData[] = [
  {
    label: 'secret',
    kind: vscode.CompletionItemKind.Property,
    detail: 'Secret reference',
    documentation: 'Reference to a secret value stored in the secrets manager',
    insertText: 'secret: ${1:SECRET_NAME}',
  },
];

/**
 * Environment reference completions
 */
const ENV_REF_COMPLETIONS: CompletionItemData[] = [
  {
    label: 'env',
    kind: vscode.CompletionItemKind.Property,
    detail: 'Environment variable reference',
    documentation: 'Reference to an environment variable',
    insertText: 'env: ${1:VAR_NAME}',
  },
  {
    label: 'default',
    kind: vscode.CompletionItemKind.Property,
    detail: 'Default value',
    documentation: 'Default value if the environment variable is not set',
    insertText: 'default: ${1:default-value}',
  },
];

/**
 * Error handler properties
 */
const ERROR_HANDLER_PROPERTIES: CompletionItemData[] = [
  {
    label: 'strategy',
    kind: vscode.CompletionItemKind.Property,
    detail: 'enum',
    documentation: 'How to handle errors: fail (stop), continue (ignore), or retry',
    insertText: 'strategy: ${1|fail,continue,retry|}',
  },
  {
    label: 'notify',
    kind: vscode.CompletionItemKind.Property,
    detail: 'array',
    documentation: 'Notification channels to alert on error',
    insertText: 'notify:\n  - type: ${1|slack,email,webhook|}',
  },
  {
    label: 'cleanup',
    kind: vscode.CompletionItemKind.Property,
    detail: 'array',
    documentation: 'Steps to run for cleanup on error',
    insertText: 'cleanup:\n  - name: ${1:cleanup-step}\n    run: ${2:echo "Cleaning up"}',
  },
];

/**
 * Retry configuration properties
 */
const RETRY_PROPERTIES: CompletionItemData[] = [
  {
    label: 'max_attempts',
    kind: vscode.CompletionItemKind.Property,
    detail: 'integer',
    documentation: 'Maximum number of retry attempts (1-10)',
    insertText: 'max_attempts: ${1:3}',
  },
  {
    label: 'delay',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Delay between retry attempts (e.g., 10s, 1m)',
    insertText: 'delay: ${1:10s}',
  },
  {
    label: 'backoff',
    kind: vscode.CompletionItemKind.Property,
    detail: 'enum',
    documentation: 'Backoff strategy for retry delays',
    insertText: 'backoff: ${1|exponential,linear,constant|}',
  },
  {
    label: 'max_delay',
    kind: vscode.CompletionItemKind.Property,
    detail: 'string',
    documentation: 'Maximum delay between retries',
    insertText: 'max_delay: ${1:5m}',
  },
];

/**
 * Trigger filter properties
 */
const TRIGGER_FILTER_PROPERTIES: CompletionItemData[] = [
  {
    label: 'branches',
    kind: vscode.CompletionItemKind.Property,
    detail: 'array',
    documentation: 'Branch patterns to match',
    insertText: 'branches:\n  - ${1:main}',
  },
  {
    label: 'paths',
    kind: vscode.CompletionItemKind.Property,
    detail: 'array',
    documentation: 'File path patterns to match',
    insertText: 'paths:\n  - ${1:src/**}',
  },
  {
    label: 'labels',
    kind: vscode.CompletionItemKind.Property,
    detail: 'array',
    documentation: 'Issue/PR labels to match',
    insertText: 'labels:\n  - ${1:bug}',
  },
];

/**
 * Context information for determining completion location
 */
interface CompletionContext {
  isInWorkflow: boolean;
  isInPhase: boolean;
  isInStep: boolean;
  isInTrigger: boolean;
  isInErrorHandler: boolean;
  isInRetry: boolean;
  isInEnv: boolean;
  isInFilters: boolean;
  isInExpression: boolean;
  currentProperty?: string;
  path: string[];
}

/**
 * Completion provider for Generacy workflow YAML files
 */
export class WorkflowCompletionProvider implements vscode.CompletionItemProvider {
  private readonly logger = getLogger().child('completion');

  /**
   * Provide completion items for the given position in the document
   */
  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    completionContext: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionList | vscode.CompletionItem[]> {
    try {
      // Get the context for completion
      const context = this.getCompletionContext(document, position);
      this.logger.debug('Completion context', { context });

      // Check if we're in an expression
      if (context.isInExpression) {
        return this.getExpressionCompletions(document, position);
      }

      // Get completions based on context
      const items = this.getCompletionsForContext(context, document, position, completionContext);

      return new vscode.CompletionList(items, false);
    } catch (error) {
      this.logger.error('Error providing completions', error as Error);
      return [];
    }
  }

  /**
   * Resolve additional details for a completion item
   */
  public resolveCompletionItem(
    item: vscode.CompletionItem,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem> {
    // Most details are already provided in provideCompletionItems
    return item;
  }

  /**
   * Analyzes the document to determine the completion context
   */
  private getCompletionContext(document: vscode.TextDocument, position: vscode.Position): CompletionContext {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const lineText = document.lineAt(position.line).text;
    const linePrefix = lineText.substring(0, position.character);

    // Check if we're in an expression ${{ }}
    const isInExpression = this.isInsideExpression(text, offset);

    // Parse the YAML to understand structure
    const path = this.getYamlPath(text, offset);

    // Determine context from path
    const context: CompletionContext = {
      isInWorkflow: path.length === 0 || (path.length === 1 && path[0] === ''),
      isInPhase: path.some((p) => p === 'phases') && path.length >= 2,
      isInStep: path.some((p) => p === 'steps') && path.length >= 4,
      isInTrigger: path.some((p) => p === 'triggers'),
      isInErrorHandler: path.some((p) => p === 'on_error'),
      isInRetry: path.some((p) => p === 'retry'),
      isInEnv: path.some((p) => p === 'env'),
      isInFilters: path.some((p) => p === 'filters'),
      isInExpression,
      currentProperty: this.getCurrentProperty(linePrefix),
      path,
    };

    return context;
  }

  /**
   * Checks if the cursor is inside an expression ${{ }}
   */
  private isInsideExpression(text: string, offset: number): boolean {
    // Find the last ${{ before the cursor
    const beforeCursor = text.substring(0, offset);
    const lastOpenIdx = beforeCursor.lastIndexOf('${{');
    if (lastOpenIdx === -1) return false;

    // Check if there's a closing }} between the opening and cursor
    const betweenOpenAndCursor = beforeCursor.substring(lastOpenIdx);
    const closeInBetween = betweenOpenAndCursor.indexOf('}}');

    // If no close found, or close is after the opening offset relative to cursor
    return closeInBetween === -1;
  }

  /**
   * Gets the YAML path to the current position
   */
  private getYamlPath(text: string, offset: number): string[] {
    try {
      const doc = yaml.parseDocument(text, { keepSourceTokens: true });
      const path: string[] = [];

      // Navigate the CST to find the path
      this.findPathInNode(doc.contents, offset, path);

      return path;
    } catch {
      return [];
    }
  }

  /**
   * Recursively finds the path to the offset in a YAML node
   */
  private findPathInNode(node: unknown, offset: number, path: string[]): boolean {
    if (!node || typeof node !== 'object') return false;

    const yamlNode = node as { range?: [number, number, number]; items?: unknown[] };

    if (yamlNode.range) {
      const [start, , end] = yamlNode.range;
      if (offset < start || offset > end) return false;
    }

    if (yaml.isMap(node)) {
      for (const item of node.items) {
        const key = item.key;
        const value = item.value;

        if (yaml.isScalar(key)) {
          const keyStr = String(key.value);
          path.push(keyStr);

          if (this.findPathInNode(value, offset, path)) {
            return true;
          }

          // Check if offset is in the key itself
          if (key.range) {
            const [start, , end] = key.range;
            if (offset >= start && offset <= end) {
              return true;
            }
          }

          path.pop();
        }
      }
    } else if (yaml.isSeq(node)) {
      for (let i = 0; i < node.items.length; i++) {
        const item = node.items[i];
        path.push(String(i));

        if (this.findPathInNode(item, offset, path)) {
          return true;
        }

        path.pop();
      }
    }

    return false;
  }

  /**
   * Gets the current property being typed
   */
  private getCurrentProperty(linePrefix: string): string | undefined {
    const match = linePrefix.match(/^\s*(\w+):\s*$/);
    if (match) {
      return match[1];
    }
    return undefined;
  }

  /**
   * Gets completions for expression syntax ${{ }}
   */
  private getExpressionCompletions(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const lineText = document.lineAt(position.line).text;
    const beforeCursor = lineText.substring(0, position.character);

    // Check what's already typed in the expression
    const exprMatch = beforeCursor.match(/\$\{\{\s*(\w*)$/);
    const prefix = exprMatch ? exprMatch[1] : '';

    const items: vscode.CompletionItem[] = [];

    // Add expression functions
    for (const func of EXPRESSION_FUNCTIONS) {
      if (func.label.toLowerCase().startsWith(prefix.toLowerCase())) {
        items.push(this.createCompletionItem(func));
      }
    }

    // Add expression contexts
    for (const ctx of EXPRESSION_CONTEXTS) {
      if (ctx.label.toLowerCase().startsWith(prefix.toLowerCase())) {
        items.push(this.createCompletionItem(ctx));
      }
    }

    return items;
  }

  /**
   * Gets completions based on the current context
   */
  private getCompletionsForContext(
    context: CompletionContext,
    document: vscode.TextDocument,
    position: vscode.Position,
    completionContext: vscode.CompletionContext
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const lineText = document.lineAt(position.line).text;
    const linePrefix = lineText.substring(0, position.character);

    // Check if we're completing a value after a colon
    const isAfterColon = linePrefix.includes(':');
    const propertyMatch = linePrefix.match(/^\s*(\w+):\s*$/);
    const currentProp = propertyMatch ? propertyMatch[1] : null;

    // Handle value completions
    if (currentProp) {
      return this.getValueCompletionsForProperty(currentProp, context);
    }

    // Check if completing at property level (new line or after indent)
    const isPropertyLevel = !isAfterColon || linePrefix.trim() === '' || linePrefix.endsWith('-');

    if (!isPropertyLevel) {
      return items;
    }

    // Determine which properties to suggest
    if (context.isInStep) {
      items.push(...STEP_PROPERTIES.map((p) => this.createCompletionItem(p)));
    } else if (context.isInPhase && !context.isInStep) {
      items.push(...PHASE_PROPERTIES.map((p) => this.createCompletionItem(p)));
    } else if (context.isInTrigger) {
      // Trigger properties
      const triggerProps: CompletionItemData[] = [
        {
          label: 'type',
          kind: vscode.CompletionItemKind.Property,
          detail: 'enum (required)',
          documentation: 'Type of trigger',
          insertText: 'type: ${1|manual,schedule,webhook,issue,pull_request,push|}',
        },
        {
          label: 'config',
          kind: vscode.CompletionItemKind.Property,
          detail: 'object',
          documentation: 'Trigger-specific configuration',
          insertText: 'config:\n  ${1:key}: ${2:value}',
        },
        {
          label: 'filters',
          kind: vscode.CompletionItemKind.Property,
          detail: 'object',
          documentation: 'Conditions for the trigger to fire',
          insertText: 'filters:\n  branches:\n    - ${1:main}',
        },
      ];
      items.push(...triggerProps.map((p) => this.createCompletionItem(p)));
    } else if (context.isInFilters) {
      items.push(...TRIGGER_FILTER_PROPERTIES.map((p) => this.createCompletionItem(p)));
    } else if (context.isInErrorHandler) {
      items.push(...ERROR_HANDLER_PROPERTIES.map((p) => this.createCompletionItem(p)));
    } else if (context.isInRetry) {
      items.push(...RETRY_PROPERTIES.map((p) => this.createCompletionItem(p)));
    } else if (context.isInWorkflow) {
      items.push(...WORKFLOW_PROPERTIES.map((p) => this.createCompletionItem(p)));
    }

    // Add ${{ }} expression trigger if appropriate
    if (completionContext.triggerCharacter === '$' || linePrefix.endsWith('$')) {
      items.push({
        label: '${{ }}',
        kind: vscode.CompletionItemKind.Snippet,
        detail: 'Expression',
        documentation: new vscode.MarkdownString('Insert an expression that will be evaluated at runtime'),
        insertText: new vscode.SnippetString('\\${{ ${1} }}'),
        sortText: '0expression',
      });
    }

    return items;
  }

  /**
   * Gets value completions for a specific property
   */
  private getValueCompletionsForProperty(property: string, context: CompletionContext): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    switch (property) {
      case 'type':
        if (context.isInTrigger) {
          items.push(...TRIGGER_TYPES.map((t) => this.createCompletionItem(t)));
        }
        break;

      case 'strategy':
        items.push(
          this.createCompletionItem({
            label: 'fail',
            kind: vscode.CompletionItemKind.EnumMember,
            detail: 'Stop execution on error',
            documentation: 'The default strategy - stops execution when an error occurs',
          }),
          this.createCompletionItem({
            label: 'continue',
            kind: vscode.CompletionItemKind.EnumMember,
            detail: 'Continue execution on error',
            documentation: 'Ignores errors and continues with the next step/phase',
          }),
          this.createCompletionItem({
            label: 'retry',
            kind: vscode.CompletionItemKind.EnumMember,
            detail: 'Retry on error',
            documentation: 'Retries the failed step/phase according to retry configuration',
          })
        );
        break;

      case 'backoff':
        items.push(
          this.createCompletionItem({
            label: 'exponential',
            kind: vscode.CompletionItemKind.EnumMember,
            detail: 'Exponential backoff',
            documentation: 'Delay doubles between each retry',
          }),
          this.createCompletionItem({
            label: 'linear',
            kind: vscode.CompletionItemKind.EnumMember,
            detail: 'Linear backoff',
            documentation: 'Delay increases by a fixed amount between retries',
          }),
          this.createCompletionItem({
            label: 'constant',
            kind: vscode.CompletionItemKind.EnumMember,
            detail: 'Constant delay',
            documentation: 'Same delay between all retries',
          })
        );
        break;

      case 'continue_on_error':
        items.push(
          this.createCompletionItem({
            label: 'true',
            kind: vscode.CompletionItemKind.Value,
            detail: 'Continue on error',
            documentation: 'Execution continues even if this step fails',
          }),
          this.createCompletionItem({
            label: 'false',
            kind: vscode.CompletionItemKind.Value,
            detail: 'Stop on error',
            documentation: 'Execution stops if this step fails',
          })
        );
        break;

      case 'uses':
        // Common actions/agents
        const usesOptions: CompletionItemData[] = [
          {
            label: 'agent/claude-code',
            kind: vscode.CompletionItemKind.Module,
            detail: 'Claude Code Agent',
            documentation: 'AI-powered coding assistant that can write, edit, and debug code',
          },
          {
            label: 'action/shell',
            kind: vscode.CompletionItemKind.Module,
            detail: 'Shell Action',
            documentation: 'Execute shell commands',
          },
          {
            label: 'action/http',
            kind: vscode.CompletionItemKind.Module,
            detail: 'HTTP Action',
            documentation: 'Make HTTP requests',
          },
        ];
        items.push(...usesOptions.map((o) => this.createCompletionItem(o)));
        break;
    }

    return items;
  }

  /**
   * Creates a VS Code CompletionItem from completion data
   */
  private createCompletionItem(data: CompletionItemData): vscode.CompletionItem {
    const item = new vscode.CompletionItem(data.label, data.kind);

    if (data.detail) {
      item.detail = data.detail;
    }

    if (data.documentation) {
      item.documentation = new vscode.MarkdownString(data.documentation);
    }

    if (data.insertText) {
      item.insertText = new vscode.SnippetString(data.insertText);
    }

    if (data.sortText) {
      item.sortText = data.sortText;
    }

    return item;
  }
}

/**
 * Registers the completion provider for workflow files
 */
export function registerCompletionProvider(context: vscode.ExtensionContext): vscode.Disposable[] {
  const logger = getLogger();
  const disposables: vscode.Disposable[] = [];

  const provider = new WorkflowCompletionProvider();

  // Register for generacy-workflow language
  disposables.push(
    vscode.languages.registerCompletionItemProvider(
      { language: LANGUAGE_IDS.workflow },
      provider,
      '.', // Trigger on dot for property access
      '$', // Trigger on $ for expressions
      ' ', // Trigger on space
      ':' // Trigger after colon for values
    )
  );

  // Also register for generic YAML files in .generacy directory
  disposables.push(
    vscode.languages.registerCompletionItemProvider(
      { language: LANGUAGE_IDS.yaml, pattern: '**/.generacy/**/*.{yaml,yml}' },
      provider,
      '.',
      '$',
      ' ',
      ':'
    )
  );

  logger.info('Registered workflow completion provider');

  return disposables;
}
