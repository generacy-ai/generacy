# Tasks: CLI Cluster Lifecycle Commands

**Input**: Design documents from `/specs/494-context-implement-cluster/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story / command this task belongs to

## Phase 1: Types & Shared Helpers

- [ ] T001 Create Zod schemas and TypeScript types in `commands/cluster/context.ts` — `ClusterYamlSchema`, `ClusterJsonSchema`, `ClusterContext` interface, exported types (`packages/generacy/src/cli/commands/cluster/context.ts`)
- [ ] T002 [P] Implement `ensureDocker()` in `commands/cluster/docker.ts` — run `docker compose version` via `execSafe`, throw user-friendly errors for missing Docker/Compose or stopped daemon (`packages/generacy/src/cli/commands/cluster/docker.ts`)
- [ ] T003 Implement `getClusterContext(cwd?)` in `commands/cluster/context.ts` — walk upward from `cwd` to find `.generacy/cluster.yaml`, parse YAML + optional `cluster.json`, compute `projectName` with dirname fallback, throw on missing cluster (`packages/generacy/src/cli/commands/cluster/context.ts`)
- [ ] T004 [P] Implement `dockerComposeArgs()` and `runCompose()` in `commands/cluster/compose.ts` — build `--project-name` / `--file` args, execute via `execSafe` (`packages/generacy/src/cli/commands/cluster/compose.ts`)
- [ ] T005 [P] Implement registry CRUD in `commands/cluster/registry.ts` — `RegistryEntrySchema`, `readRegistry()`, `writeRegistry()`, `upsertRegistryEntry()`, `removeRegistryEntry()`, atomic writes via temp+rename (`packages/generacy/src/cli/commands/cluster/registry.ts`)
- [ ] T006 [P] Unit tests for `docker.ts` — mock `execSafe` to simulate Docker present/missing/daemon-stopped (`packages/generacy/src/cli/commands/cluster/__tests__/docker.test.ts`)
- [ ] T007 [P] Unit tests for `context.ts` — temp dirs with fixture `.generacy/`, test upward walk, missing cluster.yaml, missing cluster.json fallback (`packages/generacy/src/cli/commands/cluster/__tests__/context.test.ts`)
- [ ] T008 [P] Unit tests for `compose.ts` — verify arg construction, mock `execSafe` for `runCompose` (`packages/generacy/src/cli/commands/cluster/__tests__/compose.test.ts`)
- [ ] T009 [P] Unit tests for `registry.ts` — temp home dir, test read/write/upsert/remove, atomic write behavior, empty registry bootstrap (`packages/generacy/src/cli/commands/cluster/__tests__/registry.test.ts`)

## Phase 2: Command Implementations

- [ ] T010 Create test fixtures in `commands/cluster/__tests__/fixtures/` — minimal `cluster.yaml`, `cluster.json`, `docker-compose.yml` (alpine sleep container for CI)
- [ ] T011 [up] Implement `up` command in `commands/up/index.ts` — `ensureDocker()`, `getClusterContext()`, `runCompose(ctx, ['up', '-d'])`, `upsertRegistryEntry()`, update `lastSeen` (`packages/generacy/src/cli/commands/up/index.ts`)
- [ ] T012 [P] [stop] Implement `stop` command in `commands/stop/index.ts` — `ensureDocker()`, `getClusterContext()`, `runCompose(ctx, ['stop'])` (`packages/generacy/src/cli/commands/stop/index.ts`)
- [ ] T013 [P] [down] Implement `down` command in `commands/down/index.ts` — `--volumes` option, `ensureDocker()`, `getClusterContext()`, `runCompose(ctx, ['down', ...volumeFlag])` (`packages/generacy/src/cli/commands/down/index.ts`)
- [ ] T014 [destroy] Implement `destroy` command in `commands/destroy/index.ts` — `--yes` flag, `p.confirm()` prompt, `runCompose(ctx, ['down', '-v'])`, `rm -rf .generacy/`, `removeRegistryEntry()` (`packages/generacy/src/cli/commands/destroy/index.ts`)
- [ ] T015 [status] Implement `status` command in `commands/status/index.ts` — read registry, query `docker compose ps --format json` per cluster, derive state (running/stopped/partial/missing) (`packages/generacy/src/cli/commands/status/index.ts`)
- [ ] T016 [status] Implement status formatter in `commands/status/formatter.ts` — table output (default) and JSON output (`--json` flag), `ClusterStatusSchema` validation (`packages/generacy/src/cli/commands/status/formatter.ts`)
- [ ] T017 [P] [update] Implement `update` command in `commands/update/index.ts` — `ensureDocker()`, `getClusterContext()`, `runCompose(ctx, ['pull'])` then `runCompose(ctx, ['up', '-d'])`, `upsertRegistryEntry()` (`packages/generacy/src/cli/commands/update/index.ts`)

## Phase 3: CLI Registration & Testing

- [ ] T018 Register all 6 commands in CLI entry point — add `upCommand()`, `stopCommand()`, `downCommand()`, `destroyCommand()`, `statusCommand()`, `updateCommand()` to `program.addCommand()` in `packages/generacy/src/cli/index.ts`
- [ ] T019 [P] Tests for `up` command — mock compose/registry, verify `up -d` args and registry upsert (`packages/generacy/src/cli/commands/up/__tests__/up.test.ts`)
- [ ] T020 [P] Tests for `stop` command — mock compose, verify `stop` args (`packages/generacy/src/cli/commands/stop/__tests__/stop.test.ts`)
- [ ] T021 [P] Tests for `down` command — mock compose, verify `down` args with/without `--volumes` (`packages/generacy/src/cli/commands/down/__tests__/down.test.ts`)
- [ ] T022 [P] Tests for `destroy` command — mock compose/prompts/fs, verify prompt skip with `--yes`, registry removal, `.generacy/` deletion (`packages/generacy/src/cli/commands/destroy/__tests__/destroy.test.ts`)
- [ ] T023 [P] Tests for `status` command and formatter — mock registry + compose ps, verify table and JSON output, state derivation logic (`packages/generacy/src/cli/commands/status/__tests__/status.test.ts`, `packages/generacy/src/cli/commands/status/__tests__/formatter.test.ts`)
- [ ] T024 [P] Tests for `update` command — mock compose, verify pull then up sequence, registry update (`packages/generacy/src/cli/commands/update/__tests__/update.test.ts`)

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 (shared helpers) must complete before Phase 2 (commands use helpers)
- Phase 2 (commands) must complete before Phase 3 (registration + command tests)

**Within Phase 1**:
- T001 (types/schemas) must come first — T003, T005 depend on it
- T002, T004, T005 can run in parallel after T001
- T003 depends on T001 (uses schemas)
- T006-T009 (helper tests) can all run in parallel, each depends only on its corresponding implementation task

**Within Phase 2**:
- T010 (fixtures) should come first
- T011 (up) is a good first command — establishes the pattern
- T012, T013, T017 can run in parallel (simple compose wrappers)
- T014 (destroy) depends on registry remove from T005
- T015, T016 (status) depend on registry read from T005

**Within Phase 3**:
- T018 (registration) should come first — commands must be wired before testing
- T019-T024 (command tests) can all run in parallel

**Parallel opportunities**: 12 of 24 tasks are marked `[P]`, representing ~50% parallelization potential.
