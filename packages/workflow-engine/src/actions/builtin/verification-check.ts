/**
 * Verification check action handler.
 * Handles running tests and linting commands.
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
  VerificationCheckInput,
  VerificationCheckOutput,
} from '../../types/index.js';
import { parseActionType } from '../../types/action.js';
import { executeShellCommand } from '../cli-utils.js';

/**
 * Action handler for verification (test/lint) execution
 */
export class VerificationCheckAction extends BaseAction {
  readonly type: ActionType = 'verification.check';

  canHandle(step: StepDefinition): boolean {
    return parseActionType(step) === 'verification.check';
  }

  validate(step: StepDefinition): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const command = step.with?.['command'] ?? step.command;

    if (!command) {
      errors.push({
        field: 'command',
        message: 'Command is required for verification.check action',
        code: 'MISSING_COMMAND',
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
    const input: VerificationCheckInput = {
      command: this.getInput<string>(step, context, 'command') ?? step.command ?? '',
      workdir: this.getInput<string>(step, context, 'workdir', context.workdir),
      env: this.getInput<Record<string, string>>(step, context, 'env'),
      expectedExitCode: this.getInput<number>(step, context, 'expectedExitCode', 0),
    };

    if (!input.command) {
      return this.failureResult('Command is required');
    }

    context.logger.info(`Running verification: ${input.command}`);

    try {
      // Execute the verification command
      const result = await executeShellCommand(input.command, {
        cwd: input.workdir ?? context.workdir,
        env: this.mergeEnv(context, { ...step.env, ...input.env }),
        timeout: step.timeout ?? 600000, // 10 minute default for tests
        signal: context.signal,
      });

      // Parse test results if possible
      const verificationOutput: VerificationCheckOutput = {
        passed: result.exitCode === (input.expectedExitCode ?? 0),
        output: result.stdout + (result.stderr ? '\n' + result.stderr : ''),
      };

      // Try to extract test counts from common test runner output patterns
      const passedMatch = result.stdout.match(/(\d+)\s+pass(?:ed|ing)?/i);
      const failedMatch = result.stdout.match(/(\d+)\s+fail(?:ed|ing|ures?)?/i);
      const lintErrorsMatch = result.stdout.match(/(\d+)\s+(?:error|problem)s?/i);

      if (passedMatch) {
        verificationOutput.testsPassed = parseInt(passedMatch[1]!, 10);
      }
      if (failedMatch) {
        verificationOutput.testsFailed = parseInt(failedMatch[1]!, 10);
      }
      if (lintErrorsMatch) {
        verificationOutput.lintErrors = parseInt(lintErrorsMatch[1]!, 10);
      }

      // Determine success
      const success = verificationOutput.passed;

      if (success) {
        context.logger.info('Verification passed');
      } else {
        context.logger.warn(`Verification failed with exit code ${result.exitCode}`);
      }

      if (success) {
        return this.successResult(verificationOutput, {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } else {
        return this.failureResult(
          `Verification failed with exit code ${result.exitCode}`,
          {
            output: verificationOutput,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }
        );
      }
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
