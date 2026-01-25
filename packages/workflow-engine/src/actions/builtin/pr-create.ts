/**
 * PR create action handler.
 * Handles GitHub pull request creation.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
  StepDefinition,
  PrCreateInput,
  PrCreateOutput,
} from '../../types/index.js';
import { parseActionType } from '../../types/action.js';
import { executeCommand, extractJSON } from '../cli-utils.js';

/**
 * Action handler for GitHub PR creation
 */
export class PrCreateAction extends BaseAction {
  readonly type: ActionType = 'pr.create';

  canHandle(step: StepDefinition): boolean {
    return parseActionType(step) === 'pr.create';
  }

  validate(step: StepDefinition): ValidationResult {
    const errors = [];
    const warnings = [];

    const title = step.with?.['title'];

    if (!title) {
      errors.push({
        field: 'title',
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
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: PrCreateInput = {
      title: this.getRequiredInput<string>(step, context, 'title'),
      body: this.getInput<string>(step, context, 'body'),
      base: this.getInput<string>(step, context, 'base'),
      draft: this.getInput<boolean>(step, context, 'draft', false),
      labels: this.getInput<string[]>(step, context, 'labels'),
      reviewers: this.getInput<string[]>(step, context, 'reviewers'),
    };

    context.logger.info(`Creating PR: ${input.title}`);

    try {
      // Build gh pr create command arguments
      const args: string[] = ['pr', 'create', '--title', input.title];

      if (input.body) {
        args.push('--body', input.body);
      } else {
        args.push('--body', '');
      }

      if (input.base) {
        args.push('--base', input.base);
      }

      if (input.draft) {
        args.push('--draft');
      }

      if (input.labels && input.labels.length > 0) {
        for (const label of input.labels) {
          args.push('--label', label);
        }
      }

      if (input.reviewers && input.reviewers.length > 0) {
        for (const reviewer of input.reviewers) {
          args.push('--reviewer', reviewer);
        }
      }

      // Add JSON output
      args.push('--json', 'number,url,state,headRefName,baseRefName');

      // Execute gh pr create
      const result = await executeCommand('gh', args, {
        cwd: context.workdir,
        env: this.mergeEnv(context, step.env),
        timeout: step.timeout ?? 60000, // 1 minute default
        signal: context.signal,
      });

      // Check exit code
      if (result.exitCode !== 0) {
        return this.failureResult(
          `Failed to create PR: ${result.stderr || result.stdout}`,
          {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }
        );
      }

      // Parse JSON output
      const parsedOutput = extractJSON(result.stdout);

      if (!parsedOutput || typeof parsedOutput !== 'object') {
        // Fallback: try to extract PR URL from output
        const urlMatch = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
        if (urlMatch) {
          const prOutput: PrCreateOutput = {
            number: parseInt(urlMatch[1]!, 10),
            url: urlMatch[0]!,
            state: input.draft ? 'draft' : 'open',
            headBranch: '',
            baseBranch: input.base ?? 'main',
          };

          return this.successResult(prOutput, {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        }

        return this.failureResult('Failed to parse PR creation output', {
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }

      const parsed = parsedOutput as Record<string, unknown>;
      const prOutput: PrCreateOutput = {
        number: parsed['number'] as number,
        url: parsed['url'] as string,
        state: (parsed['state'] as string)?.toLowerCase() === 'draft' ? 'draft' : 'open',
        headBranch: parsed['headRefName'] as string,
        baseBranch: parsed['baseRefName'] as string,
      };

      context.logger.info(`PR created: ${prOutput.url}`);

      return this.successResult(prOutput, {
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
}
