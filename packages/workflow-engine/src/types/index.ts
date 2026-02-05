/**
 * Main types barrel export.
 * Re-exports all types from the workflow-engine package.
 */

// Workflow definition types
export type {
  InputDefinition,
  RetryConfig,
  StepDefinition,
  PhaseDefinition,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowPhase,
} from './workflow.js';

// Execution state types
export type {
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
} from './execution.js';

// Action system types
export type {
  ActionType,
  BuiltinActionType,
  GitHubActionType,
  WorkflowActionType,
  EpicActionType,
  ActionIdentifier,
  ActionNamespace,
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
  HumancyUrgency,
  HumancyReviewInput,
  HumancyReviewOutput,
} from './action.js';
export { parseActionType, isNamespacedAction, parseNamespacedAction } from './action.js';

// GitHub types (for github.*, workflow.*, epic.* actions)
export type {
  // Core entities
  Issue,
  PullRequest,
  Label,
  Comment,
  Milestone,
  BranchRef,
  // Workflow entities
  ReviewGate,
  CorePhase,
  WorkflowStage,
  LabelStatus,
  StageProgress,
  StageCommentData,
  // Epic entities
  EpicChild,
  EpicContext,
  EpicCompletionStatus,
  // Action I/O types
  BranchInfo,
  BranchLookupResult,
  SpeckitStatus,
  CleanedLabels,
  PreflightInput,
  PreflightOutput,
  GetContextInput,
  GetContextOutput,
  ReviewChangesInput,
  ReviewChangesOutput,
  FileChange,
  CommitAndPushInput,
  CommitAndPushOutput,
  ConflictInfo,
  MergeFromBaseInput,
  MergeFromBaseOutput,
  CreateDraftPRInput,
  CreateDraftPROutput,
  MarkPRReadyInput,
  MarkPRReadyOutput,
  UpdatePRInput,
  UpdatePROutput,
  ReadPRFeedbackInput,
  ReadPRFeedbackOutput,
  FeedbackResponse,
  RespondPRFeedbackInput,
  RespondPRFeedbackOutput,
  PostedResponse,
  AddCommentInput,
  AddCommentOutput,
  UpdatePhaseInput,
  UpdatePhaseOutput,
  CheckGateInput,
  CheckGateOutput,
  UpdateStageInput,
  UpdateStageOutput,
  PostTasksSummaryInput,
  PostTasksSummaryOutput,
  CheckCompletionInput,
  CheckCompletionOutput,
  UpdateStatusInput,
  UpdateStatusOutput,
  CreateEpicPRInput,
  CreateEpicPROutput,
  CloseEpicInput,
  CloseEpicOutput,
  DispatchChildrenInput,
  DispatchChildrenOutput,
  DispatchFailure,
  SyncLabelsInput,
  SyncLabelsOutput,
  LabelSyncResult,
  ActionError,
  ActionErrorCode,
  ParsedIssueUrl,
  RepoInfo,
} from './github.js';

// Logger types
export type { Logger } from './logger.js';
export { ConsoleLogger, NoopLogger, createLogger } from './logger.js';

// Retry types
export type { BackoffStrategy, RetryState, RetryResult } from './retry.js';

// Event types
export type {
  ExecutionEventType,
  ExecutionEvent,
  ExecutionEventListener,
} from './events.js';

// Store types
export type {
  WorkflowState,
  WorkflowStore,
  PendingReview,
  StepOutputData,
  StateValidationResult,
} from './store.js';

// Gate types
export type {
  GateType,
  GateConfig,
  GateContext,
  GateResult,
  GateHandler,
} from './gate.js';
export { DefaultGateHandler, parseGateConfig } from './gate.js';
