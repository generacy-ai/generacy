# Feature Specification: Incremental Commits in Implement Operation

**Branch**: `358-summary-implement-operation` | **Date**: 2026-03-10 | **Status**: Draft

## Summary

The implement operation should commit and push after each completed task (or parallel batch), instead of only committing once after the entire phase completes. This prevents total work loss when a session crashes mid-implementation.

## Background

Currently, the workflow engine's implement operation (`packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`) executes tasks sequentially via `claude -p` per task, marks them complete in `tasks.md`, but **never commits**. The only commit happens in the workflow YAML after the entire implement step finishes (`speckit-feature.yaml` line 175).

This was the root cause of issue generacy-ai/generacy-cloud#133 failing twice: the Claude session ran out of context window while rewriting a large test file, and since no intermediate commits were made, all implementation work (7 tasks worth) was lost both times.

The `/implement` command definition (`agency-plugin-spec-kit/commands/implement.md`) currently says "Commit after each logical group of tasks (if user requests)" — but in headless/automated mode, nobody requests it.

## Changes Required

### `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`

After each task completes successfully (after `markTaskComplete` and `writeFile` on ~line 280), add a git commit + push:

```typescript
// After markTaskComplete + writeFile:
await executeCommand('git', ['add', '-A'], { cwd: process.cwd(), timeout: 30000 });
await executeCommand('git', ['commit', '-m', `feat: complete ${task.id}`, '--allow-empty'], { cwd: process.cwd(), timeout: 30000 });
await executeCommand('git', ['push'], { cwd: process.cwd(), timeout: 60000 }).catch(() => {
  // Push failure is non-fatal — progress is still saved locally
  context.logger.warn(`Push after ${task.id} failed (non-fatal)`);
});
```

Consider batching: commit after every task but push every N tasks (e.g., every 3) to reduce network overhead. Always push on the final task.

### `packages/agency-plugin-spec-kit/commands/implement.md`

Update the constraint in the Constraints section:
- **Old**: "Commit after each logical group of tasks (if user requests)"
- **New**: "**Always** commit after completing each task or parallel batch. Push after every 3 completed tasks and after the final task."

Also update step 6 execution flow to include commit/push after each `mark_complete`.

## Acceptance Criteria

- [ ] Each completed task produces a git commit with the task ID in the message
- [ ] Pushes happen periodically (every ~3 tasks) and on final task
- [ ] If session crashes mid-implementation, completed tasks are preserved in git history
- [ ] The existing `PHASES_REQUIRING_CHANGES` check in `phase-loop.ts` sees commits even if the session dies partway through
- [ ] Commit/push failures are non-fatal (logged but don't halt execution)

## References

- Root cause analysis: generacy-ai/generacy-cloud#133 (implementation failed twice, losing all work)
- `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`
- `packages/agency-plugin-spec-kit/commands/implement.md`

## User Stories

### US1: Crash-Resilient Implementation Progress

**As a** developer running automated speckit workflows,
**I want** each completed task to be committed to git immediately after completion,
**So that** if the session crashes or runs out of context, previously completed tasks are preserved and the workflow can resume from where it left off.

**Acceptance Criteria**:
- [ ] Each task completion triggers a `git commit` with the task ID in the message
- [ ] A crashed session does not result in loss of completed task work

### US2: Periodic Progress Pushes

**As a** developer monitoring automated implementations,
**I want** completed work to be pushed to the remote periodically (every ~3 tasks and on final task),
**So that** progress is visible remotely and recoverable even if the local environment is lost.

**Acceptance Criteria**:
- [ ] Pushes occur every 3 completed tasks and always after the final task
- [ ] Push failures are non-fatal and logged as warnings, not errors

### US3: Updated Implement Command Documentation

**As a** Claude agent executing the `/implement` command,
**I want** the command definition to clearly mandate committing after each task,
**So that** the agent always commits in headless/automated mode without waiting for user instruction.

**Acceptance Criteria**:
- [ ] `implement.md` constraints section mandates commit after each task or parallel batch
- [ ] Step 6 execution flow includes commit/push steps after `mark_complete`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | After each task completes, execute `git add -A` and `git commit` with message `feat: complete <task.id>` | P1 | Use `--allow-empty` to avoid failures on no-change tasks |
| FR-002 | Track a push counter; push after every 3rd committed task | P2 | Reduces network overhead vs. pushing every task |
| FR-003 | Always push after the final task in the batch | P1 | Ensures remote is up to date on completion |
| FR-004 | Push failures must be caught and logged as warnings, not thrown | P1 | Non-fatal; local commits still preserve progress |
| FR-005 | Update `implement.md` Constraints section to mandate commit/push behavior | P1 | Remove the "if user requests" qualifier |
| FR-006 | Update `implement.md` step 6 execution flow to include commit/push steps | P2 | Documentation alignment |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Task completion commit rate | 100% of completed tasks have a corresponding commit | Count commits with `feat: complete T-` prefix vs tasks marked complete |
| SC-002 | Work preservation on crash | Zero completed tasks lost on session crash | Verify git log contains commits for completed tasks after simulated crash |
| SC-003 | Push failure resilience | Push failures do not halt execution | CI test: block push and verify remaining tasks still complete |
| SC-004 | Remote push frequency | Remote is updated at least every 3 tasks | Count remote pushes in test run with 9 tasks |

## Assumptions

- The `executeCommand` utility in `implement.ts` supports git commands with the existing signature
- The working directory (`process.cwd()`) is the git repository root during task execution
- Remote origin is configured and authenticated in automated environments
- `--allow-empty` commits are acceptable for tasks that produce no file changes (e.g., documentation-only verification tasks)

## Out of Scope

- Changing the commit message format beyond `feat: complete <task.id>`
- Implementing full retry logic for failed pushes
- Modifying the workflow YAML `speckit-feature.yaml` commit step (it remains as a final safety net)
- Changing how parallel task batches are structured

---

*Generated by speckit*
