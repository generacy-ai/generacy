/**
 * Debug module exports.
 * Provides debug adapter implementation for Generacy workflows.
 */

export {
  GeneracyDebugAdapter,
  GeneracyDebugAdapterFactory,
  GeneracyDebugConfigurationProvider,
  registerDebugAdapter,
} from './adapter';

export {
  ProtocolHandler,
  type LaunchRequestArguments,
  type DAPRequestHandler,
} from './protocol';

export {
  WorkflowDebugRuntime,
  getDebugRuntime,
  resetDebugRuntime,
  type DebugBreakpoint,
  type RuntimeMode,
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeEventListener,
} from './runtime';

export {
  DebugExecutionState,
  getDebugExecutionState,
  resetDebugExecutionState,
  type VariableScope,
  type DebugVariable,
  type DebugScope,
  type StepState,
  type PhaseState,
  type WorkflowState,
  type HistoryEntry,
} from './state';
