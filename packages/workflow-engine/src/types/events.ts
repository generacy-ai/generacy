/**
 * Execution event types.
 * Defines events emitted during workflow execution.
 */

/**
 * Execution event types
 */
export type ExecutionEventType =
  | 'execution:start'
  | 'execution:complete'
  | 'execution:error'
  | 'execution:cancel'
  | 'phase:start'
  | 'phase:complete'
  | 'phase:error'
  | 'step:start'
  | 'step:complete'
  | 'step:error'
  | 'step:output'
  | 'action:start'
  | 'action:complete'
  | 'action:error'
  | 'action:retry';

/**
 * Execution event data
 */
export interface ExecutionEvent {
  type: ExecutionEventType;
  timestamp: number;
  workflowName: string;
  phaseName?: string;
  stepName?: string;
  message?: string;
  data?: unknown;
}

/**
 * Execution event listener
 */
export type ExecutionEventListener = (event: ExecutionEvent) => void;
