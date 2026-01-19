/**
 * Validation functions for Knowledge Store entities
 */

import { ZodError } from 'zod';
import {
  principleSchema,
  philosophySchema,
  patternSchema,
  userContextSchema,
} from './schemas.js';
import type {
  Principle,
  Philosophy,
  Pattern,
  UserContext,
} from '../types/knowledge.js';

/**
 * Result of a validation operation
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: string[];
}

/**
 * Format Zod errors into readable strings
 */
function formatZodErrors(error: ZodError): string[] {
  return error.errors.map((e) => {
    const path = e.path.join('.');
    return path ? `${path}: ${e.message}` : e.message;
  });
}

/**
 * Validate a principle object
 */
export function validatePrinciple(data: unknown): ValidationResult<Principle> {
  const result = principleSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatZodErrors(result.error) };
}

/**
 * Validate a philosophy object
 */
export function validatePhilosophy(data: unknown): ValidationResult<Philosophy> {
  const result = philosophySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatZodErrors(result.error) };
}

/**
 * Validate a pattern object
 */
export function validatePattern(data: unknown): ValidationResult<Pattern> {
  const result = patternSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatZodErrors(result.error) };
}

/**
 * Validate a user context object
 */
export function validateContext(data: unknown): ValidationResult<UserContext> {
  const result = userContextSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatZodErrors(result.error) };
}
