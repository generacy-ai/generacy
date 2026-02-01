# Data Model: G2 - Implement Workflow with Humancy Checkpoints

## Core Entities

### HumancyReviewInput

Input configuration for the `humancy.request_review` action step.

```typescript
interface HumancyReviewInput {
  /**
   * Content or file path to present for review.
   * Supports variable interpolation: ${steps.preview.output.summary}
   */
  artifact: string;

  /**
   * Review instructions and context for the human reviewer.
   * Describes what to check and why approval is needed.
   */
  context: string;

  /**
   * Review urgency level.
   * - 'low': No time pressure, can wait days
   * - 'normal': Default, expect response within hours
   * - 'blocking_soon': Blocking workflow, need response soon
   * - 'blocking_now': Critical, immediate attention needed
   * @default 'normal'
   */
  urgency?: 'low' | 'normal' | 'blocking_soon' | 'blocking_now';

  /**
   * Timeout in milliseconds for waiting on human response.
   * After timeout, action fails with timeout reason.
   * @default 86400000 (24 hours)
   */
  timeout?: number;
}
```

### HumancyReviewOutput

Output from the `humancy.request_review` action, stored in step outputs.

```typescript
interface HumancyReviewOutput {
  /**
   * Whether the human approved the review.
   * Used in conditional step execution: ${steps.review.approved}
   */
  approved: boolean;

  /**
   * Optional comments from the reviewer.
   * Present when rejection requires explanation.
   */
  comments?: string;

  /**
   * Identifier of the user who responded.
   * From Humancy user profile.
   */
  respondedBy?: string;

  /**
   * ISO timestamp when response was received.
   */
  respondedAt?: string;

  /**
   * Unique ID of the review request.
   * Can be used for audit/tracking.
   */
  reviewId: string;
}
```

### WorkflowState

Persisted state for workflow pause/resume.

```typescript
interface WorkflowState {
  /**
   * Schema version for forward compatibility.
   */
  version: '1.0';

  /**
   * Unique identifier for this workflow execution.
   */
  workflowId: string;

  /**
   * Path to the workflow YAML file.
   */
  workflowFile: string;

  /**
   * Current phase ID (for resume position).
   */
  currentPhase: string;

  /**
   * Current step ID (for resume position).
   */
  currentStep: string;

  /**
   * Original workflow inputs.
   */
  inputs: Record<string, unknown>;

  /**
   * Outputs from completed steps.
   * Maps step ID to StepOutput.
   */
  stepOutputs: Record<string, StepOutput>;

  /**
   * Details of pending human review, if any.
   */
  pendingReview?: PendingReview;

  /**
   * ISO timestamp when workflow started.
   */
  startedAt: string;

  /**
   * ISO timestamp of last state update.
   */
  updatedAt: string;
}

interface PendingReview {
  /**
   * Unique ID of the review request.
   */
  reviewId: string;

  /**
   * The artifact content sent for review.
   */
  artifact: string;

  /**
   * ISO timestamp when review was requested.
   */
  requestedAt: string;
}

interface StepOutput {
  /**
   * Raw string output from the step.
   */
  raw: string;

  /**
   * JSON-parsed output, if valid JSON.
   */
  parsed?: unknown;

  /**
   * Exit code (0 = success).
   */
  exitCode: number;

  /**
   * ISO timestamp when step completed.
   */
  completedAt: string;
}
```

### WorkflowStore Interface

Interface for workflow state storage implementations.

```typescript
interface WorkflowStore {
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
```

## Type Definitions

### Action Types

Extension to existing action types.

```typescript
// Extend ActionType enum
type ActionType =
  | 'workspace.prepare'
  | 'agent.invoke'
  | 'verification.check'
  | 'pr.create'
  | 'shell'
  | 'humancy.request_review';  // NEW
```

### Decision Request Types

Types for HumanHandler integration.

```typescript
interface ReviewDecisionRequest {
  type: 'review';
  title: string;
  description: string;
  options: DecisionOption[];
  workflowId: string;
  stepId: string;
  urgency: HumancyReviewInput['urgency'];
  artifact?: string;
}

interface DecisionOption {
  id: string;
  label: string;
  requiresComment?: boolean;
}

interface ReviewDecisionResponse {
  optionId: 'approve' | 'reject';
  comment?: string;
  respondedBy: string;
  respondedAt: string;
}
```

## Validation Rules

### HumancyReviewInput Validation

1. Either `artifact` or `context` must be provided (at least one)
2. `urgency` must be one of: 'low', 'normal', 'blocking_soon', 'blocking_now'
3. `timeout` must be positive integer if provided

### WorkflowState Validation

1. `version` must be '1.0'
2. `workflowId` must be non-empty string
3. `workflowFile` must be valid file path
4. `startedAt` and `updatedAt` must be valid ISO timestamps
5. `stepOutputs` values must match StepOutput schema

## Entity Relationships

```
WorkflowExecutor
    │
    ├── executes ──► WorkflowDefinition (from YAML)
    │                    │
    │                    └── contains ──► Steps
    │                                       │
    │                                       └── humancy.request_review step
    │                                              │
    │                                              └── uses ──► HumancyReviewInput
    │
    ├── stores ──► WorkflowState
    │                 │
    │                 ├── contains ──► StepOutput (per completed step)
    │                 │
    │                 └── may have ──► PendingReview
    │
    └── emits ──► HumancyReviewOutput (to stepOutputs)
```

---

*Generated by speckit*
