import { z, type ZodSchema, type ZodError } from 'zod';
import { GitHubValidationError } from './errors.js';
import {
  GitHubIssuesConfigSchema,
  CreateIssueParamsSchema,
  UpdateIssueParamsSchema,
  IssueFilterSchema,
} from '../types/index.js';

/**
 * Format Zod errors into a structured details object
 */
function formatZodErrors(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    if (!details[path]) {
      details[path] = [];
    }
    details[path].push(issue.message);
  }

  return details;
}

/**
 * Validate data against a Zod schema
 * @throws GitHubValidationError if validation fails
 */
export function validate<T>(schema: ZodSchema<T>, data: unknown, context?: string): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const details = formatZodErrors(result.error);
    const prefix = context ? `${context}: ` : '';
    const message = `${prefix}Validation failed`;
    throw new GitHubValidationError(message, details, result.error);
  }

  return result.data;
}

/**
 * Validate configuration
 */
export function validateConfig(config: unknown): z.infer<typeof GitHubIssuesConfigSchema> {
  return validate(GitHubIssuesConfigSchema, config, 'Configuration');
}

/**
 * Validate create issue parameters
 */
export function validateCreateIssueParams(
  params: unknown
): z.infer<typeof CreateIssueParamsSchema> {
  return validate(CreateIssueParamsSchema, params, 'CreateIssueParams');
}

/**
 * Validate update issue parameters
 */
export function validateUpdateIssueParams(
  params: unknown
): z.infer<typeof UpdateIssueParamsSchema> {
  return validate(UpdateIssueParamsSchema, params, 'UpdateIssueParams');
}

/**
 * Validate issue filter parameters
 */
export function validateIssueFilter(filter: unknown): z.infer<typeof IssueFilterSchema> {
  return validate(IssueFilterSchema, filter, 'IssueFilter');
}

/**
 * Check if a value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Check if a value is a positive integer
 */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// Re-export schemas for direct use
export {
  GitHubIssuesConfigSchema,
  CreateIssueParamsSchema,
  UpdateIssueParamsSchema,
  IssueFilterSchema,
};
