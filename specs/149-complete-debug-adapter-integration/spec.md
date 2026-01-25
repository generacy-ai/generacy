# Feature Specification: Complete debug adapter integration with step execution

**Branch**: `149-complete-debug-adapter-integration` | **Date**: 2026-01-24 | **Status**: Draft

## Summary
The Debug Adapter Protocol (DAP) implementation is complete but contains placeholder integration points with the step execution engine. The debugger needs to be wired to the actual workflow runner.

## Current State
The debugger has comprehensive DAP support:
- `adapter.ts` - Full DAP implementation
- `session.ts` - Debug session manager
- `breakpoints.ts` - Breakpoint management
- `variables-view.ts` - Variable inspection
- `watch-expressions.ts` - Watch expression tracking
- `history-panel.ts` - Execution history
- `error-analysis.ts` - Error categorization
- `replay-controller.ts` - Replay functionality

## What's Missing
1. **Execution engine binding** - Connect DAP to actual step executor
2. **Step boundary events** - Emit events when steps start/complete
3. **Variable population** - Populate variables view with actual step state
4. **Breakpoint triggering** - Pause execution when breakpoint is hit
5. **Continue/step implementation** - Wire debug controls to executor

## Key Files
- `/packages/generacy-extension/src/views/local/debugger/adapter.ts`
- `/packages/generacy-extension/src/views/local/runner/executor.ts`

## Dependencies
- **Blocked by**: #147 (Complete workflow step execution engine)

## Acceptance Criteria
- [ ] Can set breakpoints on workflow steps
- [ ] Execution pauses at breakpoints
- [ ] Variables view shows current step state
- [ ] Watch expressions evaluate correctly
- [ ] Step Over advances to next step
- [ ] Continue resumes to next breakpoint or completion

## User Stories

### US1: Debug Workflow Execution

**As a** workflow developer,
**I want** to set breakpoints on workflow steps and inspect execution state,
**So that** I can debug workflow logic by pausing at specific steps and examining variables.

**Acceptance Criteria**:
- [ ] Can set breakpoints on any workflow step
- [ ] Execution pauses at breakpoints with full state inspection
- [ ] Variables view shows Inputs, Outputs, and Workflow scopes

### US2: Step Through Workflow

**As a** workflow developer,
**I want** to step through workflow execution one step at a time,
**So that** I can understand the flow of data between steps and identify issues.

**Acceptance Criteria**:
- [ ] Step Over advances to the next step (across phases)
- [ ] Step Into enters nested workflows when applicable
- [ ] Step Out completes the current phase
- [ ] Continue resumes to next breakpoint or completion

### US3: Inspect and Watch Variables

**As a** workflow developer,
**I want** to add watch expressions using dot-notation to inspect step state,
**So that** I can monitor specific values as execution progresses.

**Acceptance Criteria**:
- [ ] Watch expressions support dot-notation (e.g., step.output.status)
- [ ] Variables update in real-time as execution advances
- [ ] Three scopes visible: Inputs, Outputs, Workflow globals

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Bind DAP adapter to step execution engine | P1 | Core integration point |
| FR-002 | Emit step boundary events (start/complete) from executor | P1 | Required for breakpoints |
| FR-003 | Populate variables view with 3 scopes: Inputs, Outputs, Workflow | P1 | Clarified: two-level + globals |
| FR-004 | Trigger breakpoint pause when execution reaches a breakpointed step | P1 | |
| FR-005 | Wire Step Over to advance to next step (any phase) | P1 | |
| FR-006 | Wire Step Into to enter nested workflow | P2 | Only applies to nested workflows |
| FR-007 | Wire Step Out to complete current phase | P1 | |
| FR-008 | Wire Continue to resume to next breakpoint or end | P1 | |
| FR-009 | Pause on step errors by default, configurable via launch config | P1 | Clarified: opt-out model |
| FR-010 | Support dot-notation watch expressions (e.g., step.output.field) | P2 | Clarified: simple syntax first |
| FR-011 | Replay uses cached execution results from history panel | P2 | Clarified: recorded replay only |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Breakpoint hit accuracy | 100% | All set breakpoints pause execution when reached |
| SC-002 | Variable scope display | 3 scopes | Inputs, Outputs, and Workflow scopes visible during pause |
| SC-003 | Step controls functional | All 4 | Step Over, Step Into, Step Out, Continue all work correctly |
| SC-004 | Error pause behavior | Default on | Debugger pauses on step errors unless disabled in config |

## Assumptions

- The step execution engine (#147) provides an event-based API for step lifecycle (start, complete, error)
- The executor supports pause/resume semantics for breakpoint integration
- Workflow definitions have identifiable step boundaries that can serve as breakpoint locations
- The existing DAP adapter implementation correctly handles the DAP protocol

## Out of Scope

- Live replay (re-executing steps through executor) — recorded replay only for now
- JSONPath or JavaScript expression syntax for watch expressions — dot-notation only
- Full hierarchical variable scoping (Phase, Action levels) — two-level + globals only
- Remote debugging (debugging workflows on remote servers)
- Conditional breakpoints or logpoints

---

*Generated by speckit*
