# Tasks: Extract Orchestrator Types Package

**Input**: Design documents from `/specs/672-background-generacy-ai/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Create Types Package

- [ ] T001 [US1] Create `packages/orchestrator-types/package.json` with zero runtime deps, `"name": "@generacy-ai/orchestrator-types"`, `"type": "module"`, matching existing package conventions (Node >=22, ESM, `workspace:^`)
- [ ] T002 [P] [US1] Create `packages/orchestrator-types/tsconfig.json` — target ES2022, module Node16, declaration: true, declarationMap: true, sourceMap: true, outDir: ./dist, rootDir: ./src
- [ ] T003 [US1] Create `packages/orchestrator-types/src/launcher-types.ts` — define `AgentLauncher`, `LaunchHandle`, `ChildProcessHandle`, `OutputParser`, `AgentLaunchPlugin`, `LaunchRequest`, `LaunchSpec`, `LaunchIntent`, `GenericSubprocessIntent`, `ShellIntent` interfaces per data-model.md
- [ ] T004 [P] [US1] Create `packages/orchestrator-types/src/config-types.ts` — define simplified `OrchestratorConfig` interface per data-model.md
- [ ] T005 [US1] Create `packages/orchestrator-types/src/index.ts` — re-export all types from `launcher-types.ts` and `config-types.ts`
- [ ] T006 [US1] Register `packages/orchestrator-types` in root `pnpm-workspace.yaml` if not auto-discovered by `packages/*` glob, then run `pnpm install` to link the new package

## Phase 2: Wire Orchestrator Re-exports

- [ ] T007 [US1] Add `@generacy-ai/orchestrator-types` as dependency in `packages/orchestrator/package.json`
- [ ] T008 [US1] Update `packages/orchestrator/src/launcher/agent-launcher.ts` — add `implements IAgentLauncher` (imported from `@generacy-ai/orchestrator-types`) to `AgentLauncher` class to enforce nominal type alignment
- [ ] T009 [US1] Update `packages/orchestrator/src/index.ts` — add re-exports of types from `@generacy-ai/orchestrator-types` so existing consumers are unaffected (FR-006)

## Phase 3: Update CLI Imports

- [ ] T010 [US1] Update `packages/generacy/src/agency/subprocess.ts` — change `import type { AgentLauncher } from '@generacy-ai/orchestrator'` to `from '@generacy-ai/orchestrator-types'` (FR-002)
- [ ] T011 [US1] Rewrite `packages/generacy/src/cli/commands/orchestrator.ts` — replace static `import { createServer, startServer, loadConfig, InMemoryApiKeyStore, type OrchestratorConfig }` with dynamic `import()` wrapped in try/catch. Use `OrchestratorConfig` type from `@generacy-ai/orchestrator-types`. Print clear install instructions on import failure (FR-005, DD-3)

## Phase 4: Update CLI package.json

- [ ] T012 [US1] In `packages/generacy/package.json`: move `@generacy-ai/orchestrator` from `dependencies` to `devDependencies`, add `@generacy-ai/orchestrator-types` to `dependencies` (FR-003, FR-004)
- [ ] T013 [US1] Run `pnpm install` to update lockfile and verify workspace resolution

## Phase 5: Validation

- [ ] T014 [US1] Run `pnpm build` across all packages — verify type-check passes with new package boundaries
- [ ] T015 [P] [US1] Run existing test suites (`pnpm test` in `packages/generacy/` and `packages/orchestrator/`) — confirm all tests pass (FR-007, SC-002)
- [ ] T016 [P] [US1] Verify `packages/orchestrator-types/` builds cleanly and emits `.d.ts` files with no runtime JS beyond type re-exports
- [ ] T017 [US1] Manual smoke test: confirm `generacy launch` codepath doesn't trigger orchestrator server imports; confirm `generacy orchestrator` (without orchestrator installed) shows the expected error message (SC-003, SC-004)

## Dependencies & Execution Order

**Sequential phase boundaries**: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

**Parallel within phases**:
- Phase 1: T001 must come first (package.json). T002 + T004 can run in parallel. T003 after T001. T005 after T003 + T004. T006 after all.
- Phase 2: T007 → T008 → T009 (sequential — each depends on prior)
- Phase 3: T010 + T011 can run in parallel (different files, no interdependency)
- Phase 4: T012 → T013 (sequential)
- Phase 5: T014 first (build), then T015 + T016 in parallel, T017 last

**Critical path**: T001 → T003 → T005 → T006 → T007 → T008 → T009 → T010 → T012 → T013 → T014 → T017
