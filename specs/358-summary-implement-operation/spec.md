# Feature Specification: ## Summary

The implement operation should commit and push after each completed task (or parallel batch), instead of only committing once after the entire phase completes

**Branch**: `358-summary-implement-operation` | **Date**: 2026-03-10 | **Status**: Draft

## Summary

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

### US1: Automated session crash recovery

**As a** developer running speckit in headless/automated mode,
**I want** each completed task to be committed immediately after it finishes,
**So that** a session crash or context-window exhaustion only loses the current in-progress task, not all prior completed work.

**Acceptance Criteria**:
- [ ] Each successfully completed task produces a git commit containing the task ID in the message
- [ ] Commits are visible in `git log` before the overall implement phase finishes

### US2: Periodic pushes to remote

**As a** developer running speckit in CI or a remote devcontainer,
**I want** completed work to be pushed to the remote periodically (not just at the end),
**So that** a total host failure does not discard locally-committed work.

**Acceptance Criteria**:
- [ ] Push occurs after every ~3 completed tasks and always after the final task
- [ ] Push failures are non-fatal — logged as warnings but do not halt execution

### US3: Phase-loop compatibility

**As a** workflow author,
**I want** the `phase-loop.ts` "no changes produced" guard to correctly recognise incremental commits,
**So that** the implement phase is not incorrectly marked as having produced no work.

**Acceptance Criteria**:
- [ ] `hasPriorImplementation` fallback pattern in `phase-loop.ts` matches the new incremental commit message format

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | After `markTaskComplete` + `writeFile` in `implement.ts`, stage all changes and create a git commit | P1 | Commit message: `feat: complete <task.id>` |
| FR-002 | Push to remote after every 3 completed tasks and unconditionally after the final task | P1 | Push failure must be caught and logged, not re-thrown |
| FR-003 | Git commands must run from the repository root, not `input.feature_dir` | P1 | Detect root via `git rev-parse --show-toplevel` or equivalent |
| FR-004 | Update `phase-loop.ts` `hasPriorImplementation` fallback to also match `feat: complete T-` prefixed messages | P1 | Avoids false "no changes" failure when all commits are incremental |
| FR-005 | Update `agency-plugin-spec-kit/commands/implement.md` commit constraint to say "always commit after each task" | P2 | Remove the "(if user requests)" qualifier |
| FR-006 | Decide fate of `commit-implementation` YAML step (remove, keep as safety net, or update) | P2 | See Q3 in clarifications |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Work lost on session crash | At most 1 in-progress task | Manually kill session mid-task; check git log |
| SC-002 | Push failure impact | Zero — execution continues | Simulate network failure; verify no exception thrown |
| SC-003 | Phase-loop false negatives | Zero | Run implement phase end-to-end and verify no "no changes" error |
| SC-004 | Empty commit noise from YAML step | Resolved (removed or justified) | Inspect git log after full workflow run |

## Assumptions

- `executeCommand` in `implement.ts` is the correct primitive for running git commands (same pattern as other shell calls in that file)
- The implement phase always runs inside a git repository with a configured remote
- Failed tasks (non-zero exit code) do not need a commit — partial file changes from a failed Claude invocation are left in the working tree for the next attempt

## Out of Scope

- Implementing true parallel task execution (`isParallel` flag) — the "parallel batch" language in `implement.md` will be simplified to "sequential task" commits
- Retry logic for push failures
- Squash/rebase of incremental commits before the final PR merge

---

*Generated by speckit*
