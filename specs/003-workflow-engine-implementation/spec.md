# Feature Specification: Workflow engine implementation

**Branch**: `003-workflow-engine-implementation` | **Date**: 2026-01-19 | **Status**: Draft

## Summary

Implement the core workflow engine that orchestrates SDLC workflows.

## Parent Epic

#2 - Generacy Core Package

## Dependencies

- Types will be defined locally first, then extracted to generacy-ai/contracts later once interfaces are stable

## Requirements

### Workflow Engine

```typescript
class WorkflowEngine {
  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // Workflow management
  startWorkflow(definition: WorkflowDefinition, context: WorkflowContext): Promise<string>;
  pauseWorkflow(id: string): Promise<void>;
  resumeWorkflow(id: string): Promise<void>;
  cancelWorkflow(id: string): Promise<void>;

  // Queries
  getWorkflow(id: string): Promise<Workflow | undefined>;
  listWorkflows(filter?: WorkflowFilter): Promise<Workflow[]>;

  // Events
  onWorkflowEvent(callback: (event: WorkflowEvent) => void): void;
}
```

### Workflow Definition

```typescript
interface WorkflowDefinition {
  name: string;
  version: string;
  steps: WorkflowStep[];
  onError?: ErrorHandler;
  timeout?: number;
}

interface WorkflowStep {
  id: string;
  type: 'agent' | 'human' | 'integration' | 'condition' | 'parallel';
  config: StepConfig;
  next?: string | ConditionalNext[];
  timeout?: number;
  retries?: number;
}

// Parallel step type for concurrent branch execution
interface ParallelStep extends WorkflowStep {
  type: 'parallel';
  branches: WorkflowStep[][];
  join: 'all' | 'any';  // Wait for all branches or first to complete
}
```

### Error Handling

```typescript
interface ErrorHandler {
  // Rich error handling with retry policies, fallback steps, and escalation
  onError: (error: Error, step: WorkflowStep, context: WorkflowContext) => ErrorAction;
}

type ErrorAction =
  | { type: 'retry'; delay?: number; maxAttempts?: number }
  | { type: 'abort'; reason: string }
  | { type: 'escalate'; urgency: 'blocking_now' | 'blocking_soon' | 'when_available' }
  | { type: 'fallback'; stepId: string };

// MVP implementation: retry + abort + escalate-to-human
```

### Condition Evaluation

Condition steps use simple property path checks (no JavaScript eval for security):

```typescript
interface ConditionConfig {
  // Property path checks: 'context.approval.status == approved'
  expression: string;
  // Supported operators: ==, !=, >, <, contains, exists
  then: string;  // Step ID if true
  else: string;  // Step ID if false
}
```

### State Persistence

Pluggable storage adapter pattern with SQLite as default:

```typescript
interface StorageAdapter {
  save(workflow: Workflow): Promise<void>;
  load(id: string): Promise<Workflow | undefined>;
  list(filter?: WorkflowFilter): Promise<Workflow[]>;
  delete(id: string): Promise<void>;
}

// Default implementation: SQLiteStorageAdapter
// Allows swapping backends for cloud deployments or team preferences
```

### Built-in Workflows

#### Standard Development Workflow
```yaml
name: standard-development
version: "1.0"
steps:
  - id: specify
    type: agent
    config:
      command: "/speckit:specify"
      mode: research
    next: plan

  - id: plan
    type: agent
    config:
      command: "/speckit:plan"
      mode: research
    next: human-review-plan

  - id: human-review-plan
    type: human
    config:
      action: review
      urgency: blocking_soon
    next: implement

  - id: implement
    type: agent
    config:
      command: "/speckit:implement"
      mode: coding
    next: human-review-code

  - id: human-review-code
    type: human
    config:
      action: review
      urgency: when_available
```

#### Example with Parallel Execution
```yaml
name: parallel-review-workflow
version: "1.0"
steps:
  - id: parallel-checks
    type: parallel
    branches:
      - [lint, typecheck]
      - [unit-tests]
    join: all
    next: deploy
```

### State Machine

- Track workflow state transitions
- Persist state for recovery via pluggable StorageAdapter (default: SQLite)
- Support parallel branches via explicit 'parallel' step type
- Handle step failures with rich error handling (retry, abort, escalate)

### Event Publishing

- Emit events on state changes
- Include timing metrics
- Support event subscribers

## Acceptance Criteria

- [ ] Workflows start and progress through steps
- [ ] Human steps pause for input
- [ ] Agent steps invoke configured commands
- [ ] State persists across restarts (via StorageAdapter)
- [ ] Timeout handling works
- [ ] Events published for all state changes
- [ ] Parallel step type executes branches concurrently
- [ ] Condition steps evaluate property path expressions
- [ ] Error handler supports retry, abort, and escalate actions

## User Stories

### US1: Workflow Author

**As a** workflow author,
**I want** to define multi-step workflows with agent, human, and condition steps,
**So that** I can automate SDLC processes with appropriate human oversight.

**Acceptance Criteria**:
- [ ] Can define workflows in YAML or programmatically
- [ ] Steps execute in defined order
- [ ] Human steps block until input received

### US2: Workflow Operator

**As a** workflow operator,
**I want** workflows to persist state and recover from restarts,
**So that** long-running workflows don't lose progress.

**Acceptance Criteria**:
- [ ] State persists to storage on each step transition
- [ ] Workflows resume from last known state after restart

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Pluggable storage adapter | P1 | SQLite default |
| FR-002 | Parallel step execution | P2 | Explicit parallel type |
| FR-003 | Rich error handling | P1 | MVP: retry + abort + escalate |
| FR-004 | Condition evaluation | P2 | Property path checks |
| FR-005 | Local type definitions | P1 | Extract to contracts later |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Workflow completion rate | >95% | Workflows reaching terminal state |
| SC-002 | State recovery | 100% | Workflows resumable after restart |

## Assumptions

- SQLite is sufficient for single-node deployments
- Property path syntax covers most condition use cases
- Types will stabilize before extraction to contracts package

## Out of Scope

- Distributed workflow coordination (multi-node)
- Complex DSL for condition expressions
- Visual workflow designer

---

*Generated by speckit*
