/**
 * Zod validation schemas for Cloud Build plugin configuration.
 */

import { z } from 'zod';
import {
  DEFAULT_RETRY_CONFIG,
  DEFAULT_LOG_POLLING_INTERVAL_MS,
  DEFAULT_LOCATION,
} from './types.js';

export const RetryConfigSchema = z.object({
  maxAttempts: z.number().int().min(0).max(10).default(DEFAULT_RETRY_CONFIG.maxAttempts),
  initialDelayMs: z.number().int().min(100).default(DEFAULT_RETRY_CONFIG.initialDelayMs),
  maxDelayMs: z.number().int().min(1000).default(DEFAULT_RETRY_CONFIG.maxDelayMs),
});

export const CloudBuildConfigSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  location: z.string().default(DEFAULT_LOCATION),
  serviceAccountKey: z.string().optional(),
  defaultTrigger: z.string().optional(),
  artifactBucket: z.string().optional(),
  retry: RetryConfigSchema.optional().default(DEFAULT_RETRY_CONFIG),
  logPollingIntervalMs: z.number().int().min(500).default(DEFAULT_LOG_POLLING_INTERVAL_MS),
});

export type CloudBuildConfigInput = z.input<typeof CloudBuildConfigSchema>;
export type CloudBuildConfigOutput = z.output<typeof CloudBuildConfigSchema>;

/**
 * Parse and validate Cloud Build configuration.
 */
export function parseConfig(input: CloudBuildConfigInput): CloudBuildConfigOutput {
  return CloudBuildConfigSchema.parse(input);
}

/**
 * Safely parse configuration, returning validation errors if invalid.
 */
export function safeParseConfig(input: unknown): z.SafeParseReturnType<CloudBuildConfigInput, CloudBuildConfigOutput> {
  return CloudBuildConfigSchema.safeParse(input);
}
