/**
 * Workflow Context Types
 *
 * Mutable context passed through workflow execution.
 */

/**
 * Mutable context passed through workflow execution.
 */
export interface WorkflowContext {
  /** Initial input provided when starting workflow */
  input: Record<string, unknown>;

  /** Accumulated outputs from steps */
  outputs: Record<string, unknown>;

  /** Current working data (mutable by steps) */
  data: Record<string, unknown>;

  /** Workflow-level metadata */
  metadata: WorkflowMetadata;
}

/**
 * Workflow-level metadata
 */
export interface WorkflowMetadata {
  /** User/system that started the workflow */
  initiator?: string;

  /** Correlation ID for tracing */
  correlationId?: string;

  /** Custom metadata */
  [key: string]: unknown;
}

/**
 * Input parameters for starting a workflow
 */
export interface WorkflowInput {
  /** Initial input data */
  input?: Record<string, unknown>;

  /** Initial metadata */
  metadata?: Partial<WorkflowMetadata>;
}

/**
 * Create a new empty workflow context
 */
export function createWorkflowContext(input: WorkflowInput = {}): WorkflowContext {
  return {
    input: input.input ?? {},
    outputs: {},
    data: {},
    metadata: {
      initiator: input.metadata?.initiator,
      correlationId: input.metadata?.correlationId,
      ...input.metadata,
    },
  };
}
