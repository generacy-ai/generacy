/**
 * Shell action handler.
 * Handles generic shell command execution as a fallback.
 */
import { BaseAction } from './base-action';
import type {
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
} from './types';
import { parseActionType } from './types';
import type { WorkflowStep } from '../types';
import { executeShellCommand, extractJSON } from './cli-utils';

/**
 * Action handler for shell commands (fallback handler)
 */
export class ShellAction extends BaseAction {
  readonly type: ActionType = 'shell';

  canHandle(step: WorkflowStep): boolean {
    return parseActionType(step) === 'shell';
  }

  validate(step: WorkflowStep): ValidationResult {
    const errors = [];
    const warnings = [];

    // Get command from step
    const command = step.command || step.script;

    if (!command) {
      errors.push({
        field: 'command',
        message: 'Command or script is required for shell action',
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
    // Get command from step
    const command = step.command || step.script;

    if (!command) {
      return this.failureResult('Command or script is required');
    }

    context.logger.info(`Executing shell command: ${command.substring(0, 50)}...`);

    try {
      // Execute the shell command
      const result = await executeShellCommand(command, {
        cwd: context.workdir,
        env: this.mergeEnv(context, step.env),
        timeout: step.timeout || 300000, // 5 minute default
        signal: context.signal,
      });

      // Try to parse JSON from output
      const parsedOutput = extractJSON(result.stdout);

      // Check exit code
      if (result.exitCode !== 0 && !step.continueOnError) {
        return this.failureResult(
          `Command failed with exit code ${result.exitCode}`,
          {
            output: parsedOutput ?? result.stdout,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }
        );
      }

      context.logger.info('Shell command completed');

      return this.successResult(parsedOutput ?? result.stdout, {
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
