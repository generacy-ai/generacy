# Tasks: Incremental Commits in Implement Operation

**Input**: Design documents from `/specs/358-summary-implement-operation/`
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core implement.ts Changes

All three tasks modify `implement.ts` and must execute sequentially (T001 → T002 + T003).

- [ ] T001 [US1] Resolve repo root once before the task loop in `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts` — run `git rev-parse --show-toplevel` with `cwd: input.feature_dir`; store result as `rootDir`; declare `let completedCount = 0` for push throttling
- [ ] T002 [US1] [US2] Add per-task commit + periodic push on success path in `implement.ts` — after `markTaskComplete` + `writeFile`: increment `completedCount`, run `git add -A` + `git commit -m "feat: complete <task.id>"` (both with `cwd: rootDir`); push when `completedCount % 3 === 0 || isLastTask`, with `.catch()` that logs a non-fatal warning
- [ ] T003 [US1] Add working tree cleanup on failure path in `implement.ts` — in both the non-zero exit `else` branch and the `catch` block: run `git checkout -- .` then `git clean -fd` with `cwd: rootDir`, each wrapped in `.catch(() => {})`

## Phase 2: Supporting Changes

All four tasks are in separate files and can run in parallel.

- [ ] T004 [P] [US3] Update `hasPriorImplementation` fallback in `packages/orchestrator/src/worker/phase-loop.ts` — expand the `.some()` check to also match `c.message.includes('feat: complete T')` so incremental commits are recognised by the no-changes guard
- [ ] T005 [P] [US1] Update `commit-implementation` step in `.generacy/speckit-feature.yaml` — replace `--allow-empty` with a check-then-commit one-liner: `git diff --cached --quiet && git diff --quiet || (git add -A && git commit -m "feat: implement ${{ steps.create-feature.output.branch_name }}")` and add `continueOnError: true`
- [ ] T006 [P] [US3] Confirm no changes needed to `workflows/speckit-feature.yaml` — the orchestrator's `prManager.commitPushAndEnsurePr` handles commit/push for this workflow; the T004 fix covers the no-changes guard; document the decision in a code comment if helpful
- [ ] T007 [P] [US1] Update commit constraint in both `implement.md` files in `/workspaces/agency` (`packages/agency-plugin-spec-kit/commands/implement.md` and `packages/claude-plugin-agency-spec-kit/commands/implement.md`) — change "Commit after each logical group of tasks (if user requests)" to "**Always** commit after completing each task. Push after every 3 completed tasks and after the final task."; remove all "parallel batch" commit language from the Constraints section and step 6 execution flow

## Dependencies & Execution Order

**Sequential within Phase 1**:
- T001 must complete before T002 and T003 (all three edit the same function body in `implement.ts`)
- T002 and T003 can be written in a single pass after T001 (same success/failure branches)

**Parallel in Phase 2**:
- T004, T005, T006, T007 all touch different files and have no shared state — run concurrently
- Phase 2 can begin as soon as Phase 1 is complete (no cross-phase blocking beyond that)

**Workspaces**:
- T001–T006 live in `/workspaces/generacy`
- T007 lives in `/workspaces/agency` — can be done concurrently with Phase 1
