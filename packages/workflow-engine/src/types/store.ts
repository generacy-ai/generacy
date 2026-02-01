/**
 * Store types for workflow state persistence.
 * Defines interfaces for workflow state storage and retrieval.
 */

/**
 * Step output stored during workflow execution
 */
export interface StepOutputData {
  /** Raw string output */
  raw: string;
  /** Parsed JSON output (null if not valid JSON) */
  parsed: unknown | null;
  /** Exit code from execution */
  exitCode: number;
  /** ISO timestamp when step completed */
  completedAt: string;
}

/**
 * Pending review details when workflow is paused
 */
export interface PendingReview {
  /** Unique ID of the review request */
  reviewId: string;
  /** The artifact content sent for review */
  artifact: string;
  /** ISO timestamp when review was requested */
  requestedAt: string;
}

/**
 * Persisted state for workflow pause/resume
 */
export interface WorkflowState {
  /** Schema version for forward compatibility */
  version: '1.0';
  /** Unique identifier for this workflow execution */
  workflowId: string;
  /** Path to the workflow YAML file */
  workflowFile: string;
  /** Current phase ID (for resume position) */
  currentPhase: string;
  /** Current step ID (for resume position) */
  currentStep: string;
  /** Original workflow inputs */
  inputs: Record<string, unknown>;
  /** Outputs from completed steps */
  stepOutputs: Record<string, StepOutputData>;
  /** Details of pending human review, if any */
  pendingReview?: PendingReview;
  /** ISO timestamp when workflow started */
  startedAt: string;
  /** ISO timestamp of last state update */
  updatedAt: string;
}

/**
 * Interface for workflow state storage implementations
 */
export interface WorkflowStore {
  /**
   * Save workflow state.
   * Creates or updates the state file.
   */
  save(state: WorkflowState): Promise<void>;

  /**
   * Load workflow state by ID.
   * Returns null if not found.
   */
  load(workflowId: string): Promise<WorkflowState | null>;

  /**
   * Delete workflow state.
   * Called after successful completion.
   */
  delete(workflowId: string): Promise<void>;

  /**
   * List all pending workflow states.
   * Used for resume discovery.
   */
  listPending(): Promise<WorkflowState[]>;
}

/**
 * Validation result for workflow state
 */
export interface StateValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Validation errors (if any) */
  errors: string[];
}
