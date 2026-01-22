/**
 * Hover provider for Generacy workflow YAML files.
 * Provides documentation on hover for workflow elements.
 */
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import { getLogger } from '../../../utils';
import { LANGUAGE_IDS } from '../../../constants';

/**
 * Documentation for workflow schema elements
 */
interface HoverDocumentation {
  title: string;
  description: string;
  type?: string;
  required?: boolean;
  examples?: string[];
  values?: string[];
  link?: string;
}

/**
 * Documentation registry for workflow elements
 */
const DOCUMENTATION: Record<string, HoverDocumentation> = {
  // Workflow-level properties
  name: {
    title: 'Workflow Name',
    description: 'Unique identifier for the workflow. Must start with a letter and contain only letters, numbers, underscores, and hyphens.',
    type: 'string',
    required: true,
    examples: ['my-workflow', 'deploy-production', 'ci_pipeline'],
  },
  version: {
    title: 'Workflow Version',
    description: 'Semantic version of the workflow following the MAJOR.MINOR.PATCH format.',
    type: 'string',
    required: true,
    examples: ['1.0.0', '2.1.3', '0.1.0'],
  },
  description: {
    title: 'Description',
    description: 'Human-readable description of what this workflow does.',
    type: 'string',
    required: false,
  },
  triggers: {
    title: 'Triggers',
    description: 'Events that can start this workflow. Multiple triggers can be defined.',
    type: 'array',
    required: false,
    examples: ['manual', 'schedule', 'webhook', 'issue', 'pull_request', 'push'],
  },
  phases: {
    title: 'Phases',
    description: 'Ordered list of execution phases. Each phase contains one or more steps that run sequentially.',
    type: 'array',
    required: true,
  },
  env: {
    title: 'Environment Variables',
    description: 'Environment variables available to all phases and steps. Can reference secrets with `${{ secrets.NAME }}`.',
    type: 'object',
    required: false,
  },
  on_error: {
    title: 'Error Handler',
    description: 'Configuration for handling errors at the workflow, phase, or step level.',
    type: 'object',
    required: false,
  },
  timeout: {
    title: 'Timeout',
    description: 'Maximum execution time. Use format: number + unit (s=seconds, m=minutes, h=hours).',
    type: 'string',
    required: false,
    examples: ['30m', '2h', '3600s'],
  },
  metadata: {
    title: 'Metadata',
    description: 'Custom metadata for the workflow. Can contain any key-value pairs.',
    type: 'object',
    required: false,
  },

  // Trigger properties
  type: {
    title: 'Trigger Type',
    description: 'The type of event that triggers the workflow.',
    type: 'enum',
    required: true,
    values: ['manual', 'schedule', 'webhook', 'issue', 'pull_request', 'push'],
  },
  config: {
    title: 'Trigger Configuration',
    description: 'Trigger-specific configuration. For schedule triggers, requires a `cron` expression.',
    type: 'object',
    required: false,
  },
  filters: {
    title: 'Trigger Filters',
    description: 'Conditions that must be met for the trigger to fire.',
    type: 'object',
    required: false,
  },
  cron: {
    title: 'Cron Expression',
    description: 'Cron schedule for when the workflow should run automatically.',
    type: 'string',
    required: true,
    examples: ['0 0 * * *', '0 9 * * 1-5', '@daily', '@hourly'],
  },
  timezone: {
    title: 'Timezone',
    description: 'Timezone for the schedule. Defaults to UTC.',
    type: 'string',
    required: false,
    examples: ['UTC', 'America/New_York', 'Europe/London'],
  },
  branches: {
    title: 'Branch Filters',
    description: 'Branch patterns to match. Supports glob patterns.',
    type: 'array',
    required: false,
    examples: ['main', 'develop', 'feature/*', 'release/**'],
  },
  paths: {
    title: 'Path Filters',
    description: 'File path patterns to match. Workflow only triggers if changes match these paths.',
    type: 'array',
    required: false,
    examples: ['src/**', '*.ts', 'package.json'],
  },
  labels: {
    title: 'Label Filters',
    description: 'Issue/PR labels to match. Workflow only triggers for issues/PRs with these labels.',
    type: 'array',
    required: false,
    examples: ['bug', 'enhancement', 'needs-review'],
  },

  // Phase properties
  steps: {
    title: 'Steps',
    description: 'Ordered list of steps to execute in this phase. Steps run sequentially.',
    type: 'array',
    required: true,
  },
  condition: {
    title: 'Condition',
    description: 'Expression that must evaluate to true for this phase/step to execute. Use `${{ }}` syntax.',
    type: 'string | object',
    required: false,
    examples: ['${{ always() }}', '${{ success() }}', '${{ failure() }}', '${{ env.DEPLOY == "true" }}'],
  },
  retry: {
    title: 'Retry Configuration',
    description: 'Configuration for automatic retries on failure.',
    type: 'object',
    required: false,
  },

  // Step properties
  uses: {
    title: 'Action/Agent',
    description: 'The action or agent to use for this step. Use `agent/` prefix for AI agents, `action/` for built-in actions.',
    type: 'string',
    required: false,
    examples: ['agent/claude-code', 'action/shell', 'action/http'],
  },
  with: {
    title: 'Input Parameters',
    description: 'Input parameters for the action/agent specified in `uses`.',
    type: 'object',
    required: false,
  },
  run: {
    title: 'Shell Command',
    description: 'Shell command to execute. Alternative to using `uses`.',
    type: 'string',
    required: false,
    examples: ['npm test', 'echo "Hello World"', 'docker build -t app .'],
  },
  outputs: {
    title: 'Outputs',
    description: 'Named outputs from this step that can be referenced by later steps using `${{ steps.step-name.outputs.output-name }}`.',
    type: 'object',
    required: false,
  },
  continue_on_error: {
    title: 'Continue on Error',
    description: 'If true, workflow execution continues even if this step fails.',
    type: 'boolean',
    required: false,
  },

  // Error handler properties
  strategy: {
    title: 'Error Strategy',
    description: 'How to handle errors when they occur.',
    type: 'enum',
    required: false,
    values: ['fail', 'continue', 'retry'],
  },
  notify: {
    title: 'Error Notifications',
    description: 'Notification channels to alert when an error occurs.',
    type: 'array',
    required: false,
  },
  cleanup: {
    title: 'Cleanup Steps',
    description: 'Steps to run for cleanup when an error occurs.',
    type: 'array',
    required: false,
  },

  // Retry properties
  max_attempts: {
    title: 'Maximum Attempts',
    description: 'Maximum number of retry attempts (1-10).',
    type: 'integer',
    required: false,
    examples: ['3', '5'],
  },
  delay: {
    title: 'Retry Delay',
    description: 'Delay between retry attempts. Use format: number + unit (s, m, h).',
    type: 'string',
    required: false,
    examples: ['10s', '1m', '30s'],
  },
  backoff: {
    title: 'Backoff Strategy',
    description: 'How the delay changes between retries.',
    type: 'enum',
    required: false,
    values: ['exponential', 'linear', 'constant'],
  },
  max_delay: {
    title: 'Maximum Delay',
    description: 'Maximum delay between retries when using exponential or linear backoff.',
    type: 'string',
    required: false,
    examples: ['5m', '10m'],
  },

  // Reference types
  secret: {
    title: 'Secret Reference',
    description: 'Reference to a secret stored in the secrets manager. Secret names must be uppercase with underscores.',
    type: 'string',
    required: true,
    examples: ['API_KEY', 'DATABASE_PASSWORD', 'GITHUB_TOKEN'],
  },
  default: {
    title: 'Default Value',
    description: 'Default value to use if the environment variable is not set.',
    type: 'string',
    required: false,
  },
};

/**
 * Documentation for expression functions
 */
const EXPRESSION_FUNCTIONS: Record<string, HoverDocumentation> = {
  'always()': {
    title: 'always()',
    description: 'Always returns true. The step/phase will always execute, even if previous steps failed or the workflow was cancelled.',
    type: 'function',
    examples: ['condition: ${{ always() }}'],
  },
  'success()': {
    title: 'success()',
    description: 'Returns true if all previous steps/phases succeeded. This is the default condition.',
    type: 'function',
    examples: ['condition: ${{ success() }}'],
  },
  'failure()': {
    title: 'failure()',
    description: 'Returns true if any previous step/phase failed. Useful for cleanup or error handling steps.',
    type: 'function',
    examples: ['condition: ${{ failure() }}'],
  },
  'cancelled()': {
    title: 'cancelled()',
    description: 'Returns true if the workflow was cancelled.',
    type: 'function',
    examples: ['condition: ${{ cancelled() }}'],
  },
};

/**
 * Documentation for expression contexts
 */
const EXPRESSION_CONTEXTS: Record<string, HoverDocumentation> = {
  env: {
    title: 'Environment Variables',
    description: 'Access environment variables. Example: `env.MY_VAR`',
    type: 'object',
    examples: ['${{ env.NODE_ENV }}', '${{ env.API_URL }}'],
  },
  secrets: {
    title: 'Secrets',
    description: 'Access secrets stored in the secrets manager. Example: `secrets.API_KEY`',
    type: 'object',
    examples: ['${{ secrets.GITHUB_TOKEN }}', '${{ secrets.DATABASE_URL }}'],
  },
  steps: {
    title: 'Step Outputs',
    description: 'Access outputs from previous steps. Format: `steps.<step-name>.outputs.<output-name>`',
    type: 'object',
    examples: ['${{ steps.build.outputs.artifact }}', '${{ steps.test.outputs.coverage }}'],
  },
  phases: {
    title: 'Phase Outputs',
    description: 'Access outputs from previous phases. Format: `phases.<phase-name>.outputs.<output-name>`',
    type: 'object',
    examples: ['${{ phases.setup.outputs.version }}'],
  },
  workflow: {
    title: 'Workflow Context',
    description: 'Access workflow metadata and context.',
    type: 'object',
    examples: ['${{ workflow.name }}', '${{ workflow.run_id }}'],
  },
  trigger: {
    title: 'Trigger Context',
    description: 'Access information about what triggered the workflow.',
    type: 'object',
    examples: ['${{ trigger.type }}', '${{ trigger.event }}', '${{ trigger.payload }}'],
  },
};

/**
 * Hover provider for workflow files
 */
export class WorkflowHoverProvider implements vscode.HoverProvider {
  private readonly logger = getLogger().child('hover');

  /**
   * Provide hover information for the given position
   */
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    try {
      const line = document.lineAt(position.line);
      const text = line.text;
      const wordRange = document.getWordRangeAtPosition(position);

      if (!wordRange) {
        return null;
      }

      const word = document.getText(wordRange);

      // Check if we're inside an expression ${{ }}
      if (this.isInExpression(text, position.character)) {
        return this.getExpressionHover(text, position.character, word);
      }

      // Check if this is a YAML key (property)
      if (this.isPropertyKey(text, word, position.character)) {
        return this.getPropertyHover(word);
      }

      // Check if this is a value with documentation
      const propertyName = this.getPropertyNameForValue(text, position.character);
      if (propertyName) {
        return this.getValueHover(word, propertyName);
      }

      return null;
    } catch (error) {
      this.logger.error('Error providing hover', error as Error);
      return null;
    }
  }

  /**
   * Checks if position is inside an expression ${{ }}
   */
  private isInExpression(text: string, character: number): boolean {
    const before = text.substring(0, character);
    const lastOpen = before.lastIndexOf('${{');
    if (lastOpen === -1) return false;

    const closeAfterOpen = before.substring(lastOpen).indexOf('}}');
    return closeAfterOpen === -1;
  }

  /**
   * Gets hover information for expression content
   */
  private getExpressionHover(text: string, character: number, word: string): vscode.Hover | null {
    // Check for function
    const funcMatch = text.match(new RegExp(`${word}\\s*\\(`));
    if (funcMatch) {
      const funcName = `${word}()`;
      const funcDoc = EXPRESSION_FUNCTIONS[funcName];
      if (funcDoc) {
        return new vscode.Hover(this.formatDocumentation(funcDoc));
      }
    }

    // Check for context
    const contextDoc = EXPRESSION_CONTEXTS[word];
    if (contextDoc) {
      return new vscode.Hover(this.formatDocumentation(contextDoc));
    }

    return null;
  }

  /**
   * Checks if the word at position is a YAML property key
   */
  private isPropertyKey(text: string, word: string, character: number): boolean {
    // Property keys are followed by a colon
    const afterWord = text.substring(character);
    const colonMatch = afterWord.match(/^\w*\s*:/);
    if (colonMatch) {
      return true;
    }

    // Also check if the colon is before the word (array item)
    const beforeWord = text.substring(0, character);
    const keyPattern = new RegExp(`(^\\s*-\\s*)?${word}\\s*:`, 'g');
    return keyPattern.test(text);
  }

  /**
   * Gets hover information for a property key
   */
  private getPropertyHover(property: string): vscode.Hover | null {
    const doc = DOCUMENTATION[property];
    if (doc) {
      return new vscode.Hover(this.formatDocumentation(doc));
    }
    return null;
  }

  /**
   * Gets the property name for a value at the given position
   */
  private getPropertyNameForValue(text: string, character: number): string | null {
    // Look for the property name before the value
    const trimmed = text.trim();
    const colonIndex = trimmed.indexOf(':');

    if (colonIndex > 0) {
      // Remove any leading dash for array items
      const beforeColon = trimmed.substring(0, colonIndex).replace(/^-\s*/, '').trim();
      return beforeColon;
    }

    return null;
  }

  /**
   * Gets hover information for a value of a specific property
   */
  private getValueHover(value: string, propertyName: string): vscode.Hover | null {
    // Check if this is an enum value
    const propDoc = DOCUMENTATION[propertyName];
    if (propDoc?.values?.includes(value)) {
      return new vscode.Hover(this.formatValueDocumentation(value, propertyName));
    }

    return null;
  }

  /**
   * Formats documentation as Markdown for hover display
   */
  private formatDocumentation(doc: HoverDocumentation): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    // Title
    md.appendMarkdown(`### ${doc.title}\n\n`);

    // Description
    md.appendMarkdown(`${doc.description}\n\n`);

    // Type and required status
    if (doc.type) {
      md.appendMarkdown(`**Type:** \`${doc.type}\``);
      if (doc.required !== undefined) {
        md.appendMarkdown(doc.required ? ' *(required)*' : ' *(optional)*');
      }
      md.appendMarkdown('\n\n');
    }

    // Enum values
    if (doc.values && doc.values.length > 0) {
      md.appendMarkdown('**Values:**\n');
      for (const value of doc.values) {
        md.appendMarkdown(`- \`${value}\`\n`);
      }
      md.appendMarkdown('\n');
    }

    // Examples
    if (doc.examples && doc.examples.length > 0) {
      md.appendMarkdown('**Examples:**\n');
      md.appendCodeblock(doc.examples.join('\n'), 'yaml');
    }

    return md;
  }

  /**
   * Formats value documentation for enum values
   */
  private formatValueDocumentation(value: string, propertyName: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    // Value-specific documentation
    const valueDescriptions: Record<string, Record<string, string>> = {
      type: {
        manual: 'Workflow can be started manually via API or UI',
        schedule: 'Workflow runs on a cron schedule',
        webhook: 'Workflow starts when a webhook is received',
        issue: 'Workflow starts on GitHub issue events',
        pull_request: 'Workflow starts on pull request events',
        push: 'Workflow starts on push events to the repository',
      },
      strategy: {
        fail: 'Stop execution immediately when an error occurs',
        continue: 'Ignore the error and continue with the next step/phase',
        retry: 'Retry the failed step/phase according to retry configuration',
      },
      backoff: {
        exponential: 'Delay doubles between each retry (10s, 20s, 40s, ...)',
        linear: 'Delay increases by a fixed amount (10s, 20s, 30s, ...)',
        constant: 'Same delay between all retries (10s, 10s, 10s, ...)',
      },
    };

    const description = valueDescriptions[propertyName]?.[value] || `Value for ${propertyName}`;

    md.appendMarkdown(`### \`${value}\`\n\n`);
    md.appendMarkdown(description);

    return md;
  }
}

/**
 * Registers the hover provider for workflow files
 */
export function registerHoverProvider(context: vscode.ExtensionContext): vscode.Disposable[] {
  const logger = getLogger();
  const disposables: vscode.Disposable[] = [];

  const provider = new WorkflowHoverProvider();

  // Register for generacy-workflow language
  disposables.push(
    vscode.languages.registerHoverProvider(
      { language: LANGUAGE_IDS.workflow },
      provider
    )
  );

  // Also register for generic YAML files in .generacy directory
  disposables.push(
    vscode.languages.registerHoverProvider(
      { language: LANGUAGE_IDS.yaml, pattern: '**/.generacy/**/*.{yaml,yml}' },
      provider
    )
  );

  logger.info('Registered workflow hover provider');

  return disposables;
}
