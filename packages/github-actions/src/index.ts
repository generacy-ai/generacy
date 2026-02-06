// Main plugin
export {
  GitHubActionsPlugin,
  createGitHubActionsPlugin,
  PLUGIN_MANIFEST,
  type IssueTracker,
} from './plugin.js';

// Configuration types
export {
  type GitHubActionsConfig,
  type PollingOptions,
  type WorkflowsConfig,
  gitHubActionsConfigSchema,
  pollingOptionsSchema,
  workflowsConfigSchema,
  parseConfig,
  DEFAULT_POLLING_CONFIG,
} from './types/config.js';

// Workflow types
export {
  type User,
  type WorkflowStatus,
  type WorkflowConclusion,
  type WorkflowRun,
  type TriggerWorkflowParams,
  isTerminalStatus,
  isSuccessful,
  isFailed,
} from './types/workflows.js';

// Job types
export {
  type JobStatus,
  type JobConclusion,
  type StepStatus,
  type StepConclusion,
  type Step,
  type Job,
  isJobComplete,
  isJobSuccessful,
  getFailedSteps,
} from './types/jobs.js';

// Artifact types
export {
  type Artifact,
  type ArtifactListResponse,
  isArtifactAvailable,
  formatArtifactSize,
} from './types/artifacts.js';

// Check run types
export {
  type CheckStatus,
  type CheckConclusion,
  type AnnotationLevel,
  type CheckAnnotation,
  type CheckOutput,
  type CheckRun,
  type CreateCheckRunParams,
  type UpdateCheckRunParams,
  isCheckComplete,
  isCheckSuccessful,
} from './types/check-runs.js';

// Event types
export {
  type WorkflowCompletedEvent,
  type WorkflowFailedEvent,
  type CheckRunCompletedEvent,
  type PluginEvent,
  type PluginEventType,
  isWorkflowCompletedEvent,
  isWorkflowFailedEvent,
  isCheckRunCompletedEvent,
} from './types/events.js';

// EventBus interface
export {
  type EventBus,
  type EventHandler,
  type SubscriptionOptions,
  type Unsubscribe,
  SimpleEventBus,
} from './events/types.js';

// Polling types
export {
  type PollingConfig,
  type PollingResult,
  type PollingHandle,
  createPollingConfig,
} from './polling/types.js';

// Error types
export {
  GitHubActionsError,
  RateLimitError,
  WorkflowNotFoundError,
  RunNotFoundError,
  JobNotFoundError,
  ArtifactNotFoundError,
  CheckRunNotFoundError,
  PollingTimeoutError,
  ConfigurationError,
  isRateLimitError,
  isGitHubActionsError,
} from './utils/errors.js';

// Client (for advanced usage)
export { GitHubClient, createClient } from './client.js';

// Status poller (for advanced usage)
export {
  StatusPoller,
  createStatusPoller,
  pollUntilComplete,
  waitForRun,
} from './polling/status-poller.js';

// Event emitter (for advanced usage)
export {
  WorkflowEventEmitter,
  createEventEmitter,
} from './events/emitter.js';
