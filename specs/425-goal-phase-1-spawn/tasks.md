# Tasks: Introduce AgentLauncher + GenericSubprocessPlugin (Phase 1)

**Input**: Design documents from `/specs/425-goal-phase-1-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup & Types

- [ ] T001 [US1] Create `packages/orchestrator/src/launcher/` directory and `types.ts` with all core type definitions: `GenericSubprocessIntent`, `ShellIntent`, `LaunchIntent` union, `LaunchRequest`, `LaunchSpec`, `AgentLaunchPlugin`, `OutputParser`, `LaunchHandle` — per data-model.md
  - File: `packages/orchestrator/src/launcher/types.ts`
  - Import `ChildProcessHandle` from `../worker/types.js`

## Phase 2: Core Implementation

- [ ] T002 [US1] Implement `AgentLauncher` class with plugin registry and `launch()` method
  - File: `packages/orchestrator/src/launcher/agent-launcher.ts`
  - Constructor accepts `Map<string, ProcessFactory>` (stdio profile → factory)
  - `registerPlugin(plugin)`: builds `kind → plugin` map, throws on duplicate kind
  - `launch(request)`: resolve plugin by `intent.kind`, call `buildLaunch()`, 3-layer env merge (`process.env ← plugin env ← caller env`), select factory by `stdioProfile`, spawn, return `LaunchHandle`
  - Throw descriptive errors for unknown intent kind (FR-013) and unknown stdio profile

- [ ] T003 [P] [US2] Implement `GenericSubprocessPlugin` class
  - File: `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts`
  - `pluginId: "generic-subprocess"`, `supportedKinds: ["generic-subprocess", "shell"]`
  - `buildLaunch()`: pass-through for `generic-subprocess`; wrap in `sh -c` for `shell`
  - `createOutputParser()`: return no-op parser
  - Both intents return `stdioProfile: "default"`

## Phase 3: Boot Registration

- [ ] T004 [US2] Register `AgentLauncher` + `GenericSubprocessPlugin` at orchestrator boot
  - File: `packages/orchestrator/src/worker/claude-cli-worker.ts` (modify)
  - Create `AgentLauncher` in constructor with `{ "default": defaultProcessFactory, "interactive": conversationProcessFactory }`
  - Register `GenericSubprocessPlugin`
  - Store as `private readonly agentLauncher` (unused by existing code paths in Phase 1)
  - Import paths must NOT expose launcher from `packages/orchestrator/src/index.ts` (FR-012)

## Phase 4: Tests

- [ ] T005 [US1] Write unit tests for `AgentLauncher`
  - File: `packages/orchestrator/src/launcher/__tests__/agent-launcher.test.ts`
  - Test cases:
    - Registry lookup succeeds for registered plugin
    - Unknown intent kind throws descriptive error with available kinds
    - Unknown stdio profile throws descriptive error
    - Duplicate kind registration throws at registration time
    - Env merge precedence: caller env > plugin env > process.env
    - Correct `ProcessFactory` selected by `stdioProfile`
    - `AbortSignal` propagated to `ProcessFactory.spawn()`
    - `LaunchHandle` exposes process, outputParser, and metadata

- [ ] T006 [P] [US2] Write snapshot + unit tests for `GenericSubprocessPlugin`
  - File: `packages/orchestrator/src/launcher/__tests__/generic-subprocess-plugin.test.ts`
  - Snapshot tests:
    - `buildLaunch()` output for `kind: "generic-subprocess"` intent
    - `buildLaunch()` output for `kind: "shell"` intent
  - Unit tests:
    - `pluginId` and `supportedKinds` values
    - `createOutputParser()` returns functional no-op parser

## Phase 5: Validation

- [ ] T007 Verify zero caller changes and all existing tests pass
  - Run full orchestrator test suite: `pnpm --filter @generacy-ai/orchestrator test`
  - Verify `packages/orchestrator/src/index.ts` does NOT export launcher module
  - Verify no modifications to existing spawn callers via `git diff develop -- packages/orchestrator/src/worker/ packages/orchestrator/src/conversation/` (excluding boot registration in claude-cli-worker.ts)

## Dependencies & Execution Order

```
T001 (types) ──────────┬──> T002 (AgentLauncher)
                       │
                       └──> T003 (GenericSubprocessPlugin) [P with T002]
                               │
T002 + T003 ───────────────> T004 (boot registration)
                               │
T004 ──────────────────┬──> T005 (launcher tests)
                       │
                       └──> T006 (plugin tests) [P with T005]
                               │
T005 + T006 ───────────────> T007 (validation)
```

**Parallel opportunities**:
- T002 and T003 can run in parallel (different files, no shared dependencies beyond types)
- T005 and T006 can run in parallel (different test files, independent test targets)

**Phase boundaries** (sequential):
- Phase 1 (types) → Phase 2 (core) → Phase 3 (boot) → Phase 4 (tests) → Phase 5 (validation)
