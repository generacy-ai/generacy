/**
 * @generacy-ai/generacy-plugin-cloud-build
 *
 * Google Cloud Build integration plugin for Generacy.
 * Provides a typed interface for triggering builds, monitoring status,
 * streaming logs, accessing artifacts, and managing triggers.
 */

// Main plugin
export { CloudBuildPlugin } from './plugin.js';
export type { CloudBuildPluginOptions, CloudBuildPluginInterface } from './plugin.js';

// Configuration
export { CloudBuildConfigSchema, RetryConfigSchema, parseConfig, safeParseConfig } from './config/schema.js';
export type { CloudBuildConfig, CloudBuildConfigInput, RetryConfig } from './config/types.js';
export {
  DEFAULT_RETRY_CONFIG,
  DEFAULT_LOG_POLLING_INTERVAL_MS,
  DEFAULT_LOCATION,
} from './config/types.js';

// Build types
export type {
  Build,
  BuildConfig,
  BuildFilter,
  BuildSource,
  BuildStatus,
  BuildStep,
  BuildStepConfig,
  BuildStepStatus,
  BuildResults,
  BuiltImage,
  PaginatedResult,
  TimeSpan,
  Volume,
  MachineType,
  StorageSource,
  RepoSource,
  GitSource,
  ArtifactsConfig,
} from './types/builds.js';

// Trigger types
export type {
  BuildTrigger,
  TriggerConfig,
  GitHubConfig,
  PullRequestFilter,
  PushFilter,
  PubsubConfig,
  WebhookConfig,
  GitRepoSource,
} from './types/triggers.js';

// Artifact types
export type { Artifact, BuildArtifacts } from './types/artifacts.js';
export { MAX_ARTIFACT_SIZE_BYTES } from './types/artifacts.js';

// Log types
export type { LogEntry, LogSeverity } from './types/logs.js';
export type { LogStreamOptions } from './streaming/types.js';

// Errors
export {
  CloudBuildError,
  AuthError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  ServiceUnavailableError,
  ValidationError,
  isCloudBuildError,
  isTransientError,
  mapStatusToErrorCode,
  wrapError,
} from './errors.js';
export type { CloudBuildErrorCode } from './errors.js';

// Validation utilities
export {
  BuildIdSchema,
  TriggerIdSchema,
  TriggerNameSchema,
  TimeoutSchema,
  PageSizeSchema,
  SubstitutionKeySchema,
  validate,
  safeValidate,
} from './utils/validation.js';

// Retry utilities
export {
  withRetry,
  calculateDelay,
  sleep,
  isRetryableStatusCode,
  shouldRetryError,
  createRetryWrapper,
} from './utils/retry.js';
export type { RetryOptions } from './utils/retry.js';

// Log streaming utilities
export { LogStream, createLogStream, collectLogs } from './streaming/log-stream.js';
