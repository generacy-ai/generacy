import type { WorkflowConclusion } from './workflows.js';
import type { CheckConclusion } from './check-runs.js';

/**
 * Event emitted when a workflow run completes successfully
 */
export interface WorkflowCompletedEvent {
  type: 'workflow.completed';
  /** Workflow run ID */
  runId: number;
  /** Workflow filename */
  workflow: string;
  /** Run conclusion */
  conclusion: WorkflowConclusion;
  /** Duration in milliseconds */
  duration: number;
  /** Workflow run URL */
  url: string;
}

/**
 * Event emitted when a workflow run fails
 */
export interface WorkflowFailedEvent {
  type: 'workflow.failed';
  /** Workflow run ID */
  runId: number;
  /** Workflow filename */
  workflow: string;
  /** Error message or description */
  error: string;
  /** Names of failed jobs */
  failedJobs: string[];
  /** Workflow run URL */
  url: string;
}

/**
 * Event emitted when a check run completes
 */
export interface CheckRunCompletedEvent {
  type: 'check_run.completed';
  /** Check run ID */
  checkRunId: number;
  /** Check name */
  name: string;
  /** Check conclusion */
  conclusion: CheckConclusion;
  /** HEAD SHA the check was run against */
  headSha: string;
}

/**
 * Union of all plugin events
 */
export type PluginEvent =
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | CheckRunCompletedEvent;

/**
 * Event type discriminator
 */
export type PluginEventType = PluginEvent['type'];

/**
 * Type guard for workflow completed event
 */
export function isWorkflowCompletedEvent(
  event: PluginEvent
): event is WorkflowCompletedEvent {
  return event.type === 'workflow.completed';
}

/**
 * Type guard for workflow failed event
 */
export function isWorkflowFailedEvent(
  event: PluginEvent
): event is WorkflowFailedEvent {
  return event.type === 'workflow.failed';
}

/**
 * Type guard for check run completed event
 */
export function isCheckRunCompletedEvent(
  event: PluginEvent
): event is CheckRunCompletedEvent {
  return event.type === 'check_run.completed';
}
