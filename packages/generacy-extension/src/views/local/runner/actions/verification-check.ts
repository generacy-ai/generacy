/**
 * Verification check action handler.
 * Handles test and lint command execution with result parsing.
 */
import { BaseAction } from './base-action';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
  VerificationCheckInput,
  VerificationCheckOutput,
} from './types';
import { parseActionType } from './types';
import type { WorkflowStep } from '../types';
import { executeShellCommand } from './cli-utils';

/**
 * Action handler for verification.check (test/lint execution)
 */
export class VerificationCheckAction extends BaseAction {
  readonly type: ActionType = 'verification.check';

  canHandle(step: WorkflowStep): boolean {
    return parseActionType(step) === 'verification.check';
  }

  validate(step: WorkflowStep): ValidationResult {
    const errors = [];
    const warnings = [];

    // Get input from step's 'with' field or command field
    const inputs = (step as WorkflowStep & { with?: VerificationCheckInput }).with;
    const command = inputs?.command || step.command;

    if (!command) {
      errors.push({
        field: 'with.command',
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
    step: WorkflowStep,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get input parameters
    const inputs = this.getStepInputs(step, context);
    const { command, workdir, env, expectedExitCode } = inputs;

    if (!command) {
      return this.failureResult('Command is required');
    }

    context.logger.info(`Running verification: ${command}`);

    try {
      // Execute the verification command
      const result = await executeShellCommand(command, {
        cwd: workdir || context.workdir,
        env: this.mergeEnv(context, env),
        timeout: step.timeout || 300000, // 5 minute default
        signal: context.signal,
      });

      // Parse output for test/lint results
      const parsedOutput = this.parseVerificationOutput(result.stdout, result.stderr);

      // Determine success based on exit code
      const expected = expectedExitCode ?? 0;
      const passed = result.exitCode === expected;

      const output: VerificationCheckOutput = {
        passed,
        output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
        ...parsedOutput,
      };

      if (passed) {
        context.logger.info('Verification passed');
        return this.successResult(output, {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } else {
        context.logger.warn(`Verification failed with exit code ${result.exitCode}`);
        return this.failureResult(
          `Verification failed: exit code ${result.exitCode}`,
          {
            output,
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

  /**
   * Extract input parameters from step
   */
  private getStepInputs(
    step: WorkflowStep,
    context: ActionContext
  ): VerificationCheckInput {
    const stepInputs = (step as WorkflowStep & { with?: Record<string, unknown> }).with || {};

    return {
      command: String(
        stepInputs['command'] ??
        step.command ??
        this.getInput(step, context, 'command') ??
        ''
      ),
      workdir: stepInputs['workdir'] as string | undefined ??
               this.getInput<string>(step, context, 'workdir'),
      env: stepInputs['env'] as Record<string, string> | undefined ??
           this.getInput<Record<string, string>>(step, context, 'env'),
      expectedExitCode: stepInputs['expectedExitCode'] as number | undefined ??
                        this.getInput<number>(step, context, 'expectedExitCode'),
    };
  }

  /**
   * Parse test/lint output to extract metrics
   */
  private parseVerificationOutput(
    stdout: string,
    stderr: string
  ): Partial<VerificationCheckOutput> {
    const combined = stdout + '\n' + stderr;
    const result: Partial<VerificationCheckOutput> = {};

    // Try to parse Jest/Vitest style output
    // Example: "Tests: 10 passed, 2 failed, 12 total"
    const jestMatch = combined.match(
      /Tests:\s*(\d+)\s*passed(?:,\s*(\d+)\s*failed)?/i
    );
    if (jestMatch) {
      result.testsPassed = parseInt(jestMatch[1]!, 10);
      result.testsFailed = jestMatch[2] ? parseInt(jestMatch[2], 10) : 0;
      return result;
    }

    // Try to parse pytest style output
    // Example: "10 passed, 2 failed"
    const pytestMatch = combined.match(/(\d+)\s*passed(?:,\s*(\d+)\s*failed)?/i);
    if (pytestMatch) {
      result.testsPassed = parseInt(pytestMatch[1]!, 10);
      result.testsFailed = pytestMatch[2] ? parseInt(pytestMatch[2], 10) : 0;
      return result;
    }

    // Try to parse mocha style output
    // Example: "10 passing (1s)"
    const mochaMatch = combined.match(/(\d+)\s*passing/i);
    if (mochaMatch) {
      result.testsPassed = parseInt(mochaMatch[1]!, 10);
      const failMatch = combined.match(/(\d+)\s*failing/i);
      result.testsFailed = failMatch ? parseInt(failMatch[1]!, 10) : 0;
      return result;
    }

    // Try to parse ESLint style output
    // Example: "✖ 10 problems (5 errors, 5 warnings)"
    const eslintMatch = combined.match(/(\d+)\s*problems?\s*\((\d+)\s*errors?/i);
    if (eslintMatch) {
      result.lintErrors = parseInt(eslintMatch[2]!, 10);
      return result;
    }

    // Alternative ESLint format: "10 errors"
    const errorsMatch = combined.match(/(\d+)\s*errors?/i);
    if (errorsMatch) {
      result.lintErrors = parseInt(errorsMatch[1]!, 10);
      return result;
    }

    return result;
  }
}
