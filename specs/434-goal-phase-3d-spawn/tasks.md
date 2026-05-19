# Tasks: Migrate cli-spawner shell validators to AgentLauncher

**Input**: Design documents from `/specs/434-goal-phase-3d-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Source Migration

- [ ] T001 [US1] Add optional `agentLauncher` parameter to `CliSpawner` constructor
  - File: `packages/orchestrator/src/worker/cli-spawner.ts` (line 24-28)
  - Add `import type { AgentLauncher } from '../launcher/agent-launcher.js'`
  - Add `private readonly agentLauncher?: AgentLauncher` as 4th constructor param
  - Pattern: matches SubprocessAgency migration (#429)

- [ ] T002 [US1] Migrate `runValidatePhase` to route through `agentLauncher.launch()`
  - File: `packages/orchestrator/src/worker/cli-spawner.ts` (lines 89-108)
  - Replace `this.processFactory.spawn('sh', ['-c', validateCommand], ...)` with:
    ```
    const handle = this.agentLauncher.launch({ intent: { kind: 'shell', command: validateCommand }, cwd: checkoutPath });
    const child = handle.process;
    ```
  - Guard with `if (this.agentLauncher)` — fall back to direct spawn when absent
  - Keep `manageProcess()` call unchanged

- [ ] T003 [US1] Migrate `runPreValidateInstall` to route through `agentLauncher.launch()`
  - File: `packages/orchestrator/src/worker/cli-spawner.ts` (lines 116-135)
  - Same pattern as T002: `agentLauncher.launch({ intent: { kind: 'shell', command: installCommand }, cwd: checkoutPath })`
  - Guard with `if (this.agentLauncher)` fallback
  - Keep `manageProcess()` call unchanged

## Phase 2: Test Updates

- [ ] T004 [US2] Wire mock `AgentLauncher` into existing `cli-spawner.test.ts` setup
  - File: `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts`
  - Create a mock `AgentLauncher` that returns `{ process: mockHandle, outputParser: noopParser, metadata: {...} }`
  - Pass mock launcher as 4th param to `new CliSpawner(factory, mockLogger, 50, mockLauncher)`
  - Existing `runValidatePhase` and `runPreValidateInstall` tests (lines 307-413) must pass unchanged

- [ ] T005 [P] [US2] Add snapshot tests for launcher-routed shell commands
  - File: `packages/orchestrator/src/worker/__tests__/cli-spawner-snapshot.test.ts`
  - Add new `describe` block for `runValidatePhase` and `runPreValidateInstall` snapshots
  - Wire `RecordingProcessFactory` through `AgentLauncher` + `GenericSubprocessPlugin`
  - Use `normalizeSpawnRecords()` to verify composed `sh -c` commands are byte-identical
  - Two snapshot cases: validate command (`pnpm test && pnpm build`) and install command (`pnpm install`)

## Phase 3: Wiring & Verification

- [ ] T006 [US1] Pass `agentLauncher` to `CliSpawner` in `claude-cli-worker.ts`
  - File: `packages/orchestrator/src/worker/claude-cli-worker.ts` (near line 96)
  - The `AgentLauncher` instance already exists at `this.agentLauncher` (line 96)
  - Pass it to `CliSpawner` constructor: `new CliSpawner(this.processFactory, this.logger, config.shutdownGracePeriodMs, this.agentLauncher)`

- [ ] T007 [US2] Run full test suite and verify no regressions
  - Run `pnpm -F orchestrator test` — all existing tests must pass
  - Verify snapshot files are created/updated for new snapshot tests
  - Confirm zero direct `processFactory.spawn('sh', ...)` calls remain in `runValidatePhase`/`runPreValidateInstall` when launcher is present

## Dependencies & Execution Order

```
T001 ──→ T002 ──→ T003 ──→ T004 ──→ T006 ──→ T007
                            ↑
                    T005 ───┘ (parallel with T004, joins at T006)
```

- **T001** must come first (constructor change is prerequisite for all other tasks)
- **T002, T003** are sequential (same file, same pattern — easier to review in order)
- **T004, T005** can run in parallel (different test files, independent concerns)
- **T006** depends on T001-T004 (wiring requires both source and test changes)
- **T007** is the final gate (runs all tests to confirm no regressions)

**Parallel opportunities**: T004 and T005 are independent and can be done simultaneously.
