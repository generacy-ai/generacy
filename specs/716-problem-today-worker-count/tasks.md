# Tasks: workers is per-host; CLI launch picks the count

**Input**: Design documents from `/specs/716-problem-today-worker-count/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (worker-count-resolver, activation-poll-body, scaffolder-env-compose), quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[US1]**: Per-host workers feature (single user story — host-side decision flow)

## Phase 1: Schema & Type Foundations

Lay the protocol/type surface that downstream code depends on. These edits are small but unblock everything else.

- [X] T001 [P] [US1] Extend `LaunchConfigSchema` and `LaunchOptions` in `packages/generacy/src/cli/commands/launch/types.ts` — add optional `tierCap: z.number().int().min(1).optional()` to `LaunchConfigSchema`; add `workers?: number` to the `LaunchOptions` interface. (data-model.md §LaunchConfigSchema, §LaunchOptions)
- [X] T002 [P] [US1] Add `PollRequestSchema` in `packages/activation-client/src/types.ts` — export new `PollRequestSchema = z.object({ device_code, workers: z.number().int().min(1).optional() })` plus `PollRequest` type. (contracts/activation-poll-body.md §Request)
- [X] T003 [P] [US1] Extend `ActivationOptions` in `packages/orchestrator/src/activation/types.ts` — add `initialWorkers?: number` field. (data-model.md §ActivationOptions)

## Phase 2: Activation Client Wire Changes

Thread the optional `workers` field down the poll path. Must precede orchestrator integration (T009).

- [X] T004 [US1] Extend `pollDeviceCode` signature in `packages/activation-client/src/client.ts` — accept optional trailing `workers?: number` arg; build request body conditionally (`{ device_code }` vs `{ device_code, workers }`). (contracts/activation-poll-body.md §Client signature change)
- [X] T005 [US1] Extend `PollOptions` and forward in `packages/activation-client/src/poller.ts` — add `workers?: number` to `PollOptions`; destructure and pass through every `pollDeviceCode` call in the loop. Depends on T002, T004. (contracts/activation-poll-body.md §Poller signature change)

## Phase 3: CLI Launch Prompt & Resolver

The user-facing decision flow. T006 is the new helper module; T007 is the prompt; T008 wires them into `launchAction`.

- [X] T006 [US1] Create `packages/generacy/src/cli/commands/launch/worker-count-resolver.ts` (NEW) — export `CLI_FALLBACK_TIER_CAP = 8`, `SUGGESTED_FROM_HOST = 2`, `WorkerCountResolution` interface, and `resolveWorkerCount(opts, launchConfig, isTTY)` implementing the Q3+Q4+Q5 matrix from data-model.md. Imports `promptWorkerCount` from `./prompts.js`. Depends on T001. (contracts/worker-count-resolver.md §Signature, §Behavior)
- [X] T007 [US1] Add `promptWorkerCount(tierCap, defaultWorkers)` to `packages/generacy/src/cli/commands/launch/prompts.ts` — Clack `p.text` prompt with validator (positive integer, ≤ tierCap); reuse existing `exitIfCancelled`. (contracts/worker-count-resolver.md §promptWorkerCount)
- [X] T008 [US1] Wire resolver into `launchAction` in `packages/generacy/src/cli/commands/launch/index.ts` — register `--workers <N>` Commander option with integer-coerce + validation; compute `isTTY = process.stdout.isTTY === true`; call `resolveWorkerCount`; emit each `resolution.warnings` via `p.log.warn`; try/catch the resolver with `process.exit(1)` on throw; thread `resolution.workerCount` into `scaffoldProject(...)`. Depends on T006, T007. (contracts/worker-count-resolver.md §Caller responsibilities)

## Phase 4: Scaffolder Updates

Propagate the resolved value into `.env` and compose. Includes dropping the three hardcoded `workers: 1` sites.

- [X] T009 [US1] Update `packages/generacy/src/cli/commands/launch/scaffolder.ts` — make `scaffoldProject(projectDir, config, workers: number)` accept the workers param; drop the three hardcoded `1` literals at lines ~73 / ~88 / ~102 (scaffoldClusterYaml, scaffoldDockerCompose, scaffoldEnvFile call sites). (contracts/scaffolder-env-compose.md §Launch wrapper)
- [X] T010 [US1] Update `scaffoldDockerCompose` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — append `'GENERACY_INITIAL_WORKERS=${WORKER_COUNT}'` to the orchestrator service's `environment:` array (symbolic interpolation, not literal value). Preserve existing `worker.deploy.replicas: ${WORKER_COUNT:-1}`. (contracts/scaffolder-env-compose.md §After)

## Phase 5: Orchestrator Activation Integration

Read the env var at boot and thread the value through activation. T012 is the entry point (`server.ts`).

- [X] T011 [US1] Thread `initialWorkers` through `activate()` in `packages/orchestrator/src/activation/index.ts` — accept `options.initialWorkers`, pass to `pollForApproval({ ..., workers: options.initialWorkers })`. Depends on T003, T005. (contracts/activation-poll-body.md §Orchestrator integration)
- [X] T012 [US1] Parse env var and call `activate` in `packages/orchestrator/src/server.ts` — read `process.env['GENERACY_INITIAL_WORKERS']`, `parseInt(value, 10)`, validate positive integer (log warn + drop if invalid), pass as `initialWorkers` to `activate({ ..., initialWorkers })`. Depends on T011. (contracts/activation-poll-body.md §Orchestrator integration §server.ts)

## Phase 6: Tests

Coverage per plan.md §Testing. Vitest only; HTTP client mocked at the `HttpClient` boundary; no live cloud or Docker.

- [X] T013 [P] [US1] Create `packages/generacy/src/cli/commands/launch/__tests__/worker-count-resolver.test.ts` (NEW) — eight-row matrix from contracts/worker-count-resolver.md §Tests; mock `promptWorkerCount` via Vitest module mock for rows 4/5/8. Depends on T006. (contracts/worker-count-resolver.md §Tests)
- [X] T014 [P] [US1] Extend `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` — assert `scaffoldDockerCompose` output contains `GENERACY_INITIAL_WORKERS=${WORKER_COUNT}` for the orchestrator service; assert `scaffoldEnvFile` writes the supplied `workers` value into `WORKER_COUNT=…`. Depends on T010. (contracts/scaffolder-env-compose.md §Tests)
- [X] T015 [P] [US1] Extend `packages/activation-client/tests/client.test.ts` — two new cases on `pollDeviceCode`: (a) omits `workers` from body when undefined; (b) includes `workers` in body when provided. Depends on T004. (contracts/activation-poll-body.md §Tests §client.test.ts)
- [ ] T016 [P] [US1] Extend `packages/orchestrator/tests/unit/activation/index.test.ts` — assert `activate({ initialWorkers: 4 })` calls `pollForApproval` with `expect.objectContaining({ workers: 4 })`. Depends on T011. (contracts/activation-poll-body.md §Tests §index.test.ts)

## Phase 7: Manual Verification & Polish

- [ ] T017 [US1] Walk through `quickstart.md` manual verification — happy path (interactive prompt → `WORKER_COUNT=4` in `.env`, `GENERACY_INITIAL_WORKERS=${WORKER_COUNT}` in compose), `--workers` flag (non-interactive), tier-cap rejection (`--workers=100` exits non-zero), no-TTY default with warning, tier-cap fallback warning under stub mode. Confirm `docker compose --project-directory .generacy config | grep GENERACY_INITIAL_WORKERS` resolves to the literal chosen value. (quickstart.md)

## Dependencies & Execution Order

### Critical path

```
Phase 1 (T001, T002, T003)              ← schema first; parallelizable
  ├─► T004 (client.ts)
  │     └─► T005 (poller.ts) ──┐
  ├─► T006 (resolver) ──► T008 (index.ts) ──► T009 (launch/scaffolder)
  │       ▲
  │       └── T007 (prompts) feeds T006
  └─► T011 (orchestrator/activation/index.ts) ──► T012 (server.ts)
            ▲
            └────────────────────────────────────┘
                                  T010 (cluster/scaffolder.ts) is independent of activation path
```

### Parallel opportunities

**Phase 1** — all three schema tasks are file-disjoint:
- T001, T002, T003 in parallel

**Phase 6 (tests)** — all four test files target different packages:
- T013, T014, T015, T016 in parallel (after their respective implementation tasks land)

**Cross-phase** — once Phase 1 lands, two implementation tracks run in parallel:
- Track A: T004 → T005 (activation-client wire) → T011 → T012 (orchestrator integration)
- Track B: T006 + T007 → T008 (CLI prompt) ; T009 (launch/scaffolder) ; T010 (cluster/scaffolder)

### Sequential constraints

- T008 depends on T006 and T007 (calls resolver and prompt).
- T009 depends on T008 (consumes resolved value).
- T011 depends on T003 (type) and T005 (poller signature).
- T012 depends on T011 (calls `activate` with new field).
- All Phase 6 tests depend on the implementation tasks they cover (listed inline).
- T017 (manual verification) is last.

### Out-of-repo (no tasks generated)

- `cluster-base` companion PR — `entrypoint-orchestrator.sh` first-boot seed of `cluster.local.yaml` from `$GENERACY_INITIAL_WORKERS`.
- `generacy-cloud` companion (#696) — adds `tierCap` to launch-config, reads `workers` from poll body, sets `targetWorkers` on cluster doc, stops rendering `workers:` into `cluster.yaml`.

Both are documented in plan.md §"Out-of-repo companion" and verified manually via the end-to-end quickstart section, but no source files in this repo correspond to them.
