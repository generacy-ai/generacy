# Tasks: Inject sibling-repo awareness into agent prompt

**Input**: Design documents from `/specs/688-phase-1-multi-repo/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type & Pure Function

- [ ] T001 [P] [US1] Add `siblingWorkdirs?: string[]` to `WorkerContext` in `packages/orchestrator/src/worker/types.ts`
- [ ] T002 [P] [US1] Create `packages/orchestrator/src/worker/sibling-prompt.ts` with `buildSiblingPromptBlock()` pure function — accepts `string[]`, returns formatted markdown block or `undefined` for empty input
- [ ] T003 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/sibling-prompt.test.ts` — test empty array returns `undefined`, single path format, multiple paths format, nested dir basename extraction

## Phase 2: Integration

- [ ] T004 [US1] Inject sibling block in `packages/orchestrator/src/worker/phase-loop.ts` — call `buildSiblingPromptBlock(context.siblingWorkdirs ?? [])` and prepend to prompt before `cliSpawner.spawnPhase()` call (~line 185)
- [ ] T005 [US2] Stub `siblingWorkdirs: []` in context assembly in `packages/orchestrator/src/worker/claude-cli-worker.ts` (~line 301–312) with `// TODO(#687)` comment

## Phase 3: Integration Tests

- [ ] T006 [US1] Add phase-loop test: non-empty `siblingWorkdirs` → `spawnPhase` receives prompt with sibling block prepended, in `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts`
- [ ] T007 [P] [US2] Add phase-loop test: empty/absent `siblingWorkdirs` → `spawnPhase` receives original `context.issueUrl` unchanged, in `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts`

## Dependencies & Execution Order

**Phase 1** (T001, T002, T003): All independent — type definition, pure function, and its unit tests can be written in parallel. T003 depends on T002 logically but can be co-authored.

**Phase 2** (T004, T005): T004 depends on T001 (type field) and T002 (function import). T005 depends on T001 (type field). T004 and T005 are independent of each other but both require Phase 1.

**Phase 3** (T006, T007): Both depend on T004 (injection logic) being complete. T006 and T007 test different scenarios in the same file but can be written together.

**Parallel opportunities**: T001, T002, T003 are fully parallel. T006 and T007 are parallel with each other.
