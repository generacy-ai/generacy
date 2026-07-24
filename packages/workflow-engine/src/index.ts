/**
 * @generacy-ai/workflow-engine
 *
 * Workflow execution engine for Generacy.
 * Provides workflow loading, validation, and execution with action handlers.
 */

// Main executor
export {
  WorkflowExecutor,
  resetActionsRegistration,
  ExecutionEventEmitter,
  createExecutionEvent,
  type ExecutorOptions,
} from './executor/index.js';

// Workflow loading
export {
  loadWorkflow,
  loadWorkflowFromString,
  loadWorkflowWithExtends,
  prepareWorkflow,
  validateWorkflow,
  isValidWorkflow,
  WorkflowValidationError,
  WorkflowDefinitionSchema,
  PhaseDefinitionSchema,
  StepDefinitionSchema,
  InputDefinitionSchema,
  RetryConfigSchema,
  type WorkflowResolver,
} from './loader/index.js';

// Action system
export {
  registerActionHandler,
  unregisterActionHandler,
  getActionHandler,
  getActionHandlerByType,
  hasActionHandler,
  getRegisteredActionTypes,
  clearActionRegistry,
  getActionType,
  registerBuiltinActions,
  BaseAction,
  WorkspacePrepareAction,
  AgentInvokeAction,
  VerificationCheckAction,
  PrCreateAction,
  ShellAction,
  HumancyReviewAction,
  HumancyApiDecisionHandler,
  type HumancyApiHandlerConfig,
  CorrelationTimeoutError,
  type HumanDecisionHandler,
  checkCLI,
  checkAllCLIs,
  executeCommand,
  executeShellCommand,
  parseJSONSafe,
  extractJSON,
  type CommandOptions,
  type CommandResult,
  type CLIStatus,
  registerProcessLauncher,
  getProcessLauncher,
  clearProcessLauncher,
  type LaunchFunction,
  type LaunchFunctionRequest,
  type LaunchFunctionHandle,
} from './actions/index.js';

// Workflow registry
export {
  registerWorkflow,
  registerWorkflows,
  resolveRegisteredWorkflow,
  hasRegisteredWorkflow,
  getRegisteredWorkflowNames,
  clearWorkflowRegistry,
} from './registry/index.js';

// Inheritance errors
export { BaseWorkflowNotFoundError } from './errors/base-workflow-not-found.js';
export { CircularExtendsError } from './errors/circular-extends.js';
export { WorkflowOverrideError } from './errors/workflow-override.js';

// GitHub client
export { createGitHubClient, GhCliGitHubClient, GhAuthError, parseGhStatusCode } from './actions/github/client/index.js';
export type { GitHubClient, GitHubClientFactory } from './actions/github/client/index.js';

// Label definitions (shared)
export { WORKFLOW_LABELS, type LabelDefinition } from './actions/github/label-definitions.js';

// Label-provisioning error classification (shared across LabelManager + LabelSyncService)
export {
  classifyLabelProvisioningError,
  type ProvisioningErrorClassification,
} from './actions/github/classify-label-provisioning-error.js';

// Speckit operations (for direct invocation from orchestrator)
export { executeTasksToIssues } from './actions/builtin/speckit/operations/tasks-to-issues.js';
export { createFeature } from './actions/builtin/speckit/lib/feature.js';
export type {
  CreateFeatureInput,
  CreateFeatureOutput,
  ResolveExistingBranchCallback,
} from './actions/builtin/speckit/types.js';
export {
  resolveIssueBranch,
  type ResolvedIssueBranch,
  type ResolveIssueBranchInput,
} from './actions/builtin/speckit/lib/issue-branch-resolver.js';

// Re-exported so orchestrator callers of resolveIssueBranch don't need to
// declare `simple-git` as a direct dependency.
export { simpleGit, type SimpleGit } from 'simple-git';

// Epic utilities (for direct invocation from orchestrator)
export { findChildIssues, type EpicChildWithPr, type FindChildIssuesOptions } from './actions/epic/find-children.js';

// Handlers (phase lifecycle hooks)
export {
  siblingFanoutHandler,
  type SiblingFanoutContext,
  type SiblingFanoutResult,
  type SiblingOutcome,
} from './handlers/index.js';

// Interpolation
export {
  ExecutionContext,
  interpolate,
  interpolateValue,
  parseVariableReference,
  resolveVariableReference,
  resolvePathSafe,
  extractVariableReferences,
  hasVariables,
  type InterpolationContext,
  type VariableReference,
  type InterpolateOptions,
} from './interpolation/index.js';

// Retry system
export {
  RetryManager,
  withTimeout,
  parseRetryConfig,
  calculateBackoffDelay,
  constantDelay,
  linearDelay,
  exponentialDelay,
  addJitter,
  parseDuration,
  formatDuration,
} from './retry/index.js';

// All types
export type {
  // Workflow definition types
  InputDefinition,
  RetryConfig,
  StepDefinition,
  PhaseDefinition,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowPhase,

  // Execution state types
  ExecutionStatus,
  StepStatus,
  ExecutionMode,
  ExecutableWorkflow,
  StepResult,
  PhaseResult,
  ExecutionResult,
  ExecutionOptions,
  SingleStepRequest,
  SingleStepResult,

  // Action system types
  ActionType,
  StepOutput,
  ActionContext,
  ActionResult,
  ValidationError,
  ValidationWarning,
  ValidationResult,
  ActionHandler,
  WorkspacePrepareInput,
  WorkspacePrepareOutput,
  AgentInvokeInput,
  AgentInvokeOutput,
  VerificationCheckInput,
  VerificationCheckOutput,
  PrCreateInput,
  PrCreateOutput,

  // Epic/speckit types
  TasksToIssuesInput,
  TasksToIssuesOutput,
  CreatedIssue,
  SkippedIssue,
  FailedTask,

  // Logger types
  Logger,

  // Retry types
  BackoffStrategy,
  RetryState,
  RetryResult,

  // Store types
  LinkedPR,
  WorkflowState,
  WorkflowStore,

  // Event types
  ExecutionEventType,
  ExecutionEvent,
  ExecutionEventListener,
} from './types/index.js';

// Store implementations
export { FilesystemWorkflowStore } from './store/index.js';

// Logger utilities
export { ConsoleLogger, NoopLogger, createLogger } from './types/logger.js';
export { parseActionType } from './types/action.js';

// Comment-author trust helper (author_association gating for ingestion surfaces)
export {
  isTrustedCommentAuthor,
  normalizeLogin,
  DEFAULT_TRUSTED_TIERS,
  KNOWN_UNTRUSTED_TIERS,
  type TrustSurface,
  type TrustReason,
  type TrustDecision,
  type CommentTrustContext,
} from './security/comment-trust.js';
export {
  CommentTrustConfigSchema,
  tryLoadCommentTrustConfig,
  COMMENT_TRUST_CONFIG_RELATIVE_PATH,
  type CommentTrustConfig,
} from './security/comment-trust-config.js';
export { wrapUntrustedData } from './security/untrusted-data-fence.js';

// #958 — shared placeholder literal for clarification answers. Single source
// of truth imported by prompt template, orchestrator parser, and cockpit
// answer-relay so the prompt-vs-parser drift bug (spec FR-012) is
// structurally impossible.
export {
  PENDING_ANSWER_LITERAL,
  isPendingAnswerValue,
} from './actions/builtin/speckit/pending-literal.js';

// Comment types (re-exported so consumers filtering via isTrustedCommentAuthor
// don't need to import from the deep types barrel)
export type { Comment, ReviewThread, SkippedCommentInfo } from './types/github.js';
