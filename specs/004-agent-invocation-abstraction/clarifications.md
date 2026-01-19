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

**Answer**: **C** - Defer to implementation, start with streaming and mcp_tools only. Start minimal and add capabilities as needed. This aligns with the architecture's "capability discovery" and "additive-only changes" principles - we can always add more features later without breaking existing code.

### Q2: Error Handling Strategy
**Context**: The spec mentions error handling but doesn't specify the pattern. This affects how callers handle failures and whether we use exceptions or result types.
**Question**: How should agent invocation errors be communicated to callers?
**Options**:
- A: Throw exceptions for all errors (timeouts, unavailable agents, invocation failures)
- B: Return InvocationResult with success=false and error details (never throw)
- C: Hybrid: throw for infrastructure errors, return result for invocation failures

**Answer**: **C** - Hybrid: throw for infrastructure errors, return result for invocation failures. Throw for infrastructure errors (agent unavailable, initialization failed) - these are systemic issues. Return InvocationResult with success=false for invocation failures (command timeout, non-zero exit) - these are expected workflow outcomes that fit the existing interface.

### Q3: Default Agent Criteria
**Context**: AgentRegistry.getDefault() is specified but the criteria for selecting the default aren't clear. This matters when multiple agents are available.
**Question**: How should the default agent be determined?
**Options**:
- A: Configuration file specifies default agent by name
- B: First available agent based on priority order
- C: Capability-based: select agent that supports required features

**Answer**: **A** - Configuration file specifies default agent by name. Explicit configuration is predictable and aligns with the adoption path where users consciously choose their agent stack. If the configured agent isn't available, fail explicitly rather than silently picking a different one.

### Q4: Mode Setting Dependency
**Context**: The invokeWithMode() function references agency.setMode() but Agency isn't specified. This determines whether mode is part of this feature or a separate dependency.
**Question**: What is the 'agency' reference in mode setting?
**Options**:
- A: Part of this feature - implement mode tracking within the agent abstraction
- B: External dependency - Agency is a separate component that manages workflow modes
- C: Remove mode setting - agents should receive mode as context, not set global state

**Answer**: **C** - Remove mode setting; agents should receive mode as context, not set global state. InvocationConfig.context.mode already exists in the spec. The agent invoker implementation can internally set the mode using the context when invoking. This provides a cleaner API (mode flows through invocation, not separate mutable state), avoids race conditions in concurrent invocations with different modes, and removes the undefined agency dependency.

### Q5: ToolCallRecord Structure
**Context**: InvocationResult references ToolCallRecord[] for tracking tool calls made during agent execution. The structure affects observability and debugging.
**Question**: What information should ToolCallRecord capture?
**Options**:
- A: Minimal: tool_name, success, duration
- B: Standard: add input/output summaries, timestamps, error messages
- C: Detailed: include full input/output, stack traces, nested tool calls

**Answer**: **B** - Standard: add input/output summaries, timestamps, error messages. Enough detail for debugging without overwhelming. Aligns with the "terse output pattern" - summaries can be truncated on success, detailed on failure. Full input/output (Option C) could be very large for complex tool calls.

