/**
 * Workflow validator using Zod schemas.
 */
import { ZodError } from 'zod';
import { WorkflowDefinitionSchema } from './schema.js';
import type { WorkflowDefinition } from '../types/workflow.js';

/**
 * Validation error with detailed information
 */
export class WorkflowValidationError extends Error {
  public readonly issues: Array<{
    path: string;
    message: string;
    code: string;
  }>;

  constructor(message: string, issues: Array<{ path: string; message: string; code: string }>) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.issues = issues;
  }
}

/**
 * Validate a workflow definition object
 * @param data Raw workflow data (parsed from YAML)
 * @returns Validated WorkflowDefinition
 * @throws WorkflowValidationError if validation fails
 */
export function validateWorkflow(data: unknown): WorkflowDefinition {
  try {
    const result = WorkflowDefinitionSchema.parse(data);

    // Transform to our internal type format
    return {
      name: result.name,
      description: result.description,
      version: result.version,
      inputs: result.inputs?.map(input => ({
        name: input.name,
        description: input.description,
        default: input.default,
        required: input.required,
        type: input.type,
      })),
      phases: result.phases.map(phase => ({
        name: phase.name,
        condition: phase.condition,
        steps: phase.steps.map(step => ({
          name: step.name,
          action: step.action ?? 'shell',
          uses: step.uses,
          with: step.with,
          command: step.command,
          script: step.script,
          timeout: step.timeout,
          continueOnError: step.continueOnError,
          condition: step.condition,
          env: step.env,
          retry: step.retry ? {
            maxAttempts: step.retry.maxAttempts,
            delay: typeof step.retry.delay === 'number' ? step.retry.delay : parseDuration(step.retry.delay),
            backoff: step.retry.backoff,
            maxDelay: step.retry.maxDelay
              ? (typeof step.retry.maxDelay === 'number' ? step.retry.maxDelay : parseDuration(step.retry.maxDelay))
              : undefined,
            jitter: step.retry.jitter,
          } : undefined,
        })),
      })),
      env: result.env,
      timeout: result.timeout,
      retry: result.retry ? {
        maxAttempts: result.retry.maxAttempts,
        delay: typeof result.retry.delay === 'number' ? result.retry.delay : parseDuration(result.retry.delay),
        backoff: result.retry.backoff,
        maxDelay: result.retry.maxDelay
          ? (typeof result.retry.maxDelay === 'number' ? result.retry.maxDelay : parseDuration(result.retry.maxDelay))
          : undefined,
        jitter: result.retry.jitter,
      } : undefined,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      }));

      const message = `Workflow validation failed:\n${issues.map(i => `  - ${i.path}: ${i.message}`).join('\n')}`;
      throw new WorkflowValidationError(message, issues);
    }
    throw error;
  }
}

/**
 * Parse a duration string to milliseconds
 * @param duration Duration string (e.g., '10s', '5m', '1h', '1000ms')
 * @returns Duration in milliseconds
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const [, value, unit] = match;
  const numValue = parseFloat(value!);

  switch (unit?.toLowerCase()) {
    case 'h':
      return numValue * 60 * 60 * 1000;
    case 'm':
      return numValue * 60 * 1000;
    case 's':
      return numValue * 1000;
    case 'ms':
    case undefined:
      return numValue;
    default:
      return numValue;
  }
}

/**
 * Check if a workflow definition is valid without throwing
 * @param data Raw workflow data
 * @returns Object with valid flag and optional error
 */
export function isValidWorkflow(data: unknown): { valid: boolean; error?: WorkflowValidationError } {
  try {
    validateWorkflow(data);
    return { valid: true };
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      return { valid: false, error };
    }
    return {
      valid: false,
      error: new WorkflowValidationError(
        error instanceof Error ? error.message : 'Unknown validation error',
        []
      ),
    };
  }
}
