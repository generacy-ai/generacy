/**
 * Abstract base action class implementing common functionality.
 * Provides logging, timing, error wrapping, and shared utilities.
 */
import type {
  ActionHandler,
  ActionContext,
  ActionResult,
  ActionType,
  ValidationResult,
} from './types';
import type { WorkflowStep } from '../types';

/**
 * Abstract base class for action handlers.
 * Provides common functionality like timing, logging, and error handling.
 */
export abstract class BaseAction implements ActionHandler {
  abstract readonly type: ActionType;

  /**
   * Check if this handler can process the given step
   */
  abstract canHandle(step: WorkflowStep): boolean;

  /**
   * Internal execution implementation to be overridden by subclasses
   */
  protected abstract executeInternal(
    step: WorkflowStep,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>>;

  /**
   * Execute the action with timing and error handling
   */
  async execute(step: WorkflowStep, context: ActionContext): Promise<ActionResult> {
    const startTime = Date.now();

    // Log action start
    context.logger.info(`Starting action [${this.type}]: ${step.name}`);

    try {
      // Check for cancellation before execution
      if (context.signal.aborted) {
        return {
          success: false,
          output: null,
          error: 'Action cancelled before execution',
          duration: Date.now() - startTime,
        };
      }

      // Execute the action
      const result = await this.executeInternal(step, context);

      const duration = Date.now() - startTime;

      // Log completion
      if (result.success) {
        context.logger.info(`Action [${this.type}] completed successfully in ${duration}ms`);
      } else {
        context.logger.error(`Action [${this.type}] failed: ${result.error || 'Unknown error'}`);
      }

      return {
        ...result,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      context.logger.error(`Action [${this.type}] threw error: ${errorMessage}`);

      return {
        success: false,
        output: null,
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * Default validation implementation - can be overridden
   */
  validate(_step: WorkflowStep): ValidationResult {
    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  /**
   * Helper to get step input with optional default
   */
  protected getInput<T>(
    step: WorkflowStep,
    context: ActionContext,
    key: string,
    defaultValue?: T
  ): T | undefined {
    // Check step-level inputs first (from 'with' field in YAML)
    const stepInputs = (step as WorkflowStep & { with?: Record<string, unknown> }).with;
    if (stepInputs && key in stepInputs) {
      return stepInputs[key] as T;
    }

    // Check workflow-level inputs
    if (key in context.inputs) {
      return context.inputs[key] as T;
    }

    return defaultValue;
  }

  /**
   * Helper to get required input, throwing if not present
   */
  protected getRequiredInput<T>(
    step: WorkflowStep,
    context: ActionContext,
    key: string
  ): T {
    const value = this.getInput<T>(step, context, key);
    if (value === undefined) {
      throw new Error(`Required input '${key}' not provided for step '${step.name}'`);
    }
    return value;
  }

  /**
   * Helper to create a successful result
   */
  protected successResult(
    output: unknown,
    options?: {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      filesModified?: string[];
    }
  ): Omit<ActionResult, 'duration'> {
    return {
      success: true,
      output,
      exitCode: options?.exitCode ?? 0,
      stdout: options?.stdout,
      stderr: options?.stderr,
      filesModified: options?.filesModified,
    };
  }

  /**
   * Helper to create a failure result
   */
  protected failureResult(
    error: string,
    options?: {
      output?: unknown;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    }
  ): Omit<ActionResult, 'duration'> {
    return {
      success: false,
      output: options?.output ?? null,
      error,
      exitCode: options?.exitCode ?? 1,
      stdout: options?.stdout,
      stderr: options?.stderr,
    };
  }

  /**
   * Helper to check if signal is aborted (for long-running operations)
   */
  protected checkCancellation(context: ActionContext): void {
    if (context.signal.aborted) {
      throw new Error('Action cancelled');
    }
  }

  /**
   * Helper to merge environment variables
   */
  protected mergeEnv(
    context: ActionContext,
    stepEnv?: Record<string, string>
  ): Record<string, string> {
    return {
      ...process.env as Record<string, string>,
      ...context.env,
      ...stepEnv,
    };
  }
}
