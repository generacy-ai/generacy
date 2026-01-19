# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 18:30

### Q1: AgentFeature Definition
**Context**: The AgentInvoker.supports() method references AgentFeature but this type is not defined. This is needed to implement capability-based agent selection.
**Question**: What capabilities should AgentFeature enumerate?
**Options**:
- A: Minimal set: streaming, mcp_tools, concurrent_execution
- B: Extended set: include timeout_control, environment_injection, custom_prompts
- C: Defer to implementation - start with streaming and mcp_tools only

**Answer**: *Pending*

### Q2: Error Handling Strategy
**Context**: The spec mentions error handling but doesn't specify the pattern. This affects how callers handle failures and whether we use exceptions or result types.
**Question**: How should agent invocation errors be communicated to callers?
**Options**:
- A: Throw exceptions for all errors (timeouts, unavailable agents, invocation failures)
- B: Return InvocationResult with success=false and error details (never throw)
- C: Hybrid: throw for infrastructure errors, return result for invocation failures

**Answer**: *Pending*

### Q3: Default Agent Criteria
**Context**: AgentRegistry.getDefault() is specified but the criteria for selecting the default aren't clear. This matters when multiple agents are available.
**Question**: How should the default agent be determined?
**Options**:
- A: Configuration file specifies default agent by name
- B: First available agent based on priority order
- C: Capability-based: select agent that supports required features

**Answer**: *Pending*

### Q4: Mode Setting Dependency
**Context**: The invokeWithMode() function references agency.setMode() but Agency isn't specified. This determines whether mode is part of this feature or a separate dependency.
**Question**: What is the 'agency' reference in mode setting?
**Options**:
- A: Part of this feature - implement mode tracking within the agent abstraction
- B: External dependency - Agency is a separate component that manages workflow modes
- C: Remove mode setting - agents should receive mode as context, not set global state

**Answer**: *Pending*

### Q5: ToolCallRecord Structure
**Context**: InvocationResult references ToolCallRecord[] for tracking tool calls made during agent execution. The structure affects observability and debugging.
**Question**: What information should ToolCallRecord capture?
**Options**:
- A: Minimal: tool_name, success, duration
- B: Standard: add input/output summaries, timestamps, error messages
- C: Detailed: include full input/output, stack traces, nested tool calls

**Answer**: *Pending*

