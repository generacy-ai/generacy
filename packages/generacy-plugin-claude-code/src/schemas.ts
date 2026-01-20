/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Zod validation schemas for runtime validation of configurations.
 */

import { z } from 'zod';

/**
 * Schema for volume mounts.
 */
export const MountSchema = z.object({
  /** Host path or volume name */
  source: z.string().min(1, 'Mount source is required'),
  /** Container path (must be absolute) */
  target: z.string().startsWith('/', 'Mount target must be an absolute path'),
  /** Mount as read-only */
  readonly: z.boolean().optional(),
});

/**
 * Schema for resource limits.
 */
export const ResourceLimitsSchema = z.object({
  /** Memory limit in bytes */
  memory: z.number().positive('Memory must be positive').optional(),
  /** CPU quota (e.g., 1.5 for 1.5 CPUs) */
  cpus: z.number().positive('CPUs must be positive').optional(),
});

/**
 * Schema for container configuration.
 */
export const ContainerConfigSchema = z.object({
  /** Docker image to use */
  image: z.string().min(1, 'Image is required'),
  /** Working directory inside container (must be absolute) */
  workdir: z.string().startsWith('/', 'Working directory must be an absolute path'),
  /** Environment variables */
  env: z.record(z.string()).default({}),
  /** Volume mounts */
  mounts: z.array(MountSchema).default([]),
  /** Docker network name */
  network: z.string().min(1, 'Network name is required'),
  /** Optional resource limits */
  resources: ResourceLimitsSchema.optional(),
});

/**
 * Schema for invocation options.
 */
export const InvokeOptionsSchema = z.object({
  /** Agency mode to set before invocation */
  mode: z.string().optional(),
  /** Maximum execution time in milliseconds (max 1 hour) */
  timeout: z
    .number()
    .int('Timeout must be an integer')
    .positive('Timeout must be positive')
    .max(3600000, 'Timeout cannot exceed 1 hour (3600000ms)')
    .optional(),
  /** Tool whitelist (empty = all allowed) */
  tools: z.array(z.string()).optional(),
  /** Serialized context for workflow continuity */
  context: z.string().optional(),
  /** Associated GitHub issue number */
  issueNumber: z.number().int().positive().optional(),
});

/**
 * Schema for invocation parameters.
 */
export const InvokeParamsSchema = z.object({
  /** The prompt to send to the agent */
  prompt: z.string().min(1, 'Prompt is required'),
  /** Optional session ID for session-based invocation */
  sessionId: z.string().optional(),
  /** Optional overrides for invoke options */
  options: InvokeOptionsSchema.partial().optional(),
});

// Export inferred types for convenience
export type MountInput = z.input<typeof MountSchema>;
export type MountOutput = z.output<typeof MountSchema>;

export type ResourceLimitsInput = z.input<typeof ResourceLimitsSchema>;
export type ResourceLimitsOutput = z.output<typeof ResourceLimitsSchema>;

export type ContainerConfigInput = z.input<typeof ContainerConfigSchema>;
export type ContainerConfigOutput = z.output<typeof ContainerConfigSchema>;

export type InvokeOptionsInput = z.input<typeof InvokeOptionsSchema>;
export type InvokeOptionsOutput = z.output<typeof InvokeOptionsSchema>;

export type InvokeParamsInput = z.input<typeof InvokeParamsSchema>;
export type InvokeParamsOutput = z.output<typeof InvokeParamsSchema>;
