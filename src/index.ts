/**
 * Generacy - Workflow Engine
 *
 * Core workflow engine for orchestrating SDLC workflows.
 */

// Engine
export { WorkflowEngine, type WorkflowEngineOptions } from './engine/index.js';
export {
  WorkflowRuntime,
  type WorkflowRuntimeOptions,
  type StepExecutor,
  type StepExecutionResult,
} from './engine/index.js';

// Types
export type {
  WorkflowDefinition,
  WorkflowStep,
  StepType,
  StepConfig,
  AgentStepConfig,
  HumanStepConfig,
  IntegrationStepConfig,
  ConditionConfig,
  ParallelConfig,
  ConditionalNext,
} from './types/index.js';

export {
  isAgentStepConfig,
  isHumanStepConfig,
  isIntegrationStepConfig,
  isConditionConfig,
  isParallelConfig,
} from './types/index.js';

export type {
  WorkflowState,
  WorkflowStatus,
  StepResult,
  StepError,
  WorkflowError,
  WorkflowFilter,
} from './types/index.js';

export type {
  WorkflowContext,
  WorkflowMetadata,
  WorkflowInput,
} from './types/index.js';

export { createWorkflowContext } from './types/index.js';

export type {
  WorkflowEvent,
  WorkflowEventType,
  WorkflowEventPayload,
  WorkflowEventHandler,
} from './types/index.js';

export { createWorkflowEvent } from './types/index.js';

export type {
  ErrorHandler,
  ErrorHandlerFunction,
  ErrorAction,
  RetryAction,
  AbortAction,
  EscalateAction,
  FallbackAction,
  SkipAction,
} from './types/index.js';

export {
  isRetryAction,
  isAbortAction,
  isEscalateAction,
  isFallbackAction,
  isSkipAction,
  defaultErrorHandler,
  createRetryErrorHandler,
} from './types/index.js';

export type { StorageAdapter } from './types/index.js';

// Storage
export { InMemoryStorageAdapter } from './storage/index.js';
export { SQLiteStorageAdapter, type SQLiteStorageOptions } from './storage/index.js';

// Events
export { WorkflowEventEmitter } from './events/index.js';

// Execution
export {
  StepExecutorRegistry,
  BaseStepExecutor,
  createDefaultRegistry,
} from './execution/index.js';

export {
  AgentStepExecutor,
  createAgentStepExecutor,
  type CommandExecutor,
  type CommandResult,
} from './execution/index.js';

export {
  HumanStepExecutor,
  createHumanStepExecutor,
  validateHumanInput,
  type HumanStepNotifier,
} from './execution/index.js';

export {
  ConditionEvaluator,
  createConditionEvaluator,
  evaluateCondition,
  evaluateAllConditions,
  evaluateAnyCondition,
} from './execution/index.js';

export {
  ParallelExecutor,
  createParallelExecutor,
  type BranchExecutor,
  type BranchResult,
} from './execution/index.js';

// Utilities
export {
  generateWorkflowId,
  generatePrefixedId,
  isValidUuid,
  isValidPrefixedId,
} from './utils/index.js';

export {
  parseExpression,
  parseValue,
  getValueAtPath,
  compare,
  evaluateExpression,
  evaluateAll,
  evaluateAny,
  type ComparisonOperator,
  type ParsedExpression,
  type EvaluationResult,
} from './utils/index.js';
