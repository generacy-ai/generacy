/**
 * Workflow action types returned by webhook handler
 */

/**
 * Action to queue an issue for processing
 */
export interface QueueForProcessingAction {
  type: 'queue_for_processing';
  issueNumber: number;
  priority?: 'high' | 'normal' | 'low';
}

/**
 * Action to start a workflow on an issue
 */
export interface StartWorkflowAction {
  type: 'start_workflow';
  issueNumber: number;
  workflowType?: string;
}

/**
 * Action to resume a paused workflow
 */
export interface ResumeWorkflowAction {
  type: 'resume_workflow';
  issueNumber: number;
  triggeredBy: 'comment' | 'label';
}

/**
 * No action needed for this event
 */
export interface NoAction {
  type: 'no_action';
  reason: string;
}

/**
 * Union of all possible workflow actions
 */
export type WorkflowAction =
  | QueueForProcessingAction
  | StartWorkflowAction
  | ResumeWorkflowAction
  | NoAction;

/**
 * Result of a successful API operation
 */
export interface OperationResult<T> {
  success: true;
  data: T;
}

/**
 * Result of a failed API operation
 */
export interface OperationError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Generic operation result type
 */
export type OperationResponse<T> = OperationResult<T> | OperationError;
