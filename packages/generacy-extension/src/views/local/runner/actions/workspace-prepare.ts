/**
 * Workspace prepare action handler.
 * Handles git branch operations: create and checkout branches.
 */
import { BaseAction } from './base-action';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
  WorkspacePrepareInput,
  WorkspacePrepareOutput,
} from './types';
import { parseActionType } from './types';
import type { WorkflowStep } from '../types';
import { executeCommand, checkCLI } from './cli-utils';

/**
 * Action handler for workspace.prepare (git branch operations)
 */
export class WorkspacePrepareAction extends BaseAction {
  readonly type: ActionType = 'workspace.prepare';

  canHandle(step: WorkflowStep): boolean {
    return parseActionType(step) === 'workspace.prepare';
  }

  validate(step: WorkflowStep): ValidationResult {
    const errors = [];
    const warnings = [];

    // Get input from step's 'with' field
    const inputs = (step as WorkflowStep & { with?: WorkspacePrepareInput }).with;

    if (!inputs?.branch) {
      errors.push({
        field: 'with.branch',
        message: 'Branch name is required for workspace.prepare action',
        code: 'MISSING_BRANCH',
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
    // Check git availability
    const gitStatus = await checkCLI('git');
    if (!gitStatus.available) {
      return this.failureResult(gitStatus.error || 'git is not available');
    }

    // Get input parameters
    const inputs = this.getStepInputs(step, context);
    const { branch, baseBranch, force } = inputs;

    if (!branch) {
      return this.failureResult('Branch name is required');
    }

    context.logger.info(`Preparing workspace: branch=${branch}`);

    try {
      // Get current branch first
      const currentBranchResult = await executeCommand(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        {
          cwd: context.workdir,
          signal: context.signal,
        }
      );

      const previousBranch = currentBranchResult.stdout.trim();

      // Check if branch already exists
      const branchExistsResult = await executeCommand(
        'git',
        ['rev-parse', '--verify', branch],
        {
          cwd: context.workdir,
          signal: context.signal,
        }
      );

      const branchExists = branchExistsResult.exitCode === 0;
      let created = false;

      if (branchExists) {
        context.logger.info(`Branch ${branch} already exists, checking out`);

        // Checkout existing branch
        const checkoutArgs = force ? ['checkout', '-f', branch] : ['checkout', branch];
        const checkoutResult = await executeCommand('git', checkoutArgs, {
          cwd: context.workdir,
          signal: context.signal,
        });

        if (checkoutResult.exitCode !== 0) {
          return this.failureResult(
            `Failed to checkout branch ${branch}: ${checkoutResult.stderr}`,
            {
              exitCode: checkoutResult.exitCode,
              stdout: checkoutResult.stdout,
              stderr: checkoutResult.stderr,
            }
          );
        }
      } else {
        context.logger.info(`Creating new branch ${branch}`);
        created = true;

        // If baseBranch specified, checkout it first
        if (baseBranch) {
          const baseCheckoutResult = await executeCommand(
            'git',
            ['checkout', baseBranch],
            {
              cwd: context.workdir,
              signal: context.signal,
            }
          );

          if (baseCheckoutResult.exitCode !== 0) {
            return this.failureResult(
              `Failed to checkout base branch ${baseBranch}: ${baseCheckoutResult.stderr}`,
              {
                exitCode: baseCheckoutResult.exitCode,
                stdout: baseCheckoutResult.stdout,
                stderr: baseCheckoutResult.stderr,
              }
            );
          }
        }

        // Create and checkout new branch
        const createArgs = ['checkout', '-b', branch];
        const createResult = await executeCommand('git', createArgs, {
          cwd: context.workdir,
          signal: context.signal,
        });

        if (createResult.exitCode !== 0) {
          return this.failureResult(
            `Failed to create branch ${branch}: ${createResult.stderr}`,
            {
              exitCode: createResult.exitCode,
              stdout: createResult.stdout,
              stderr: createResult.stderr,
            }
          );
        }
      }

      const output: WorkspacePrepareOutput = {
        branch,
        previousBranch,
        created,
      };

      context.logger.info(`Workspace prepared: now on branch ${branch}`);

      return this.successResult(output, {
        stdout: `Checked out branch: ${branch}`,
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
  ): WorkspacePrepareInput {
    // Get from step's 'with' field
    const stepInputs = (step as WorkflowStep & { with?: Record<string, unknown> }).with || {};

    // Also support getting branch from context inputs (for variable interpolation)
    return {
      branch: String(stepInputs['branch'] ?? this.getInput(step, context, 'branch') ?? ''),
      baseBranch: stepInputs['baseBranch'] as string | undefined ??
                  this.getInput<string>(step, context, 'baseBranch'),
      force: Boolean(stepInputs['force'] ?? this.getInput(step, context, 'force') ?? false),
    };
  }
}
