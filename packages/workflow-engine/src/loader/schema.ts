/**
 * Zod validation schemas for workflow definitions.
 */
import { z } from 'zod';

/**
 * Input definition schema
 */
export const InputDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  default: z.unknown().optional(),
  required: z.boolean().optional().default(false),
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']).optional(),
});

/**
 * Retry configuration schema
 */
export const RetryConfigSchema = z.object({
  maxAttempts: z.number().int().min(1).default(1),
  delay: z.union([z.number(), z.string()]).default(1000),
  backoff: z.enum(['constant', 'linear', 'exponential']).default('exponential'),
  maxDelay: z.union([z.number(), z.string()]).optional(),
  jitter: z.number().min(0).max(1).optional(),
});

/**
 * Step definition schema
 */
export const StepDefinitionSchema = z.object({
  name: z.string().min(1),
  action: z.string().optional().default('shell'),
  uses: z.string().optional(),
  with: z.record(z.unknown()).optional(),
  command: z.string().optional(),
  script: z.string().optional(),
  timeout: z.number().optional(),
  continueOnError: z.boolean().optional().default(false),
  condition: z.string().optional(),
  env: z.record(z.string()).optional(),
  retry: RetryConfigSchema.optional(),
});

/**
 * Phase definition schema
 */
export const PhaseDefinitionSchema = z.object({
  name: z.string().min(1),
  steps: z.array(StepDefinitionSchema).min(1),
  condition: z.string().optional(),
});

/**
 * Workflow definition schema
 */
export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  inputs: z.array(InputDefinitionSchema).optional(),
  phases: z.array(PhaseDefinitionSchema).min(1),
  env: z.record(z.string()).optional(),
  timeout: z.number().optional(),
  retry: RetryConfigSchema.optional(),
});

// Type inference from schemas
export type InputDefinitionParsed = z.infer<typeof InputDefinitionSchema>;
export type RetryConfigParsed = z.infer<typeof RetryConfigSchema>;
export type StepDefinitionParsed = z.infer<typeof StepDefinitionSchema>;
export type PhaseDefinitionParsed = z.infer<typeof PhaseDefinitionSchema>;
export type WorkflowDefinitionParsed = z.infer<typeof WorkflowDefinitionSchema>;
