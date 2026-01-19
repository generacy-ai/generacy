/**
 * Workflow State Types
 *
 * Runtime state of a workflow instance.
 */

import type { WorkflowDefinition } from './WorkflowDefinition.js';
import type { WorkflowContext } from './WorkflowContext.js';

/**
 * Runtime state of a workflow instance.
 */
export interface WorkflowState {
  /** Unique workflow instance identifier */
  id: string;

  /** Name of the workflow definition */
  definitionName: string;

  /** Version of the workflow definition */
  definitionVersion: string;

  /** Full workflow definition (for recovery) */
  definition: WorkflowDefinition;

  /** Current workflow status */
  status: WorkflowStatus;

  /** Current step being executed (null if completed/failed) */
  currentStepId: string | null;

  /** Execution context passed between steps */
  context: WorkflowContext;

  /** Results from completed steps */
  stepResults: Record<string, StepResult>;

  /** Retry attempt counts per step */
  stepAttempts: Record<string, number>;

  /** ISO timestamp when workflow was created */
  createdAt: string;

  /** ISO timestamp when workflow was last updated */
  updatedAt: string;

  /** ISO timestamp when workflow started (running) */
  startedAt?: string;

  /** ISO timestamp when workflow completed/failed/cancelled */
  completedAt?: string;

  /** Error information if workflow failed */
  error?: WorkflowError;
}

/**
 * Workflow execution status
 */
export type WorkflowStatus =
  | 'created'    // Initial state
  | 'running'    // Actively executing
  | 'paused'     // Temporarily suspended
  | 'waiting'    // Waiting for human input
  | 'completed'  // Successfully finished
  | 'failed'     // Failed with error
  | 'cancelled'; // Manually cancelled

/**
 * Result of executing a single step.
 */
export interface StepResult {
  /** Step ID this result belongs to */
  stepId: string;

  /** Whether step completed successfully */
  success: boolean;

  /** Output data from the step */
  output?: unknown;

  /** Error if step failed */
  error?: StepError;

  /** ISO timestamp when step started */
  startedAt: string;

  /** ISO timestamp when step completed */
  completedAt: string;

  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Error information for a failed step
 */
export interface StepError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** Stack trace if available */
  stack?: string;

  /** Additional error context */
  details?: Record<string, unknown>;
}

/**
 * Error information for a failed workflow
 */
export interface WorkflowError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** Step ID where error occurred */
  stepId?: string;

  /** Original error stack */
  stack?: string;
}

/**
 * Filter criteria for querying workflows
 */
export interface WorkflowFilter {
  /** Filter by status */
  status?: WorkflowStatus | WorkflowStatus[];

  /** Filter by definition name */
  definitionName?: string;

  /** Filter by definition version */
  definitionVersion?: string;

  /** Filter by created date range */
  createdAfter?: string;
  createdBefore?: string;

  /** Pagination */
  limit?: number;
  offset?: number;
}
