# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-24 20:34

### Q1: Implementation Status Verification
**Context**: The executor.ts code shows step dispatch, action handlers, output capture, retry logic, and state management are all implemented. The spec.md lists these as 'missing' but the code suggests they exist.
**Question**: Should we verify the existing implementation works end-to-end before adding new code, or are there known gaps in the current implementation that need to be addressed?
**Options**:
- A: Verify existing implementation with integration tests first
- B: There are known gaps - specify which components are incomplete
- C: Implementation is complete - update spec to reflect current state

**Answer**: *Pending*

### Q2: Debug Adapter Integration
**Context**: debug-integration.ts provides DebugHooks class with breakpoint and pause/resume support, but it's unclear if this is fully integrated with the executor's step execution flow.
**Question**: Is the DebugHooks integration with WorkflowExecutor complete, or does the executor need to be modified to call the debug hooks before/after each step?
**Options**:
- A: Integration is complete and tested
- B: Executor needs modification to call debug hooks
- C: This is out of scope for this issue

**Answer**: *Pending*

### Q3: Test Coverage Requirements
**Context**: The acceptance criteria include 'Can run a simple workflow with workspace.prepare step' and 'Can invoke Claude Code via agent.invoke step'. These require either mocking the Claude CLI or having it installed.
**Question**: Should the verification tests mock external dependencies (git, Claude CLI) or test against real CLIs?
**Options**:
- A: Mock external dependencies for reliable CI testing
- B: Test against real CLIs with appropriate timeouts
- C: Provide both mocked unit tests and integration tests

**Answer**: *Pending*

