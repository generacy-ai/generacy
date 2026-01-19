# Data Model: Workflow Engine

## Core Entities

### WorkflowDefinition

The blueprint for a workflow, defining its steps and behavior.

```typescript
interface WorkflowDefinition {
  /** Unique name identifying this workflow type */
  name: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Ordered list of steps to execute */
  steps: WorkflowStep[];

  /** Optional error handling configuration */
  onError?: ErrorHandler;

  /** Maximum duration in milliseconds before timeout */
  timeout?: number;

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}
```

### WorkflowStep

A single step within a workflow definition.

```typescript
interface WorkflowStep {
  /** Unique identifier within the workflow */
  id: string;

  /** Step type determining execution behavior */
  type: 'agent' | 'human' | 'integration' | 'condition' | 'parallel';

  /** Type-specific configuration */
  config: StepConfig;

  /** Next step(s) to execute after completion */
  next?: string | ConditionalNext[];

  /** Step-level timeout in milliseconds */
  timeout?: number;

  /** Number of retry attempts on failure */
  retries?: number;
}
```

### Step Types

```typescript
// Agent step: invoke an AI agent command
interface AgentStepConfig {
  /** Command to execute (e.g., "/speckit:specify") */
  command: string;

  /** Agent mode affecting behavior */
  mode: 'research' | 'coding' | 'review';

  /** Optional arguments to pass */
  args?: Record<string, unknown>;
}

// Human step: pause for human input
interface HumanStepConfig {
  /** Type of human action required */
  action: 'review' | 'approve' | 'input' | 'decide';

  /** How urgent is the human response */
  urgency: 'blocking_now' | 'blocking_soon' | 'when_available';

  /** Optional prompt/instructions for the human */
  prompt?: string;

  /** For 'decide' action: available options */
  options?: string[];
}

// Integration step: call external service
interface IntegrationStepConfig {
  /** Integration identifier */
  service: string;

  /** Operation to perform */
  operation: string;

  /** Operation parameters */
  params?: Record<string, unknown>;
}

// Condition step: branch based on context
interface ConditionConfig {
  /** Property path expression (e.g., "context.status == approved") */
  expression: string;

  /** Step ID if condition is true */
  then: string;

  /** Step ID if condition is false */
  else: string;
}

// Parallel step: execute branches concurrently
interface ParallelConfig {
  /** Array of step sequences to execute in parallel */
  branches: WorkflowStep[][];

  /** Join strategy: wait for all or first completion */
  join: 'all' | 'any';
}

type StepConfig =
  | AgentStepConfig
  | HumanStepConfig
  | IntegrationStepConfig
  | ConditionConfig
  | ParallelConfig;
```

### WorkflowState

Runtime state of a workflow instance.

```typescript
interface WorkflowState {
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

type WorkflowStatus =
  | 'created'    // Initial state
  | 'running'    // Actively executing
  | 'paused'     // Temporarily suspended
  | 'waiting'    // Waiting for human input
  | 'completed'  // Successfully finished
  | 'failed'     // Failed with error
  | 'cancelled'; // Manually cancelled
```

### WorkflowContext

Mutable context passed through workflow execution.

```typescript
interface WorkflowContext {
  /** Initial input provided when starting workflow */
  input: Record<string, unknown>;

  /** Accumulated outputs from steps */
  outputs: Record<string, unknown>;

  /** Current working data (mutable by steps) */
  data: Record<string, unknown>;

  /** Workflow-level metadata */
  metadata: {
    /** User/system that started the workflow */
    initiator?: string;

    /** Correlation ID for tracing */
    correlationId?: string;

    /** Custom metadata */
    [key: string]: unknown;
  };
}
```

### StepResult

Result of executing a single step.

```typescript
interface StepResult {
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

interface StepError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** Stack trace if available */
  stack?: string;

  /** Additional error context */
  details?: Record<string, unknown>;
}
```

### Error Handling

```typescript
interface ErrorHandler {
  /** Called when a step fails */
  onError: (
    error: Error,
    step: WorkflowStep,
    context: WorkflowContext
  ) => ErrorAction;
}

type ErrorAction =
  | { type: 'retry'; delay?: number; maxAttempts?: number }
  | { type: 'abort'; reason: string }
  | { type: 'escalate'; urgency: 'blocking_now' | 'blocking_soon' | 'when_available' }
  | { type: 'fallback'; stepId: string }
  | { type: 'skip' };

interface WorkflowError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** Step ID where error occurred */
  stepId?: string;

  /** Original error stack */
  stack?: string;
}
```

### Conditional Navigation

```typescript
interface ConditionalNext {
  /** Property path expression to evaluate */
  condition: string;

  /** Step ID if condition is true */
  stepId: string;
}

// Example usage:
// next: [
//   { condition: "context.approved == true", stepId: "deploy" },
//   { condition: "context.approved == false", stepId: "revise" }
// ]
```

## Event Types

```typescript
interface WorkflowEvent {
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

type WorkflowEventType =
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

type WorkflowEventPayload =
  | WorkflowCreatedPayload
  | WorkflowCompletedPayload
  | WorkflowFailedPayload
  | StepStartedPayload
  | StepCompletedPayload
  | StepFailedPayload
  | StepWaitingPayload;

interface WorkflowCreatedPayload {
  definitionName: string;
  definitionVersion: string;
}

interface WorkflowCompletedPayload {
  durationMs: number;
  stepsCompleted: number;
}

interface WorkflowFailedPayload {
  error: WorkflowError;
  stepId?: string;
}

interface StepStartedPayload {
  stepId: string;
  stepType: WorkflowStep['type'];
}

interface StepCompletedPayload {
  stepId: string;
  stepType: WorkflowStep['type'];
  durationMs: number;
  output?: unknown;
}

interface StepFailedPayload {
  stepId: string;
  stepType: WorkflowStep['type'];
  error: StepError;
}

interface StepWaitingPayload {
  stepId: string;
  action: HumanStepConfig['action'];
  urgency: HumanStepConfig['urgency'];
  prompt?: string;
}
```

## Storage Schema

### SQLite Tables

```sql
-- Workflow instances
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  definition_name TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  definition TEXT NOT NULL,  -- JSON blob
  status TEXT NOT NULL,
  current_step_id TEXT,
  context TEXT NOT NULL,     -- JSON blob
  step_results TEXT NOT NULL, -- JSON blob
  step_attempts TEXT NOT NULL, -- JSON blob
  error TEXT,                 -- JSON blob (nullable)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

-- Indexes for common queries
CREATE INDEX idx_workflows_status ON workflows(status);
CREATE INDEX idx_workflows_definition ON workflows(definition_name, definition_version);
CREATE INDEX idx_workflows_created ON workflows(created_at);

-- Event log (optional, for debugging/audit)
CREATE TABLE workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,     -- JSON blob
  timestamp TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

CREATE INDEX idx_events_workflow ON workflow_events(workflow_id);
CREATE INDEX idx_events_timestamp ON workflow_events(timestamp);
```

## Validation Rules

### WorkflowDefinition Validation

| Field | Rule |
|-------|------|
| name | Required, non-empty string |
| version | Required, valid semver |
| steps | Required, non-empty array |
| steps[].id | Required, unique within workflow |
| steps[].type | Required, one of valid types |
| steps[].next | If present, must reference valid step ID |
| timeout | If present, positive integer |

### Step Navigation Validation

- All referenced step IDs must exist in the workflow
- Workflow must have at least one step reachable from step[0]
- Workflow must have at least one terminal step (no `next`)
- Condition steps must have both `then` and `else` paths

### Context Path Validation

Property path expressions must:
- Use dot notation (e.g., `context.data.status`)
- Reference valid operators
- Have properly typed comparison values

---

*Generated by speckit*
