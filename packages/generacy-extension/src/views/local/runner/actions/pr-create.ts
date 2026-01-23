/**
 * PR create action handler.
 * Handles GitHub PR creation via gh CLI.
 */
import { BaseAction } from './base-action';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
  PrCreateInput,
  PrCreateOutput,
} from './types';
import { parseActionType } from './types';
import type { WorkflowStep } from '../types';
import { executeCommand, checkCLI, extractJSON } from './cli-utils';

/**
 * Action handler for pr.create (GitHub PR creation)
 */
export class PrCreateAction extends BaseAction {
  readonly type: ActionType = 'pr.create';

  canHandle(step: WorkflowStep): boolean {
    return parseActionType(step) === 'pr.create';
  }

  validate(step: WorkflowStep): ValidationResult {
    const errors = [];
    const warnings = [];

    // Get input from step's 'with' field
    const inputs = (step as WorkflowStep & { with?: PrCreateInput }).with;

    if (!inputs?.title) {
      errors.push({
        field: 'with.title',
        message: 'Title is required for pr.create action',
        code: 'MISSING_TITLE',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  protected async executeInternal(
    step: WorkflowStep,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Check gh CLI availability
    const ghStatus = await checkCLI('gh');
    if (!ghStatus.available) {
      return this.failureResult(
        ghStatus.error ||
          'GitHub CLI (gh) is not available. Install it from: https://cli.github.com/'
      );
    }

    // Get input parameters
    const inputs = this.getStepInputs(step, context);
    const { title, body, base, draft, labels, reviewers } = inputs;

    if (!title) {
      return this.failureResult('Title is required');
    }

    context.logger.info(`Creating PR: ${title}`);

    try {
      // First, get current branch
      const branchResult = await executeCommand(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        {
          cwd: context.workdir,
          signal: context.signal,
        }
      );

      const headBranch = branchResult.stdout.trim();

      // Build gh pr create arguments
      const args = ['pr', 'create', '--title', title];

      if (body) {
        args.push('--body', body);
      }

      if (base) {
        args.push('--base', base);
      }

      if (draft) {
        args.push('--draft');
      }

      if (labels && labels.length > 0) {
        args.push('--label', labels.join(','));
      }

      if (reviewers && reviewers.length > 0) {
        args.push('--reviewer', reviewers.join(','));
      }

      // Request JSON output
      args.push('--json', 'number,url,state,baseRefName');

      // Execute gh pr create
      const result = await executeCommand('gh', args, {
        cwd: context.workdir,
        env: context.env,
        timeout: step.timeout || 60000, // 1 minute default
        signal: context.signal,
      });

      if (result.exitCode !== 0) {
        // Check for common errors
        if (result.stderr.includes('already exists')) {
          context.logger.warn('PR already exists for this branch');

          // Try to get existing PR info
          const existingPr = await this.getExistingPR(context, headBranch);
          if (existingPr) {
            return this.successResult(existingPr, {
              exitCode: 0,
              stdout: `PR already exists: ${existingPr.url}`,
            });
          }
        }

        return this.failureResult(
          `Failed to create PR: ${result.stderr || 'Unknown error'}`,
          {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }
        );
      }

      // Parse JSON output
      const parsedOutput = extractJSON(result.stdout);
      const output = this.parsePROutput(parsedOutput, headBranch, base);

      context.logger.info(`PR created: ${output.url}`);

      return this.successResult(output, {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Extract input parameters from step
   */
  private getStepInputs(
    step: WorkflowStep,
    context: ActionContext
  ): PrCreateInput {
    const stepInputs = (step as WorkflowStep & { with?: Record<string, unknown> }).with || {};

    return {
      title: String(stepInputs['title'] ?? this.getInput(step, context, 'title') ?? ''),
      body: stepInputs['body'] as string | undefined ??
            this.getInput<string>(step, context, 'body'),
      base: stepInputs['base'] as string | undefined ??
            this.getInput<string>(step, context, 'base'),
      draft: Boolean(stepInputs['draft'] ?? this.getInput(step, context, 'draft') ?? false),
      labels: stepInputs['labels'] as string[] | undefined ??
              this.getInput<string[]>(step, context, 'labels'),
      reviewers: stepInputs['reviewers'] as string[] | undefined ??
                 this.getInput<string[]>(step, context, 'reviewers'),
    };
  }

  /**
   * Parse PR output from gh CLI response
   */
  private parsePROutput(
    parsed: unknown,
    headBranch: string,
    baseBranch?: string
  ): PrCreateOutput {
    const defaultOutput: PrCreateOutput = {
      number: 0,
      url: '',
      state: 'open',
      headBranch,
      baseBranch: baseBranch || 'main',
    };

    if (!parsed || typeof parsed !== 'object') {
      return defaultOutput;
    }

    const data = parsed as Record<string, unknown>;

    return {
      number: Number(data['number'] ?? 0),
      url: String(data['url'] ?? ''),
      state: data['state'] === 'DRAFT' ? 'draft' : 'open',
      headBranch,
      baseBranch: String(data['baseRefName'] ?? baseBranch ?? 'main'),
    };
  }

  /**
   * Get existing PR for a branch
   */
  private async getExistingPR(
    context: ActionContext,
    headBranch: string
  ): Promise<PrCreateOutput | null> {
    try {
      const result = await executeCommand(
        'gh',
        ['pr', 'view', headBranch, '--json', 'number,url,state,baseRefName'],
        {
          cwd: context.workdir,
          signal: context.signal,
        }
      );

      if (result.exitCode !== 0) {
        return null;
      }

      const parsed = extractJSON(result.stdout);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      const data = parsed as Record<string, unknown>;
      return {
        number: Number(data['number'] ?? 0),
        url: String(data['url'] ?? ''),
        state: data['state'] === 'DRAFT' ? 'draft' : 'open',
        headBranch,
        baseBranch: String(data['baseRefName'] ?? 'main'),
      };
    } catch {
      return null;
    }
  }
}
