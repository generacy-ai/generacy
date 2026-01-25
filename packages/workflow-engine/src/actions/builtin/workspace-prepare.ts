/**
 * Workspace prepare action handler.
 * Handles git checkout/branch operations.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  StepDefinition,
  WorkspacePrepareInput,
  WorkspacePrepareOutput,
} from '../../types/index.js';
import { parseActionType } from '../../types/action.js';
import { executeCommand } from '../cli-utils.js';

/**
 * Action handler for workspace preparation (git operations)
 */
export class WorkspacePrepareAction extends BaseAction {
  readonly type: ActionType = 'workspace.prepare';

  canHandle(step: StepDefinition): boolean {
    return parseActionType(step) === 'workspace.prepare';
  }

  validate(step: StepDefinition): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const branch = this.getInput<string>(step, { inputs: {}, stepOutputs: new Map(), env: {}, workdir: '', signal: new AbortController().signal, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, workflow: { name: '', phases: [] }, phase: { name: '', steps: [] }, step }, 'branch');

    if (!branch) {
      errors.push({
        field: 'branch',
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
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const input: WorkspacePrepareInput = {
      branch: this.getRequiredInput<string>(step, context, 'branch'),
      baseBranch: this.getInput<string>(step, context, 'baseBranch'),
      force: this.getInput<boolean>(step, context, 'force', false),
    };

    context.logger.info(`Preparing workspace on branch: ${input.branch}`);

    try {
      // Get current branch
      const currentBranchResult = await executeCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: context.workdir,
        signal: context.signal,
      });

      if (currentBranchResult.exitCode !== 0) {
        return this.failureResult('Failed to get current branch', {
          stderr: currentBranchResult.stderr,
        });
      }

      const previousBranch = currentBranchResult.stdout.trim();

      // Check if branch exists
      const branchExistsResult = await executeCommand('git', ['show-ref', '--verify', '--quiet', `refs/heads/${input.branch}`], {
        cwd: context.workdir,
        signal: context.signal,
      });

      const branchExists = branchExistsResult.exitCode === 0;
      let created = false;

      if (branchExists) {
        // Checkout existing branch
        const checkoutArgs = ['checkout', input.branch];
        if (input.force) {
          checkoutArgs.push('--force');
        }

        const checkoutResult = await executeCommand('git', checkoutArgs, {
          cwd: context.workdir,
          signal: context.signal,
        });

        if (checkoutResult.exitCode !== 0) {
          return this.failureResult(`Failed to checkout branch ${input.branch}`, {
            stderr: checkoutResult.stderr,
          });
        }

        context.logger.info(`Checked out existing branch: ${input.branch}`);
      } else {
        // Create new branch
        const createArgs = ['checkout', '-b', input.branch];
        if (input.baseBranch) {
          createArgs.push(input.baseBranch);
        }

        const createResult = await executeCommand('git', createArgs, {
          cwd: context.workdir,
          signal: context.signal,
        });

        if (createResult.exitCode !== 0) {
          return this.failureResult(`Failed to create branch ${input.branch}`, {
            stderr: createResult.stderr,
          });
        }

        created = true;
        context.logger.info(`Created new branch: ${input.branch}`);
      }

      const output: WorkspacePrepareOutput = {
        branch: input.branch,
        previousBranch,
        created,
      };

      return this.successResult(output, {
        stdout: `Branch ${input.branch} ${created ? 'created' : 'checked out'}`,
      });
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
