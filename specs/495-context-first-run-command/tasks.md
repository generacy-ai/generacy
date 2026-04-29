# Tasks: CLI Launch Command (Claim-Code First-Run Flow)

**Input**: Design documents from `/specs/495-context-first-run-command/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Command Skeleton

- [ ] T001 [US1] Create `packages/generacy/src/cli/commands/launch/types.ts` — Define `LaunchOptions`, `LaunchConfig`, `LaunchConfigSchema` (Zod), `ClusterRegistryEntry`, `ClusterMetadata`, `ClusterYaml` types per data-model.md
- [ ] T002 [P] [US1] Create `packages/generacy/src/cli/commands/launch/prompts.ts` — Interactive prompts using `@clack/prompts`: `promptClaimCode()` (text input), `confirmDirectory()` (confirm). Guard with `isCancel()`. Follow `init/prompts.ts` pattern
- [ ] T003 [US1] Create `packages/generacy/src/cli/commands/launch/index.ts` — Register `launch` command with Commander.js: `--claim <code>`, `--dir <path>` options. Wire main orchestration flow skeleton (validation, fetch, scaffold, compose, browser, registry). Include Node >=20 check and Docker reachability check (reuse pattern from `doctor/checks/docker.ts`)
- [ ] T004 [US1] Modify `packages/generacy/src/cli/index.ts` — Import and register the `launch` command alongside existing commands

## Phase 2: Cloud API Client

- [ ] T005 [US1] Create `packages/generacy/src/cli/commands/launch/cloud-client.ts` — Implement `fetchLaunchConfig(cloudUrl, claimCode)` using `node:https`/`node:http`. Validate response with `LaunchConfigSchema`. Support stub mode via `GENERACY_LAUNCH_STUB=1` env var returning hardcoded fixture response per research.md
- [ ] T006 [P] [US1] Create `packages/generacy/src/cli/commands/launch/__tests__/cloud-client.test.ts` — Unit tests: successful fetch + Zod validation, stub mode, invalid/expired claim code (4xx), network error, malformed JSON response

## Phase 3: Scaffolding

- [ ] T007 [US1] [US2] Create `packages/generacy/src/cli/commands/launch/scaffolder.ts` — Implement `scaffoldProject(projectDir, config)`: create `.generacy/` dir, write `cluster.yaml` (YAML via `yaml` package), `cluster.json` (JSON), `docker-compose.yml` (YAML template with interpolated values from LaunchConfig). Determine project dir: default `~/Generacy/<projectName>`, `--dir` override. Check directory doesn't already contain `.generacy/`
- [ ] T008 [P] [US1] [US2] Create `packages/generacy/src/cli/commands/launch/__tests__/scaffolder.test.ts` — Unit tests: default directory resolution, `--dir` override, all three config files written with correct content, directory-already-exists error, `.generacy/` already-exists error

## Phase 4: Docker Compose & Browser

- [ ] T009 [US1] Create `packages/generacy/src/cli/commands/launch/compose.ts` — Implement `pullImage(projectDir)`, `startCluster(projectDir)`, `streamLogsUntilActivation(projectDir)`. Use `child_process.spawn` for log streaming; match `/Go to:\s+(https?:\/\/\S+)/` and `/Enter code:\s+(\S+)/` patterns. Timeout after 120s with helpful error. Use `@clack/prompts` spinner for pull/up steps
- [ ] T010 [P] [US1] Create `packages/generacy/src/cli/commands/launch/browser.ts` — Implement `openBrowser(url)`: `open <url>` on macOS, `start "" "<url>"` on Windows (via `child_process.exec`), print URL with instructions on Linux. Detect platform via `process.platform`
- [ ] T011 [P] [US1] Create `packages/generacy/src/cli/commands/launch/__tests__/compose.test.ts` — Unit tests: pull success/failure, up success/failure, log stream matches activation URL pattern, log stream timeout, user_code extraction
- [ ] T012 [P] [US1] Create `packages/generacy/src/cli/commands/launch/__tests__/browser.test.ts` — Unit tests: macOS exec `open`, Windows exec `start`, Linux prints URL (mock `process.platform` and `child_process.exec`)

## Phase 5: Cluster Registry

- [ ] T013 [US1] Create `packages/generacy/src/cli/commands/launch/registry.ts` — Implement `registerCluster(entry)`: read `~/.generacy/clusters.json` (or init `[]`), append `ClusterRegistryEntry`, atomic write via temp+rename. Set `createdAt` and `lastSeen` to current ISO 8601 timestamp
- [ ] T014 [P] [US1] Create `packages/generacy/src/cli/commands/launch/__tests__/registry.test.ts` — Unit tests: create new registry file, append to existing, atomic write (verify temp+rename), duplicate clusterId handling, permissions error

## Phase 6: Integration & Error Handling

- [ ] T015 [US1] Wire full orchestration flow in `packages/generacy/src/cli/commands/launch/index.ts` — Connect all modules in sequence: validate → prompt → fetch → scaffold → pull → up → stream → browser → register. Add user-friendly error messages with remediation hints per research.md error table. Wrap each step in try/catch with `@clack/prompts` `log.error()`
- [ ] T016 [US1] Create `packages/generacy/src/cli/commands/launch/__tests__/integration.test.ts` — Integration test: mock cloud server (HTTP fixture), mock Docker CLI, exercise full happy path from command invocation to registry entry. Test error paths: cloud unreachable, invalid claim, Docker not running, pull failure, compose failure, activation timeout

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 must complete first (types used by all other modules)
- T003 depends on T001, T002 (command wires prompts and types)
- T004 depends on T003 (registers the command)
- T005 depends on T001 (uses LaunchConfigSchema)
- T007 depends on T001 (uses LaunchConfig, ClusterYaml types)
- T009 depends on T001 (uses types)
- T013 depends on T001 (uses ClusterRegistryEntry)
- T015 depends on T003-T013 (wires all modules together)
- T016 depends on T015 (tests the full flow)

**Parallel opportunities**:
- T002 and T001 can overlap (prompts don't depend on types at code level, only at integration)
- T005 and T007 can run in parallel after T001 (cloud-client and scaffolder are independent)
- T006 and T008 can run in parallel (independent test files)
- T009 and T010 can run in parallel (compose and browser are independent)
- T011, T012, T013, T014 can all run in parallel (independent test/module files)

**Suggested execution order**:
```
T001 → T002 (parallel) → T003 → T004
           ↓
     T005 + T007 (parallel after T001)
     T006 + T008 (parallel tests)
           ↓
     T009 + T010 (parallel)
     T011 + T012 + T013 + T014 (parallel)
           ↓
         T015 → T016
```
