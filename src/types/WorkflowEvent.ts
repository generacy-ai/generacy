/**
 * Workflow Event Types
 *
 * Events emitted during workflow execution.
 */

import type { WorkflowStep } from './WorkflowDefinition.js';
import type { StepError, WorkflowError } from './WorkflowState.js';
import type { HumanStepConfig } from './WorkflowDefinition.js';

/**
 * Base event structure for all workflow events
 */
export interface WorkflowEvent {
  /** Event type identifier */
  type: WorkflowEventType;

  /** Workflow instance ID */
  workflowId: string;

  /** Workflow definition name */
  workflowName: string;

  /** ISO timestamp */
  timestamp: string;

  /** Event-specific payload */
  payload: WorkflowEventPayload;
}

/**
 * All available event types
 */
export type WorkflowEventType =
  | 'workflow:created'
  | 'workflow:started'
  | 'workflow:paused'
  | 'workflow:resumed'
  | 'workflow:completed'
  | 'workflow:failed'
  | 'workflow:cancelled'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'step:waiting'
  | 'step:timeout';

/**
 * Union type for all event payloads
 */
export type WorkflowEventPayload =
  | WorkflowCreatedPayload
  | WorkflowStartedPayload
  | WorkflowPausedPayload
  | WorkflowResumedPayload
  | WorkflowCompletedPayload
  | WorkflowFailedPayload
  | WorkflowCancelledPayload
  | StepStartedPayload
  | StepCompletedPayload
  | StepFailedPayload
  | StepWaitingPayload
  | StepTimeoutPayload;

/**
 * Payload for workflow:created event
 */
export interface WorkflowCreatedPayload {
  definitionName: string;
  definitionVersion: string;
}

/**
 * Payload for workflow:started event
 */
export interface WorkflowStartedPayload {
  firstStepId: string;
}

/**
 * Payload for workflow:paused event
 */
export interface WorkflowPausedPayload {
  currentStepId: string | null;
  reason?: string;
}

/**
 * Payload for workflow:resumed event
 */
export interface WorkflowResumedPayload {
  resumeStepId: string | null;
}

/**
 * Payload for workflow:completed event
 */
export interface WorkflowCompletedPayload {
  durationMs: number;
  stepsCompleted: number;
}

/**
 * Payload for workflow:failed event
 */
export interface WorkflowFailedPayload {
  error: WorkflowError;
  stepId?: string;
}

/**
 * Payload for workflow:cancelled event
 */
export interface WorkflowCancelledPayload {
  reason?: string;
  currentStepId: string | null;
}

/**
 * Payload for step:started event
 */
export interface StepStartedPayload {
  stepId: string;
  stepType: WorkflowStep['type'];
}

/**
 * Payload for step:completed event
 */
export interface StepCompletedPayload {
  stepId: string;
  stepType: WorkflowStep['type'];
  durationMs: number;
  output?: unknown;
}

/**
 * Payload for step:failed event
 */
export interface StepFailedPayload {
  stepId: string;
  stepType: WorkflowStep['type'];
  error: StepError;
}

/**
 * Payload for step:waiting event (human steps)
 */
export interface StepWaitingPayload {
  stepId: string;
  action: HumanStepConfig['action'];
  urgency: HumanStepConfig['urgency'];
  prompt?: string;
}

/**
 * Payload for step:timeout event
 */
export interface StepTimeoutPayload {
  stepId: string;
  stepType: WorkflowStep['type'];
  timeoutMs: number;
}

/**
 * Event handler callback type
 */
export type WorkflowEventHandler = (event: WorkflowEvent) => void;

/**
 * Create a workflow event
 */
export function createWorkflowEvent<T extends WorkflowEventPayload>(
  type: WorkflowEventType,
  workflowId: string,
  workflowName: string,
  payload: T
): WorkflowEvent {
  return {
    type,
    workflowId,
    workflowName,
    timestamp: new Date().toISOString(),
    payload,
  };
}
