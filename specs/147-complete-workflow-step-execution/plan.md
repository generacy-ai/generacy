# Implementation Plan: Complete Workflow Step Execution Engine

**Feature**: Complete the workflow step execution engine to enable end-to-end local workflow testing
**Branch**: `147-complete-workflow-step-execution`
**Status**: Complete

## Summary

The workflow runner framework in `executor.ts` already has comprehensive infrastructure for step execution including action handlers, variable interpolation, retry logic, and debug hooks. The current implementation is **largely complete** - all core action handlers exist and are functional. This plan identifies the remaining gaps and minor enhancements needed to achieve full end-to-end workflow execution.

## Technical Context

- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Dependencies**: Node.js child_process, VS Code Extension Host
- **Key Patterns**: Singleton executor, action handler registry, promise-based async execution, event-driven architecture

## Current Implementation Analysis

### What's Already Implemented ✅

1. **Step Invocation Dispatch** - `executor.ts:426-501`
   - `getActionHandler()` retrieves handlers from registry
   - `executeWithActionHandler()` dispatches to appropriate handler
   - Fallback to terminal execution for unrecognized actions

2. **Action Handlers** - All five handlers are fully implemented:
   - `WorkspacePrepareAction` - Git branch operations (create/checkout)
   - `AgentInvokeAction` - Claude Code CLI invocation with JSON parsing
   - `VerificationCheckAction` - Test/lint execution with result parsing
   - `PrCreateAction` - GitHub PR creation via gh CLI
   - `ShellAction` - Generic shell command fallback

3. **Output Capture and Parsing** - `cli-utils.ts`
   - `executeCommand()` captures stdout/stderr via spawn
   - `extractJSON()` parses JSON from command output
   - Step outputs stored in `ExecutionContext`

4. **Timeout Enforcement** - Implemented at multiple levels:
   - `cli-utils.ts:124-129` - Command-level timeout via setTimeout
   - `retry/index.ts:257-312` - `withTimeout()` wrapper
   - Individual action handlers pass timeout to executeCommand

5. **Error Handling** - `executor.ts:206-214`, `base-action.ts:70-82`
   - Try/catch wrapping in executeStep and executeWithActionHandler
   - Error propagation with meaningful messages
   - `continueOnError` flag support per step

6. **State Management** - `interpolation/context.ts`
   - `ExecutionContext` tracks inputs, step outputs, and environment
   - `stepOutputs` Map keyed by step ID
   - Success/failure state tracking for conditional execution

7. **Debug Integration** - `debug-integration.ts`
   - `DebugHooks` class with breakpoint support
   - `beforeStep()` and `afterStep()` hooks
   - Pause/resume functionality for step boundaries

### Gaps Identified

1. **Debug Hooks Not Wired into Executor**
   - `DebugHooks` class exists but `executeStep()` doesn't call the hooks
   - Breakpoint functionality is present but not integrated

2. **Per-Step Timeout Missing in Action Execution**
   - Timeout is passed to CLI commands but not enforced at action level
   - Long-running actions could exceed step timeout without being killed

3. **Step Condition Evaluation Limited**
   - Uses basic truthy evaluation
   - Missing support for complex expressions

## Project Structure

```text
packages/generacy-extension/src/views/local/runner/
├── executor.ts              # Main workflow executor (complete)
├── types.ts                 # Type definitions (complete)
├── debug-integration.ts     # Debug hooks (needs integration)
├── terminal.ts              # Terminal execution fallback
├── output-channel.ts        # Output logging
├── actions/
│   ├── index.ts             # Handler registry (complete)
│   ├── types.ts             # Action type definitions (complete)
│   ├── base-action.ts       # Base action class (complete)
│   ├── cli-utils.ts         # CLI execution utilities (complete)
│   ├── workspace-prepare.ts # Git operations (complete)
│   ├── agent-invoke.ts      # Claude Code CLI (complete)
│   ├── verification-check.ts # Test/lint (complete)
│   ├── pr-create.ts         # GitHub PR (complete)
│   └── shell.ts             # Shell fallback (complete)
├── interpolation/
│   ├── index.ts             # Interpolation exports
│   └── context.ts           # Execution context (complete)
└── retry/
    ├── index.ts             # Retry manager (complete)
    └── strategies.ts        # Backoff strategies (complete)
```

## Implementation Tasks

### Phase 1: Debug Hook Integration

1. **Wire debug hooks into executor**
   - Import and use `getDebugHooks()` in `executeStep()`
   - Call `beforeStep()` before action execution
   - Call `afterStep()` after action completes
   - Pass `StepState` and `ActionResult` to hooks

2. **Add step-level timeout wrapper**
   - Wrap action execution with `withTimeout()` from retry module
   - Use step.timeout or default timeout
   - Handle timeout errors gracefully

### Phase 2: Testing and Validation

3. **Add integration tests**
   - Test workspace.prepare with mock git
   - Test agent.invoke with mock claude CLI
   - Test timeout enforcement
   - Test debug hook pause/resume

4. **Manual end-to-end testing**
   - Run sample workflow with all action types
   - Verify step outputs are captured correctly
   - Verify debugger can pause at step boundaries

## Dependencies

- No new dependencies required
- Existing packages: vscode, child_process (Node.js built-in)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude Code CLI not available | High | Graceful fallback with helpful error message |
| Long-running agent tasks | Medium | Timeout enforcement at action level |
| Debug hook performance | Low | Hooks are no-op when disabled |

## Acceptance Criteria Mapping

| Criteria | Implementation Location | Status |
|----------|------------------------|--------|
| Run workspace.prepare step | `workspace-prepare.ts` | ✅ Complete |
| Invoke Claude Code via agent.invoke | `agent-invoke.ts` | ✅ Complete |
| Step outputs captured for subsequent steps | `executor.ts:447-451`, `context.ts` | ✅ Complete |
| Timeouts enforced per step | `cli-utils.ts:124-129` | ✅ CLI level, ⚠️ needs action wrapper |
| Errors caught and reported | `executor.ts:503-506`, `base-action.ts:70-82` | ✅ Complete |
| Debugger pause/resume at step boundaries | `debug-integration.ts` | ⚠️ Needs integration into executor |

## Summary

The implementation is **~90% complete**. The remaining work is:
1. Integrate debug hooks into the main executor loop (estimated: small task)
2. Add action-level timeout wrapper (estimated: small task)
3. Write integration tests to validate all acceptance criteria
