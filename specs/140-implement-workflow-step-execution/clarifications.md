# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-23 17:37

### Q1: Action Type Mapping
**Context**: The current executor only handles shell/script actions. We need to implement handlers for semantic action types like workspace.prepare, agent.invoke, verification.check, and pr.create. This determines the core architecture of the step executor.
**Question**: Which action types should be prioritized for the initial implementation? Should we implement all of them or start with a minimal set?
**Options**:
- A: Implement all listed types: workspace.prepare, agent.invoke, verification.check, pr.create
- B: Start minimal with shell/script + agent.invoke only (defer workspace.prepare and pr.create)
- C: Focus only on agent.invoke integration with Claude Code plugin for MVP

**Answer**: *Pending*

### Q2: Claude Code Integration Path
**Context**: There are two potential integration paths: (1) Use the existing generacy-plugin-claude-code Invoker class via container execution, or (2) Create a new local invoker that calls Claude Code directly via CLI. The choice affects architecture and dependencies.
**Question**: Should the agent.invoke step use the containerized plugin invoker or call Claude Code CLI directly from the VS Code extension?
**Options**:
- A: Call Claude Code CLI directly from VS Code extension (simpler, no container needed)
- B: Use the plugin's Invoker class via inter-process communication
- C: Support both approaches with a configurable adapter

**Answer**: *Pending*

### Q3: Variable Interpolation Scope
**Context**: The spec mentions interpolation for ${inputs.issueNumber} and ${steps.stepId.output.field}. This requires a context object that tracks all step outputs and workflow inputs.
**Question**: Should the execution context persist outputs as structured JSON (allowing deep field access) or as simple string values?
**Options**:
- A: Structured JSON outputs - full ${steps.stepId.output.field.nested} support
- B: String outputs only - simpler ${steps.stepId.output} patterns
- C: Structured JSON with fallback to string coercion

**Answer**: *Pending*

### Q4: Debug Adapter Integration Scope
**Context**: The acceptance criteria mention 'integration with debug adapter for step-through execution'. The debug adapter infrastructure exists but we need to define what capabilities are required.
**Question**: What level of debug adapter integration is required for this feature?
**Options**:
- A: Full debugging: breakpoints, step into/over, variable inspection, call stack
- B: Basic stepping: pause/resume at step boundaries, current step indicator
- C: Read-only observation: execution status and progress events only

**Answer**: *Pending*

### Q5: Retry Behavior
**Context**: The spec mentions 'error handling and retry logic' but doesn't specify retry policies. This affects reliability and execution time.
**Question**: What retry behavior should be implemented for failed steps?
**Options**:
- A: Configurable per-step retry count with exponential backoff
- B: Simple fixed retry count (e.g., 3 attempts) for transient errors only
- C: No automatic retries - manual retry via UI only

**Answer**: *Pending*

