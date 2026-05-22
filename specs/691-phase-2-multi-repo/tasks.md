# Tasks: Phase 2 Multi-Repo — Cross-Repo Change Fan-Out

**Input**: Design documents from `/specs/691-phase-2-multi-repo/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: GitStatus Extension

- [ ] T001 [P] [US1] Extend `GitStatus` interface with `hasUnpushed: boolean` and `unpushedCount: number` fields in `packages/workflow-engine/src/actions/github/client/interface.ts:76-82`
- [ ] T002 [US1] Implement unpushed commit detection in `GhCliGitHubClient.getStatus()` — run `git rev-list --count origin/<branch>..HEAD` and populate new fields. Handle missing remote tracking branch (treat as 0). File: `packages/workflow-engine/src/actions/github/client/gh-cli.ts`
- [ ] T003 [US1] Add unit tests for unpushed detection in `packages/workflow-engine/tests/actions/github/` — cover: commits ahead, no remote tracking branch, detached HEAD, clean state

## Phase 2: Sibling Fan-Out Handler

- [ ] T004 [US1] Create `packages/workflow-engine/src/handlers/sibling-fanout.ts` — define `SiblingFanoutContext` and `SiblingFanoutResult` interfaces per data-model.md, export `siblingFanoutHandler(ctx)` function stub
- [ ] T005 [US1] Implement sibling fan-out handler core logic — for each sibling: (1) detect changes via `getStatus()`, (2) create/checkout matching branch, (3) stage all + commit with primary's last commit message, (4) push to origin, (5) check/create draft PR with `Closes generacy-ai/<primary-repo>#<issue>` body, (6) persist via `addLinkedPR()`. File: `packages/workflow-engine/src/handlers/sibling-fanout.ts`
- [ ] T006 [US1] Implement short-circuit logic — return early when `siblingWorkdirs` is empty or all siblings are clean (no dirty tree, no unpushed commits). File: `packages/workflow-engine/src/handlers/sibling-fanout.ts`
- [ ] T007 [US1] Implement context sourcing — fetch primary branch name via `getStatus().branch`, fetch primary PR title via `gh pr view --json title` (with fallback to issue title if no PR exists). File: `packages/workflow-engine/src/handlers/sibling-fanout.ts`
- [ ] T008 [US1] Implement error handling — push/PR-create failures throw (phase fails); detection failures on individual siblings log warning and skip; partial success leaves completed siblings as-is. File: `packages/workflow-engine/src/handlers/sibling-fanout.ts`

## Phase 3: Tests

- [ ] T009 [US1] Create unit tests in `packages/workflow-engine/tests/handlers/sibling-fanout.test.ts` — mock `GitHubClient` and `WorkflowStore`. Cover: single sibling with changes produces branch + commit + push + draft PR + linkedPR entry
- [ ] T010 [P] [US1] Test idempotency — re-running handler when sibling branch and PR already exist: branch is checked out (not re-created), PR creation is skipped, no duplicate `linkedPRs` entries
- [ ] T011 [P] [US1] Test short-circuit — handler returns immediately when `siblingWorkdirs` is empty or all siblings are clean
- [ ] T012 [P] [US1] Test error propagation — push failure throws and surfaces as phase error; detection failure on one sibling logs and skips but continues with remaining siblings
- [ ] T013 [P] [US1] Test partial failure recovery — after one sibling succeeds and another fails, re-run recovers the failed sibling without re-processing the successful one

## Phase 4: Integration

- [ ] T014 [US1] Register `siblingFanoutHandler` as a `phase:after` handler via the #690 `phaseAfterHandlers` API. Wire in executor or orchestrator bootstrap. File: depends on #690's API shape (likely `packages/workflow-engine/src/executor/index.ts`)
- [ ] T015 [US1] Export `siblingFanoutHandler` from `packages/workflow-engine/src/handlers/index.ts` (create barrel file if needed)

## Dependencies & Execution Order

**Phase 1 → Phase 2 → Phase 3 → Phase 4** (sequential phases)

**Within-phase parallelism**:
- Phase 1: T001 can run in parallel with other prep work (interface-only change)
- Phase 2: T004 must complete before T005–T008 (type definitions needed). T005–T008 are sequential (building on each other within the same file)
- Phase 3: T010, T011, T012, T013 can all run in parallel (independent test cases). T009 should be written first as the baseline test
- Phase 4: T014 blocked on #690 merge. T015 is independent of T014

**Cross-issue dependencies**:
- T001–T003: No blockers (additive interface change)
- T004–T013: Requires #689 (`addLinkedPR`, `LinkedPR` type) — already merged
- T014: Requires #690 (`phaseAfterHandlers` API) — pending PR #698
