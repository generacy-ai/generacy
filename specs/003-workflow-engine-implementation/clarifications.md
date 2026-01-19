# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 16:30

### Q1: State Persistence Strategy
**Context**: The spec requires state to persist across restarts, but doesn't specify the storage mechanism. This affects architecture significantly - in-memory vs file-based vs database.
**Question**: What storage mechanism should be used for workflow state persistence?
**Options**:
- A: In-memory only (no persistence, state lost on restart)
- B: File-based storage (JSON/YAML files in a configured directory)
- C: SQLite database (embedded, no external dependencies)
- D: Pluggable storage adapter (allow multiple backends)

**Answer**: D - Pluggable storage adapter. The planning docs emphasize extensibility throughout - plugins, capability discovery, and protocol versioning. A pluggable storage adapter aligns with this philosophy. The default implementation should be SQLite for zero external dependencies, but the interface should support swapping backends for cloud deployments or team preferences.

### Q2: Parallel Branch Execution
**Context**: The spec mentions 'support parallel branches' but doesn't explain how workflows can define or execute parallel paths. This is needed to design the step execution model.
**Question**: How should parallel branches be defined and executed in workflow definitions?
**Options**:
- A: Array of step IDs in 'next' field triggers parallel execution
- B: Explicit 'parallel' step type that wraps concurrent branches
- C: Not needed for MVP - implement sequential execution only

**Answer**: B - Explicit 'parallel' step type. The architecture overview explicitly mentions "parallel agent invocation and coordination" as a Generacy capability. An explicit `parallel` step type is cleaner semantically and more readable than overloading the `next` field.

### Q3: Error Handler Definition
**Context**: WorkflowDefinition references ErrorHandler type but it's not defined. Need to understand error handling semantics.
**Question**: What should the ErrorHandler interface look like and what error recovery options should it support?
**Options**:
- A: Simple callback: (error: Error, step: WorkflowStep) => 'retry' | 'skip' | 'abort'
- B: Rich handler with retry policies, fallback steps, and error transformation
- C: Defer error handling design - use simple abort-on-error for MVP

**Answer**: B - Rich handler with retry policies, fallback steps, and error transformation. The docs describe human escalation with urgency levels. Error handling should integrate with this - certain errors might retry automatically, while others escalate to humans. For MVP, implement a subset (retry + abort + escalate-to-human).

### Q4: Condition Step Evaluation
**Context**: The 'condition' step type is listed but no example or explanation is provided. Need to understand how conditions are evaluated.
**Question**: How should condition steps evaluate their expressions to determine the next step?
**Options**:
- A: JavaScript expression evaluated against workflow context
- B: Simple property path checks (e.g., 'context.status == approved')
- C: Predefined condition types only (e.g., 'stepSucceeded', 'outputContains')

**Answer**: B - Simple property path checks. JavaScript eval introduces security concerns. Predefined-only is too limiting. Simple property path checks like `context.approval.status == 'approved'` are safe (no arbitrary code execution), expressive enough for most workflows, and easy to validate and debug. Should support operators: `==`, `!=`, `>`, `<`, `contains`, `exists`.

### Q5: External Dependency on Contracts
**Context**: The spec lists 'generacy-ai/contracts - Workflow schemas' as a dependency. Need to know if these schemas exist or need to be created as part of this feature.
**Question**: Does the generacy-ai/contracts package already exist with workflow schemas, or should types be defined locally first?
**Options**:
- A: Contracts package exists - import and use existing types
- B: Define types locally in this package, extract to contracts later
- C: Create contracts package first as a prerequisite task

**Answer**: B - Define types locally first, extract to contracts later. The contracts package is planned but likely doesn't exist yet. Defining types locally first avoids blocking on a prerequisite package, allows the types to stabilize through implementation, and makes extraction cleaner once the interfaces are battle-tested.

