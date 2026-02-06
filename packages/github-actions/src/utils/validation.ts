import { z } from 'zod';

/**
 * Validate a GitHub SHA (40-character hex string)
 */
export const shaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/i, 'Invalid SHA: must be a 40-character hex string');

/**
 * Validate a workflow identifier (filename or numeric ID)
 */
export const workflowIdSchema = z.union([
  z.number().positive('Workflow ID must be positive'),
  z.string().min(1, 'Workflow filename cannot be empty'),
]);

/**
 * Validate a run ID
 */
export const runIdSchema = z.number().positive('Run ID must be positive');

/**
 * Validate a job ID
 */
export const jobIdSchema = z.number().positive('Job ID must be positive');

/**
 * Validate an artifact ID
 */
export const artifactIdSchema = z
  .number()
  .positive('Artifact ID must be positive');

/**
 * Validate a check run ID
 */
export const checkRunIdSchema = z
  .number()
  .positive('Check run ID must be positive');

/**
 * Validate workflow inputs (key-value pairs of strings)
 */
export const workflowInputsSchema = z.record(z.string(), z.string()).optional();

/**
 * Validate a Git ref (branch or tag name)
 */
export const gitRefSchema = z
  .string()
  .min(1, 'Git ref cannot be empty')
  .optional();

/**
 * Check if a value is a valid SHA
 */
export function isValidSha(value: string): boolean {
  return shaSchema.safeParse(value).success;
}

/**
 * Check if a value is a valid workflow identifier
 */
export function isValidWorkflowId(value: string | number): boolean {
  return workflowIdSchema.safeParse(value).success;
}

/**
 * Check if a value is a positive integer
 */
export function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Assert that a value is defined (not null or undefined)
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: string
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}

/**
 * Parse and validate trigger workflow parameters
 */
export const triggerWorkflowParamsSchema = z.object({
  workflow: workflowIdSchema,
  ref: gitRefSchema,
  inputs: workflowInputsSchema,
});

/**
 * Validate trigger workflow parameters
 */
export function validateTriggerParams(params: unknown): {
  workflow: string | number;
  ref?: string;
  inputs?: Record<string, string>;
} {
  return triggerWorkflowParamsSchema.parse(params);
}
