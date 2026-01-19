/**
 * Step Executor
 *
 * Base interface and executor factory for step execution.
 */

import type {
  WorkflowStep,
  StepType,
} from '../types/WorkflowDefinition.js';
import type { WorkflowContext } from '../types/WorkflowContext.js';
import type { StepExecutionResult, StepExecutor } from '../engine/WorkflowRuntime.js';

/**
 * Registry of step executors by step type.
 */
export class StepExecutorRegistry {
  private executors: Map<StepType, StepExecutor> = new Map();

  /**
   * Register an executor for a step type.
   */
  register(type: StepType, executor: StepExecutor): void {
    this.executors.set(type, executor);
  }

  /**
   * Get the executor for a step type.
   */
  get(type: StepType): StepExecutor | undefined {
    return this.executors.get(type);
  }

  /**
   * Check if an executor is registered for a step type.
   */
  has(type: StepType): boolean {
    return this.executors.has(type);
  }

  /**
   * Create a composite executor that delegates to registered executors.
   */
  createCompositeExecutor(): StepExecutor {
    return async (step, context, runtime): Promise<StepExecutionResult> => {
      const executor = this.get(step.type);
      if (!executor) {
        return {
          success: false,
          error: {
            code: 'NO_EXECUTOR',
            message: `No executor registered for step type: ${step.type}`,
          },
        };
      }
      return executor(step, context, runtime);
    };
  }
}

/**
 * Base class for step executors with common functionality.
 */
export abstract class BaseStepExecutor {
  /**
   * Execute the step.
   */
  abstract execute(
    step: WorkflowStep,
    context: WorkflowContext
  ): Promise<StepExecutionResult>;

  /**
   * Create a successful result.
   */
  protected success(output?: unknown, nextStepId?: string): StepExecutionResult {
    return {
      success: true,
      output,
      nextStepId,
    };
  }

  /**
   * Create a waiting result (for human steps).
   */
  protected waiting(output?: unknown): StepExecutionResult {
    return {
      success: true,
      waiting: true,
      output,
    };
  }

  /**
   * Create a failure result.
   */
  protected failure(code: string, message: string, details?: Record<string, unknown>): StepExecutionResult {
    return {
      success: false,
      error: {
        code,
        message,
        details,
      },
    };
  }
}

/**
 * Create the default step executor registry with all standard executors.
 */
export function createDefaultRegistry(): StepExecutorRegistry {
  const registry = new StepExecutorRegistry();

  // Import and register executors lazily to avoid circular dependencies
  // This would be done after all executors are defined

  return registry;
}
