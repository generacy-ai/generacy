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
export { createGitHubClient, GhCliGitHubClient } from './actions/github/client/index.js';
export type { GitHubClient, GitHubClientFactory } from './actions/github/client/index.js';

// Label definitions (shared)
export { WORKFLOW_LABELS, type LabelDefinition } from './actions/github/label-definitions.js';

// Speckit operations (for direct invocation from orchestrator)
export { executeTasksToIssues } from './actions/builtin/speckit/operations/tasks-to-issues.js';

// Epic utilities (for direct invocation from orchestrator)
export { findChildIssues, type EpicChildWithPr, type FindChildIssuesOptions } from './actions/epic/find-children.js';

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

  // Event types
  ExecutionEventType,
  ExecutionEvent,
  ExecutionEventListener,
} from './types/index.js';

// Logger utilities
export { ConsoleLogger, NoopLogger, createLogger } from './types/logger.js';
export { parseActionType } from './types/action.js';
