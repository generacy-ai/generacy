/**
 * Workflow debugger module exports.
 * Provides breakpoint management, debug session, DAP adapter, and state inspection.
 */

// Breakpoint management
export {
  BreakpointManager,
  getBreakpointManager,
  type BreakpointLocationType,
  type BreakpointLocation,
  type WorkflowBreakpoint,
  type BreakpointEventType,
  type BreakpointEvent,
  type BreakpointEventListener,
} from './breakpoints';

// Debug session
export {
  DebugSession,
  getDebugSession,
  type DebugSessionState,
  type StepType,
  type ExecutionPosition,
  type DebugContext,
  type StopReason,
  type DebugSessionEventType,
  type DebugSessionEvent,
  type DebugSessionEventListener,
  type DebugSessionConfig,
} from './session';

// Debug adapter
export {
  WorkflowDebugAdapterFactory,
  WorkflowDebugConfigurationProvider,
  WorkflowDebugAdapter,
  registerDebugAdapter,
  type LaunchRequestArguments,
} from './adapter';

// Variables view
export {
  VariablesViewProvider,
  VariableTreeItem,
  ScopeTreeItem,
  registerVariablesView,
  type VariableCategory,
} from './variables-view';

// Watch expressions
export {
  WatchExpressionsManager,
  WatchExpressionsViewProvider,
  WatchExpressionTreeItem,
  getWatchExpressionsManager,
  registerWatchExpressions,
  type WatchExpression,
} from './watch-expressions';

// Replay controller
export {
  ReplayController,
  getReplayController,
  registerReplayCommands,
  type ReplayOptions,
  type ReplayState,
  type ReplayPoint,
} from './replay-controller';

// Execution history panel
export {
  ExecutionHistoryProvider,
  HistoryTreeItem,
  registerHistoryPanel,
  getExecutionStatistics,
  type DisplayHistoryEntry,
  type HistoryItemType,
} from './history-panel';

// Error analysis
export {
  ErrorAnalysisManager,
  ErrorAnalysisProvider,
  ErrorTreeItem,
  getErrorAnalysisManager,
  registerErrorAnalysis,
  type AnalyzedError,
  type StackTraceFrame,
  type ErrorSeverity,
  type ErrorCategory,
} from './error-analysis';
