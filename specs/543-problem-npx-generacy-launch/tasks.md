# Tasks: Fix launch CLI scaffolder to produce working multi-service compose

**Input**: Design documents from `/specs/543-problem-npx-generacy-launch/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Shared Scaffolder — Core Functions

- [X] T001 Extend `ScaffoldComposeInput` interface with new fields (`orgId`, `workers`, `channel`, `repoUrl`, `claudeConfigMode`) in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`
- [X] T002 Add `ScaffoldEnvInput` interface in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`
- [X] T003 Implement `deriveRelayUrl(cloudUrl, projectId)` helper in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — converts `https://X` to `wss://X/relay?projectId=<id>`, `http://X` to `ws://X/relay?projectId=<id>`
- [X] T004 Rewrite `scaffoldDockerCompose()` to emit multi-service compose (orchestrator + worker + redis) in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — remove single `cluster` service, add three services with correct `command:`, volumes, tmpfs, healthchecks, depends_on, env_file, stop_grace_period, extra_hosts, networks; handle `claudeConfigMode` ('bind' vs 'volume') for claude config volume; handle port binding (ephemeral for local, fixed for cloud)
- [X] T005 Implement `scaffoldEnvFile(dir, input)` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — writes `.env` with identity vars (using `deriveRelayUrl()` for `GENERACY_CLOUD_URL`), project vars, and runtime defaults

## Phase 2: Launch & Deploy Callers

- [X] T006 [P] Add `preCreateClaudeJson()` in `packages/generacy/src/cli/commands/launch/scaffolder.ts` — creates `~/.claude.json` with `{}` if it doesn't exist
- [X] T007 [P] Update `scaffoldProject()` in `packages/generacy/src/cli/commands/launch/scaffolder.ts` — pass new fields (`orgId`, `channel`, `workers`, `repoUrl`, `claudeConfigMode: 'bind'`) to `scaffoldDockerCompose()`, call `scaffoldEnvFile()`, call `preCreateClaudeJson()`
- [X] T008 [P] Update `scaffoldBundle()` in `packages/generacy/src/cli/commands/deploy/scaffolder.ts` — pass new fields (`orgId`, `channel`, `workers`, `repoUrl`, `claudeConfigMode: 'volume'`, `deploymentMode: 'cloud'`) to `scaffoldDockerCompose()`, call `scaffoldEnvFile()`
- [X] T009 Verify `launch/index.ts` — no changes expected (delegates to `scaffoldProject()`), but confirm the flow calls `scaffoldProject()` before `pullImage()`/`startCluster()`

## Phase 3: Tests

- [X] T010 [P] Rewrite `scaffoldDockerCompose` tests in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` — verify three services (orchestrator, worker, redis), correct `command:` overrides, volume mounts (including docker socket at `/var/run/docker-host.sock`), tmpfs mounts, healthchecks, depends_on chain, env_file references, networks block, stop_grace_period, extra_hosts; verify bind-mount mode for claude config vs named volume mode; verify port binding modes
- [X] T011 [P] Add `scaffoldEnvFile` tests in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` — verify complete variable set, relay URL derivation (wss path), default values
- [X] T012 [P] Add `deriveRelayUrl` tests in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` — https→wss, http→ws, trailing slash handling, localhost case
- [X] T013 [P] Update launch `scaffoldProject` tests in `packages/generacy/src/cli/commands/launch/__tests__/scaffolder.test.ts` — verify `.env` file is generated alongside compose, verify multi-service compose structure (not single `cluster` service), verify `preCreateClaudeJson()` behavior, update existing assertions that reference `services.cluster` to reference `services.orchestrator`
- [X] T014 Run full test suite (`pnpm test`) and fix any regressions

## Dependencies & Execution Order

**Phase 1** (sequential within phase):
- T001 + T002 first (interface definitions)
- T003 next (helper used by T004 and T005)
- T004 + T005 can run in parallel after T003

**Phase 2** (after Phase 1):
- T006, T007, T008 can all run in parallel (different files)
- T009 is a verification step, can run in parallel with T006-T008

**Phase 3** (after Phase 2):
- T010, T011, T012, T013 can all run in parallel (test files)
- T014 runs last (integration gate)

**Total**: 14 tasks across 3 phases, with 10 parallelizable tasks.
