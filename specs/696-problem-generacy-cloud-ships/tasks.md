# Tasks: Worker Scale Lifecycle Action

**Input**: Design documents from `/specs/696-problem-generacy-cloud-ships/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema & Type Updates

- [ ] T001 [US1] Add `'worker-scale'` to `LifecycleActionSchema` enum in `packages/control-plane/src/schemas.ts:38-49`
- [ ] T002 [US1] Add `WorkerScaleBodySchema` (`z.object({ count: z.number().int().min(1) })`) and export type in `packages/control-plane/src/schemas.ts`
- [ ] T003 [P] [US1] Rename `workerCount` → `workers` in `ClusterMetadataPayload` interface at `packages/orchestrator/src/types/relay.ts:249`
- [ ] T004 [P] [US1] Fix `readClusterYaml()` in `packages/orchestrator/src/services/relay-bridge.ts:608-623` to read `parsed?.workers` instead of `parsed?.workerCount`
- [ ] T005 [US1] Update `collectMetadata()` in `packages/orchestrator/src/services/relay-bridge.ts:545-551` to set `metadata.workers` instead of `metadata.workerCount`
- [ ] T006 [P] [US1] Update `packages/cluster-relay/src/metadata.ts:19,64-80` to use `workers` instead of `workerCount` in `fetchMetrics()` and `collectMetadata()`

## Phase 2: Orchestrator Refresh-Metadata Endpoint

- [ ] T007 [US1] Create `packages/orchestrator/src/routes/internal-refresh-metadata.ts` — `setupInternalRefreshMetadataRoute(server, getRelayBridge)` handler; POST returns 200 `{ accepted: true }` or 503 if bridge not ready; follows `internal-relay-events.ts:20-54` pattern
- [ ] T008 [US1] Register `/internal/refresh-metadata` route in `packages/orchestrator/src/server.ts` before `server.listen()` using deferred binding pattern (lines 322-336); gate with `ORCHESTRATOR_INTERNAL_API_KEY`; pass getter for relay bridge ref

## Phase 3: Worker-Scale Service & Handler

- [ ] T009 [US1] Create `packages/control-plane/src/services/worker-scaler.ts` with `scaleWorkers(options)` function: resolve `.generacy/` dir via `resolveGeneracyDir()`, read current `WORKER_COUNT` from `.env`, update `.env` atomically, update `cluster.yaml` `workers` field atomically, exec `docker compose up -d --scale worker=<n>`, trigger metadata refresh via `POST /internal/refresh-metadata`
- [ ] T010 [US1] Wire `worker-scale` handler in `packages/control-plane/src/routes/lifecycle.ts` — parse body with `WorkerScaleBodySchema`, call `scaleWorkers()`, return `{ accepted: true, action: 'worker-scale', previousCount, requestedCount }`; handle `DOCKER_CLI_UNAVAILABLE` error gracefully

## Phase 4: Tests

- [ ] T011 [P] [US1] Unit tests for `worker-scaler.ts` — test `.env` parsing/update (existing line, missing line, append), `cluster.yaml` update, docker compose spawn (stubbed `child_process`), metadata refresh trigger (stubbed HTTP)
- [ ] T012 [P] [US1] Integration test for lifecycle handler `worker-scale` action — stub `scaleWorkers()`, verify request validation (count < 1 rejected, non-integer rejected, valid count accepted), verify response shape
- [ ] T013 [P] [US1] Unit test for `/internal/refresh-metadata` endpoint — verify 503 when relay bridge not ready, 200 when bridge available, verify `sendMetadata()` called
- [ ] T014 [US1] Run full test suite to verify no regressions in existing lifecycle tests

## Dependencies & Execution Order

**Phase 1** (schema/type changes):
- T001, T002 can run together (same file, additive)
- T003, T004, T006 are parallel (different packages, no shared state)
- T005 depends on T003 (uses renamed type) and T004 (uses renamed return value)

**Phase 2** (orchestrator endpoint):
- T007 has no dependency on Phase 1 (independent package)
- T008 depends on T007 (registers route created in T007)
- T007 can run in parallel with Phase 1 tasks

**Phase 3** (core implementation):
- T009 depends on T001, T002 (uses new schema), T007 (calls refresh endpoint)
- T010 depends on T009 (wires the service)

**Phase 4** (tests):
- T011, T012, T013 are parallel (test different units)
- T014 runs last (full regression check)

**Critical path**: T001/T002 → T009 → T010 → T014
