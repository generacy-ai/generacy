/**
 * Workflow debugger module exports.
 * Provides breakpoint management, debug session, and DAP adapter.
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
