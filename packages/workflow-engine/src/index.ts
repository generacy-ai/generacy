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
  prepareWorkflow,
  validateWorkflow,
  isValidWorkflow,
  WorkflowValidationError,
  WorkflowDefinitionSchema,
  PhaseDefinitionSchema,
  StepDefinitionSchema,
  InputDefinitionSchema,
  RetryConfigSchema,
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
