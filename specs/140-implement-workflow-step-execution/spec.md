# Feature Specification: Implement workflow step execution engine

**Branch**: `140-implement-workflow-step-execution` | **Date**: 2026-01-23 | **Status**: Draft

## Summary

The workflow execution engine parses YAML workflow definitions but does not actually execute the steps. This is the core functionality needed for local workflow testing.

## Priority: HIGH - Core value proposition

## Current State
- `ExecutableWorkflow` type is defined with phases and steps
- YAML parsing and validation works (Zod schemas)
- Debug adapter infrastructure exists
- Runner UI framework is in place

## What's Missing
The actual step execution logic in `/packages/generacy-extension/src/views/local/runner/`:
- Step invocation based on action type (`workspace.prepare`, `agent.invoke`, `verification.check`, `pr.create`)
- Integration with Claude Code CLI (direct invocation from VS Code extension)
- Step output capture and state management (structured JSON with string coercion fallback)
- Error handling and configurable per-step retry logic with exponential backoff
- Timeout enforcement

## Key Design Decisions

### Action Types (All Required for MVP)
Implement all four core action types:
- `workspace.prepare` - Git operations (branch creation, checkout)
- `agent.invoke` - Delegate to Claude Code CLI
- `verification.check` - Run tests/lint commands
- `pr.create` - GitHub CLI call for PR creation

### Claude Code Integration
Call Claude Code CLI directly from VS Code extension (Option A):
- Simplest approach for local MVP
- No container dependency required
- Extension runs in user's environment where Claude Code CLI is installed
- Containerized plugin Invoker is for cloud execution (future)

### Variable Interpolation
Structured JSON outputs with fallback to string coercion:
- Supports deep field access: `${steps.stepId.output.field.nested}`
- Agent outputs are inherently structured (JSON responses, commit lists)
- Fallback handles edge cases gracefully

### Debug Adapter Integration
Basic stepping at step boundaries:
- Pause/resume at step boundaries
- Current step indicator
- Inspect inputs/outputs at breakpoints
- No need for step-into (steps are atomic)

### Retry Behavior
Configurable per-step retry with exponential backoff:
- Honor existing workflow YAML schema retry configuration
- Different steps have different failure modes requiring different strategies

## Acceptance Criteria
- [ ] Can execute a simple workflow with `workspace.prepare` → `agent.invoke` → `verification.check` → `pr.create` steps
- [ ] Steps receive correct inputs from workflow definition
- [ ] Step outputs are captured as structured JSON and available for subsequent steps
- [ ] Variable interpolation works (`${inputs.issueNumber}`, `${steps.stepId.output.field}`)
- [ ] Timeout and error handling functional with configurable per-step retries
- [ ] Integration with debug adapter for pause/resume at step boundaries

## Related Files
- `packages/generacy-extension/src/views/local/runner/executor.ts`
- `packages/generacy-extension/src/views/local/runner/types.ts`
- `packages/generacy-plugin-claude-code/src/invocation/invoker.ts`

## User Stories

### US1: Execute Basic Workflow

**As a** workflow developer,
**I want** to execute a complete workflow locally,
**So that** I can test and iterate on workflow definitions before deploying them.

**Acceptance Criteria**:
- [ ] Can run workspace.prepare to set up git branch
- [ ] Can invoke Claude Code agent with task prompt
- [ ] Can run verification checks (tests, linting)
- [ ] Can create a PR with the agent's changes

### US2: Debug Workflow Execution

**As a** workflow developer,
**I want** to step through workflow execution,
**So that** I can understand and debug workflow behavior.

**Acceptance Criteria**:
- [ ] Can pause execution at step boundaries
- [ ] Can inspect step inputs and outputs
- [ ] Can resume execution after pausing

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Implement workspace.prepare action handler | P1 | Git branch operations |
| FR-002 | Implement agent.invoke action handler | P1 | Claude Code CLI integration |
| FR-003 | Implement verification.check action handler | P1 | Test/lint execution |
| FR-004 | Implement pr.create action handler | P1 | GitHub CLI integration |
| FR-005 | Variable interpolation engine | P1 | Supports ${inputs.*} and ${steps.*} |
| FR-006 | Execution context with JSON outputs | P1 | Track all step outputs |
| FR-007 | Per-step retry with exponential backoff | P2 | Honor YAML retry config |
| FR-008 | Debug adapter step boundary integration | P2 | Pause/resume at steps |
| FR-009 | Timeout enforcement per step | P2 | Configurable timeouts |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Workflow completion | 100% | Simple 4-step workflow runs to completion |
| SC-002 | Variable interpolation | 100% | All ${} patterns resolved correctly |
| SC-003 | Debug stepping | Works | Can pause and resume at any step |

## Assumptions

- Claude Code CLI is installed and accessible in the user's PATH
- GitHub CLI (gh) is authenticated for PR operations
- Git is configured in the workspace

## Out of Scope

- Containerized execution (cloud mode) - future work
- Parallel step execution - sequential only for MVP
- Workflow composition (calling other workflows)
- Cloud deployment integration

---

*Generated by speckit*
