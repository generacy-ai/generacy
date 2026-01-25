/**
 * Execution context for variable interpolation.
 * Manages inputs, step outputs, and environment for template resolution.
 */
import type { StepOutput } from '../types/action.js';

/**
 * Interpolation context interface
 */
export interface InterpolationContext {
  /** Workflow inputs */
  inputs: Record<string, unknown>;
  /** Step outputs keyed by step ID */
  steps: Record<string, StepOutput>;
  /** Environment variables */
  env: Record<string, string>;
  /** Built-in functions */
  functions: {
    success: () => boolean;
    failure: () => boolean;
    always: () => boolean;
  };
}

/**
 * Execution context manager for tracking step outputs and providing interpolation context.
 */
export class ExecutionContext {
  private stepOutputs = new Map<string, StepOutput>();
  private workflowInputs: Record<string, unknown> = {};
  private environmentVars: Record<string, string> = {};
  private lastStepSuccess = true;
  private hasAnyFailure = false;

  /**
   * Create a new execution context
   * @param inputs Initial workflow inputs
   * @param env Initial environment variables
   */
  constructor(inputs?: Record<string, unknown>, env?: Record<string, string>) {
    if (inputs) {
      this.workflowInputs = { ...inputs };
    }
    if (env) {
      this.environmentVars = { ...env };
    }
  }

  /**
   * Set workflow inputs
   */
  setInputs(inputs: Record<string, unknown>): void {
    this.workflowInputs = { ...inputs };
  }

  /**
   * Get workflow inputs
   */
  getInputs(): Record<string, unknown> {
    return { ...this.workflowInputs };
  }

  /**
   * Set a single input value
   */
  setInput(key: string, value: unknown): void {
    this.workflowInputs[key] = value;
  }

  /**
   * Get a single input value
   */
  getInput(key: string): unknown {
    return this.workflowInputs[key];
  }

  /**
   * Set environment variables
   */
  setEnvironment(env: Record<string, string>): void {
    this.environmentVars = { ...env };
  }

  /**
   * Get environment variables
   */
  getEnvironment(): Record<string, string> {
    return { ...this.environmentVars };
  }

  /**
   * Set a single environment variable
   */
  setEnv(key: string, value: string): void {
    this.environmentVars[key] = value;
  }

  /**
   * Get a single environment variable
   */
  getEnv(key: string): string | undefined {
    return this.environmentVars[key];
  }

  /**
   * Store output from a completed step
   * @param stepId Unique step identifier
   * @param output The step output to store
   */
  setStepOutput(stepId: string, output: StepOutput): void {
    this.stepOutputs.set(stepId, output);

    // Track success/failure state for functions
    this.lastStepSuccess = output.exitCode === 0;
    if (!this.lastStepSuccess) {
      this.hasAnyFailure = true;
    }
  }

  /**
   * Get output from a previous step
   * @param stepId The step identifier
   * @returns The step output, or undefined if not found
   */
  getStepOutput(stepId: string): StepOutput | undefined {
    return this.stepOutputs.get(stepId);
  }

  /**
   * Check if a step output exists
   */
  hasStepOutput(stepId: string): boolean {
    return this.stepOutputs.has(stepId);
  }

  /**
   * Get all step outputs
   */
  getAllStepOutputs(): Map<string, StepOutput> {
    return new Map(this.stepOutputs);
  }

  /**
   * Clear a specific step output
   */
  clearStepOutput(stepId: string): void {
    this.stepOutputs.delete(stepId);
  }

  /**
   * Clear all step outputs
   */
  clearAllStepOutputs(): void {
    this.stepOutputs.clear();
    this.lastStepSuccess = true;
    this.hasAnyFailure = false;
  }

  /**
   * Get the interpolation context for template resolution
   */
  getInterpolationContext(): InterpolationContext {
    // Convert Map to Record for steps
    const stepsRecord: Record<string, StepOutput> = {};
    for (const [key, value] of this.stepOutputs) {
      stepsRecord[key] = value;
    }

    return {
      inputs: { ...this.workflowInputs },
      steps: stepsRecord,
      env: { ...this.environmentVars },
      functions: {
        success: () => this.lastStepSuccess,
        failure: () => !this.lastStepSuccess,
        always: () => true,
      },
    };
  }

  /**
   * Resolve a variable path in the context
   * @param path The variable path (e.g., 'inputs.issueNumber', 'steps.build.output.version')
   * @returns The resolved value, or undefined if not found
   */
  resolveVariable(path: string): unknown {
    const segments = path.split('.');
    const [type, ...rest] = segments;

    switch (type) {
      case 'inputs':
        return this.resolvePath(this.workflowInputs, rest);

      case 'steps': {
        const [stepId, ...fieldPath] = rest;
        if (!stepId) return undefined;

        const output = this.stepOutputs.get(stepId);
        if (!output) return undefined;

        // If no field path, return the entire output
        if (fieldPath.length === 0) {
          return output.parsed ?? output.raw;
        }

        // Handle 'output' prefix (${steps.stepId.output.field})
        if (fieldPath[0] === 'output') {
          const outputPath = fieldPath.slice(1);
          if (outputPath.length === 0) {
            return output.parsed ?? output.raw;
          }
          // Resolve path in parsed output
          if (output.parsed !== null && typeof output.parsed === 'object') {
            return this.resolvePath(output.parsed as Record<string, unknown>, outputPath);
          }
          return undefined;
        }

        // Direct field access (${steps.stepId.field})
        if (fieldPath[0] === 'raw') {
          return output.raw;
        }
        if (fieldPath[0] === 'exitCode') {
          return output.exitCode;
        }
        if (fieldPath[0] === 'completedAt') {
          return output.completedAt;
        }
        if (fieldPath[0] === 'parsed') {
          const parsedPath = fieldPath.slice(1);
          if (parsedPath.length === 0) {
            return output.parsed;
          }
          if (output.parsed !== null && typeof output.parsed === 'object') {
            return this.resolvePath(output.parsed as Record<string, unknown>, parsedPath);
          }
          return undefined;
        }

        // Try to resolve in parsed output
        if (output.parsed !== null && typeof output.parsed === 'object') {
          return this.resolvePath(output.parsed as Record<string, unknown>, fieldPath);
        }

        return undefined;
      }

      case 'env':
        return rest.length > 0 ? this.environmentVars[rest[0]!] : undefined;

      default:
        return undefined;
    }
  }

  /**
   * Helper to resolve a path in a nested object
   */
  private resolvePath(obj: Record<string, unknown>, path: string[]): unknown {
    let current: unknown = obj;

    for (const segment of path) {
      if (current === null || current === undefined) {
        return undefined;
      }

      // Handle array indexing (e.g., 'items[0]' or just '0' for arrays)
      const arrayMatch = segment.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, key, indexStr] = arrayMatch;
        if (typeof current !== 'object') return undefined;
        const arr = (current as Record<string, unknown>)[key!];
        if (!Array.isArray(arr)) return undefined;
        const index = parseInt(indexStr!, 10);
        current = arr[index];
        continue;
      }

      // Handle numeric index for arrays
      if (Array.isArray(current) && /^\d+$/.test(segment)) {
        const index = parseInt(segment, 10);
        current = current[index];
        continue;
      }

      // Handle object property access
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[segment];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Create a child context for a specific phase (inherits parent values)
   */
  createChildContext(): ExecutionContext {
    const child = new ExecutionContext(
      { ...this.workflowInputs },
      { ...this.environmentVars }
    );

    // Copy step outputs
    for (const [key, value] of this.stepOutputs) {
      child.stepOutputs.set(key, value);
    }

    child.lastStepSuccess = this.lastStepSuccess;
    child.hasAnyFailure = this.hasAnyFailure;

    return child;
  }
}
