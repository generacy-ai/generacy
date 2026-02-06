/**
 * Configuration types for the Cloud Build plugin.
 */

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface CloudBuildConfig {
  projectId: string;
  location: string;
  serviceAccountKey?: string;
  defaultTrigger?: string;
  artifactBucket?: string;
  retry: RetryConfig;
  logPollingIntervalMs: number;
}

export interface CloudBuildConfigInput {
  projectId: string;
  location?: string;
  serviceAccountKey?: string;
  defaultTrigger?: string;
  artifactBucket?: string;
  retry?: Partial<RetryConfig>;
  logPollingIntervalMs?: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

export const DEFAULT_LOG_POLLING_INTERVAL_MS = 2000;
export const DEFAULT_LOCATION = 'global';
