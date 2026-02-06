/**
 * Input validation utilities using Zod schemas.
 */

import { z } from 'zod';

/**
 * Validate a build ID format.
 */
export const BuildIdSchema = z.string().min(1, 'Build ID is required');

/**
 * Validate a trigger ID format.
 */
export const TriggerIdSchema = z.string().min(1, 'Trigger ID is required');

/**
 * Validate a trigger name format (lowercase, alphanumeric with hyphens).
 */
export const TriggerNameSchema = z.string()
  .min(1, 'Trigger name is required')
  .regex(/^[a-z][a-z0-9-]*$/, 'Trigger name must start with a letter and contain only lowercase letters, numbers, and hyphens');

/**
 * Validate substitution keys (must start with _ and be uppercase).
 */
export const SubstitutionKeySchema = z.string()
  .regex(/^_[A-Z0-9_]+$/, 'Substitution key must start with _ and contain only uppercase letters, numbers, and underscores');

/**
 * Validate a timeout duration string (e.g., "3600s").
 */
export const TimeoutSchema = z.string()
  .regex(/^\d+s$/, 'Timeout must be a duration string (e.g., "3600s")');

/**
 * Validate page size for pagination.
 */
export const PageSizeSchema = z.number()
  .int()
  .min(1)
  .max(1000)
  .optional();

/**
 * Validate artifact path.
 */
export const ArtifactPathSchema = z.string().min(1, 'Artifact path is required');

/**
 * Validate GCS bucket name.
 */
export const BucketNameSchema = z.string()
  .min(3, 'Bucket name must be at least 3 characters')
  .max(63, 'Bucket name must be at most 63 characters')
  .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/, 'Invalid bucket name format');

/**
 * Schema for validating substitutions record.
 */
export const SubstitutionsSchema = z.record(
  SubstitutionKeySchema,
  z.string()
).optional();

/**
 * Validate a value and throw if invalid.
 */
export function validate<T>(schema: z.ZodSchema<T>, value: unknown): T {
  return schema.parse(value);
}

/**
 * Safely validate a value, returning the result.
 */
export function safeValidate<T>(schema: z.ZodSchema<T>, value: unknown): z.SafeParseReturnType<unknown, T> {
  return schema.safeParse(value);
}

/**
 * Check if substitutions record has valid keys.
 */
export function validateSubstitutions(substitutions: Record<string, string> | undefined): boolean {
  if (!substitutions) return true;

  return Object.keys(substitutions).every(key => {
    const result = SubstitutionKeySchema.safeParse(key);
    return result.success;
  });
}
