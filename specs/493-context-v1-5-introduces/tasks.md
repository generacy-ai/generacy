# Tasks: CLI Package Skeleton & Cluster Registry

**Input**: Design documents from `/specs/493-context-v1-5-introduces/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup & Utilities

- [ ] T001 Add `"engines": {"node": ">=22"}` to `packages/generacy/package.json`
- [ ] T002 [P] Create `src/cli/utils/node-version.ts` — `checkNodeVersion(minimum)` that parses `process.versions.node`, compares major >= minimum, prints error with install link and exits 1 on failure
- [ ] T003 [P] Create `src/cli/utils/error-handler.ts` — `setupErrorHandlers()` registering `uncaughtException` and `unhandledRejection` handlers; user-friendly messages, stack traces only when `DEBUG=1`
- [ ] T004 Update `bin/generacy.js` — call `checkNodeVersion(22)` before importing `run()` from `src/cli/index.ts`

## Phase 2: Registry Module

- [ ] T005 Create `src/registry/schema.ts` — Zod schemas (`ClusterEntrySchema`, `ClusterRegistrySchema`) and inferred types (`ClusterEntry`, `ClusterRegistry`)
- [ ] T006 Create `src/registry/registry.ts` — `loadRegistry()`, `saveRegistry()` (atomic tmp+rename), `addCluster()`, `removeCluster()`; depends on schema.ts
- [ ] T007 Create `src/registry/find-cluster.ts` — `findClusterByCwd(cwd?)` using `resolve()` + longest-prefix-match against `ClusterEntry.path`
- [ ] T008 Create `src/registry/index.ts` — public re-exports from schema, registry, find-cluster

## Phase 3: Placeholder Commands & CLI Wiring

- [ ] T009 Create `src/cli/commands/placeholders.ts` — data-driven array of 11 `PlaceholderDef` entries (`launch`, `up`, `stop`, `down`, `destroy`, `status`, `update`, `open`, `claude-login`, `deploy`, `rebuild`); `placeholderCommands()` factory returns `Command[]`
- [ ] T010 Modify `src/cli/index.ts` — import and register placeholder commands, import and call `setupErrorHandlers()`, add `--quiet` flag support for logger

## Phase 4: Tests

- [ ] T011 [P] Create `src/cli/utils/__tests__/node-version.test.ts` — mock `process.versions.node`; verify exit on Node 20, pass on Node 22+
- [ ] T012 [P] Create `src/cli/utils/__tests__/error-handler.test.ts` — verify handler registration, user-friendly output, DEBUG stack trace behavior
- [ ] T013 [P] Create `src/cli/__tests__/placeholders.test.ts` — verify each placeholder prints correct phase message and exits 0
- [ ] T014 [P] Create `src/registry/__tests__/registry.test.ts` — round-trip (save then load), add/remove cluster, atomic write (tmp left behind doesn't corrupt), schema validation rejects invalid JSON
- [ ] T015 [P] Create `src/registry/__tests__/find-cluster.test.ts` — exact match, subdirectory match, deepest-wins with nested paths, no match returns undefined

## Phase 5: Integration Verification

- [ ] T016 Run `pnpm build` in `packages/generacy` and fix any TypeScript errors
- [ ] T017 Run `pnpm test` in `packages/generacy` and fix any test failures

## Dependencies & Execution Order

```
Phase 1 (Setup):
  T001 ─────────────────────────────────────────────┐
  T002 [P] ──┐                                      │
  T003 [P] ──┤ (all three independent)               │
             ▼                                       │
  T004 ──── depends on T002 (imports node-version)   │
                                                     │
Phase 2 (Registry):                                  │
  T005 ─────────────────────────────────────────────►│
  T006 ──── depends on T005 (imports schema)         │
  T007 ──── depends on T005, T006                    │
  T008 ──── depends on T005, T006, T007              │
                                                     │
Phase 3 (CLI Wiring):                                │
  T009 ──── standalone                               │
  T010 ──── depends on T003, T009                    │
                                                     │
Phase 4 (Tests):                                     │
  T011 [P] ── depends on T002                        │
  T012 [P] ── depends on T003                        │
  T013 [P] ── depends on T009, T010                  │
  T014 [P] ── depends on T005–T008                   │
  T015 [P] ── depends on T005–T008                   │
                                                     │
Phase 5 (Verification):                              │
  T016 ──── depends on all implementation tasks      │
  T017 ──── depends on T016, all test tasks          │
```

**Parallel opportunities**:
- T001, T002, T003 can all run in parallel (Phase 1)
- T011–T015 can all run in parallel (Phase 4)
- T005 and T009 can run in parallel (cross-phase, no file overlap)
