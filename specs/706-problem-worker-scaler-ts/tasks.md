# Tasks: Worker Scaling via Docker Engine API

**Input**: Design documents from `/specs/706-problem-worker-scaler-ts/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/worker-scale-response.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, or FOUND for foundational/shared)

---

## Phase 1: Foundation (DTOs and Engine API Client)

- [X] **T001** [FOUND] Add Engine API DTO type definitions in a new module `packages/control-plane/src/services/docker-engine-types.ts`. Include `ContainerSummary`, `ContainerInspect`, `ContainerCreateBody`, `NetworkConnectBody`, `NetworkEndpoint`, `NetworkEndpointCreate`, `HealthConfig`, `Mount`, and `ContainerState` exactly as specified in `data-model.md` §"Engine API DTOs". Use PascalCase to match Docker's wire format.

- [X] **T002** [FOUND] Add `DockerEngineError` and `DockerDaemonUnavailableError` error classes in `packages/control-plane/src/services/docker-engine-types.ts` (or a sibling `docker-engine-errors.ts` if cleaner). `DockerDaemonUnavailableError.message` must equal `'DOCKER_DAEMON_UNAVAILABLE'` for string-match backward compat in the route handler.

- [X] **T003** [FOUND] Implement `DockerEngineClient` in new file `packages/control-plane/src/services/docker-engine-client.ts`. Hand-rolled `node:http` over Unix socket (pattern: `packages/credhelper-daemon/src/client.ts`). Methods: `listContainers({ filters, all })`, `inspectContainer(id)`, `createContainer(name, config)`, `startContainer(id)`, `stopContainer(id)`, `removeContainer(id, { force })`, `connectNetwork(networkId, body)`. Reads `DOCKER_HOST` env (default `unix:///var/run/docker-host.sock`). Maps `ECONNREFUSED`/`ENOENT` → `DockerDaemonUnavailableError`. Maps non-2xx → `DockerEngineError(statusCode, endpoint, engineMessage)`. ~150 LOC target.

- [X] **T004** [P] [FOUND] Write unit tests in `packages/control-plane/__tests__/services/docker-engine-client.test.ts`. Cover: URL formation for each method (including query-string encoding of `filters` JSON), request body serialization, response parsing for happy path, `ECONNREFUSED` → `DockerDaemonUnavailableError` mapping, non-2xx → `DockerEngineError` with engine message extracted from `{ message }` envelope. Use a stubbed HTTP server on a temp Unix socket or `vi.mock('node:http')`.

---

## Phase 2: Pure Helpers (Container-Number Planning + Config Cloning)
<!-- Phase boundary: T001–T003 must be done so types are importable. T004 may still be in-flight. -->

- [X] **T005** [US2] Implement pure helper `assignContainerNumbers(existing: WorkerReplica[], target: number): ScalePlan` in `packages/control-plane/src/services/worker-scaler.ts` (add alongside rewrite in Phase 3, but land/test it first). Behavior per `research.md` §"Container-number assignment": gap-fill ascending in `[1..max(existing)]`, then append. Scale-down: sort exited (highest-numbered first), then running (highest-numbered first). No-op returns `{ toCreate: [], toRemove: [] }`. (FR-006)

- [X] **T006** [US1] Implement pure helper `cloneInspectToCreate(inspect: ContainerInspect, newNumber: number, newName: string): ContainerCreateBody` in `packages/control-plane/src/services/worker-scaler.ts`. Strip `Hostname`, `Id`, `Created`, `State`, `Status`, `NetworkSettings` (populated form). Keep `Image`, `Cmd`, `Env`, `Entrypoint`, `WorkingDir`, `User`, `Labels` (overwrite `com.docker.compose.container-number` only — preserve `config-hash` per FR-007), `Healthcheck`, `StopSignal`, `StopTimeout`, `ExposedPorts`, all of `HostConfig.*`. Build `NetworkingConfig.EndpointsConfig` with **first network only** from `NetworkSettings.Networks` (insertion order). Throw `Error('SOURCE_REPLICA_HAS_NO_NETWORKS')` if source has zero networks.

- [ ] **T007** [P] [US2] Write unit tests for `assignContainerNumbers` in `packages/control-plane/__tests__/services/worker-scaler.test.ts`. Cases: empty→3 (creates [1,2,3]); [1,2,3]→5 (creates [4,5]); [1,3]→4 (gap-fill creates [2,4]); [1,2,3]→1 (removes 2,3 highest-first); exited at #2, running at [1,3]→1 (removes exited #2 first, then #3); no-op [1,2]→2 returns empty plan. (FR-006, SC-003, SC-011)

- [ ] **T008** [P] [US1] Write unit tests for `cloneInspectToCreate` in `packages/control-plane/__tests__/services/worker-scaler.test.ts`. Cases: single-network source produces single-entry `EndpointsConfig`; multi-network source produces single-entry `EndpointsConfig` with first network only (remaining handled by `connect` in orchestration); zero-network source throws `SOURCE_REPLICA_HAS_NO_NETWORKS`; `container-number` label is overwritten while `config-hash` and `project`/`service` labels are preserved; `Hostname` is stripped. Fixture: realistic inspect JSON for a compose-managed worker.

---

## Phase 3: Worker-Scaler Rewrite (Orchestration + Mutex + Partial-Failure)
<!-- Phase boundary: T001–T006 must be complete (types, client, pure helpers in file). -->

- [X] **T009** [US1] Define `PartialScaleError` class in `packages/control-plane/src/services/worker-scaler.ts` per `data-model.md` §"PartialScaleError". Fields: `requested`, `actual`, `cause`. Override `name = 'PartialScaleError'` for route-handler discrimination.

- [X] **T010** [US1] Implement `computeProjectName(client)` helper in `packages/control-plane/src/services/worker-scaler.ts`. Inspect orchestrator's own container by `os.hostname()`; read `com.docker.compose.project` label. Fallback to `COMPOSE_PROJECT_NAME` env var. Throws `Error('ORCHESTRATOR_NOT_COMPOSE_MANAGED')` if neither resolves. (plan.md Risks §2)

- [X] **T011** [US1] Implement `enumerateWorkers(client, project)` helper. `GET /containers/json?all=true` filtered by labels `com.docker.compose.project=<project>` and `com.docker.compose.service=worker`. Map each summary to `WorkerReplica` (id, parsed number from `com.docker.compose.container-number` label, name from `Names[0]`, state, `networkIds` from `NetworkSettings.Networks` in insertion order). Skip containers with missing/non-numeric number label and `console.warn`. (FR-002, data-model.md §Validation rules)

- [X] **T012** [US1] Implement `scaleUp(client, project, source, toCreate)`. For each new number in `toCreate`: build name `<project>-worker-<n>`, call `cloneInspectToCreate`, `POST /containers/create` with first-network in `NetworkingConfig`, then iterate `source.NetworkSettings.Networks` (skip the first one already attached) calling `POST /networks/<id>/connect` per remaining network, then `POST /containers/<id>/start`. On any error, **stop the loop** and return `{ created: number[], failed: { number, error } }`. Do NOT roll back already-created replicas. (FR-003, FR-012, Q1=A, Q2=B)

- [X] **T013** [US1] Implement `scaleDown(client, toRemoveIds)` helper. For each ID (already in correct retire order from `assignContainerNumbers`): `POST /containers/<id>/stop` then `DELETE /containers/<id>`. On error, stop and return `{ removed: string[], failed: { id, error } }`. (FR-004)

- [X] **T014** [US2] Implement gap-fill name-collision handler. Before `POST /containers/create` for a target slot, if a stopped/exited container exists with the conflicting name `<project>-worker-<n>`, call `DELETE /containers/<id>?force=true` first. This is an edge case after manual `docker rm`; normal operation never triggers it because exited replicas are counted (FR-002). (FR-015, Q5=A)

- [X] **T015** [US1] Implement module-level async mutex in `packages/control-plane/src/services/worker-scaler.ts`. Promise-chain pattern from `research.md` §"In-process mutex": `let inflight: Promise<unknown> = Promise.resolve();` and `await previous; try { … } finally { resolveNext(undefined); }` wrapper. (FR-014, Q4=A)

- [X] **T016** [US1] Rewrite the main `scaleWorkers(opts: ScaleOptions): Promise<ScaleResult>` export in `packages/control-plane/src/services/worker-scaler.ts`. Drop `execDockerScale`, `spawn('docker', …)`, and stderr parsing. Drop `.env` `WORKER_COUNT` read AND write (FR-010). Flow inside mutex: instantiate `DockerEngineClient` → `computeProjectName` → `enumerateWorkers` → if `requested === current`, return no-op `ScaleResult` with no Engine mutations, no `cluster.yaml` write, no metadata refresh → else `assignContainerNumbers` → if `toCreate.length > 0`: inspect first existing replica as source, call `scaleUp` → if `toRemove.length > 0`: call `scaleDown` → compute `actualCount = previousCount + created.length - removed.length` → if `actualCount > 0` and progress was made: write `cluster.yaml` atomically (preserved logic), fire `/internal/refresh-metadata` → on any partial result, throw `PartialScaleError(requested, actual, cause)` → on full failure (zero created on a scale-up, or zero removed on a scale-down), throw plain `Error` and do NOT write `cluster.yaml` or fire metadata refresh. (FR-001, FR-008, FR-009, FR-012)

- [X] **T017** [US1] Add a code comment in `packages/control-plane/src/services/worker-scaler.ts` documenting the "stale clone" drift case: if the user edits the host compose file and rebuilds without `docker compose up -d`, scale-up clones a stale source replica's config — same behavior as compose itself. (FR-013)

---

## Phase 4: Route Wiring (Lifecycle + Schemas)
<!-- Phase boundary: T009, T016 must be complete (PartialScaleError and rewritten scaleWorkers are importable). -->

- [X] **T018** [US1] Extend `WorkerScaleSuccessResponseSchema` in `packages/control-plane/src/schemas.ts` (or wherever it currently lives) with `actualCount: z.number().int().min(0)`. Add `WorkerScalePartialResponseSchema` per `contracts/worker-scale-response.md` §"Partial Scale Failure": fields `partial: z.literal(true)`, `actualCount`, `error: { code: z.literal('PARTIAL_SCALE'), message: z.string() }`. Backward-compatible (additive fields).

- [X] **T019** [US1] Update `worker-scale` branch in `packages/control-plane/src/routes/lifecycle.ts`. Map `PartialScaleError` (catch by `error.name === 'PartialScaleError'`) to `200 OK` with `partial: true`, `requestedCount`, `actualCount`, `error: { code: 'PARTIAL_SCALE', message }`. Map `DockerDaemonUnavailableError` (or message string `DOCKER_DAEMON_UNAVAILABLE`) to `503` with `code: 'DOCKER_DAEMON_UNAVAILABLE'` (renamed from `DOCKER_CLI_UNAVAILABLE`). Other errors → existing `500 INTERNAL_ERROR` envelope. Include `previousCount` and `actualCount` in success body. (contracts/worker-scale-response.md)

---

## Phase 5: Tests (Orchestration + Route + Concurrency + Partial-Failure)
<!-- Phase boundary: T016, T019 must be complete. Test tasks are mostly independent of each other and parallelizable. -->

- [ ] **T020** [P] [US1] Rewrite `packages/control-plane/__tests__/services/worker-scaler.test.ts` orchestration cases. Drop spawn mock; mock `DockerEngineClient`. Cases: 1→3 scale-up (one source replica, two creates, networks attached); gap-fill scale-up ([1,3]→4 creates [2,4]); 3→1 scale-down (highest-numbered removed); no-op (no Engine calls, no `cluster.yaml` write); multi-network source (each new replica gets `create` + `connect` per extra network + `start`). (SC-001, SC-002, SC-008)

- [ ] **T021** [P] [US1] Add partial-failure test to `packages/control-plane/__tests__/services/worker-scaler.test.ts`: mock `createContainer` to fail on the 3rd call of a 1→5 scale. Assert `PartialScaleError` is thrown with `requested === 5`, `actual === 3`. Assert `cluster.yaml` written with `workers: 3`. Assert metadata refresh fired. (SC-009, FR-012)

- [ ] **T022** [P] [US1] Add full-failure test to `packages/control-plane/__tests__/services/worker-scaler.test.ts`: mock `createContainer` to fail on the 1st call. Assert a plain `Error` (not `PartialScaleError`) is thrown. Assert `cluster.yaml` was NOT written. Assert metadata refresh was NOT fired. (FR-012)

- [ ] **T023** [P] [US2] Add exited-replica counting test to `packages/control-plane/__tests__/services/worker-scaler.test.ts`. Fixture: one exited at #2, two running at [1,3]. On scale-down to 1, assert the exited #2 is removed first, then running #3. On scale-up to 4, assert gap-fill targets [4] (no collision on #2 because it's counted as existing). (SC-011, FR-002, Q3=A)

- [ ] **T024** [P] [US1] Add concurrency test to `packages/control-plane/__tests__/services/worker-scaler.test.ts`. Fire two `scaleWorkers({ count: 3 })` and `scaleWorkers({ count: 5 })` calls in parallel (no `await` between). Assert the second call observes the first call's `actualCount` as its `previousCount`. Assert no duplicate `container-number` in any `createContainer` call. (SC-010, FR-014)

- [ ] **T025** [P] [US2] Add gap-fill name-collision test to `packages/control-plane/__tests__/services/worker-scaler.test.ts`. Fixture: stopped container holds name `<project>-worker-2` (simulating manual `docker rm` followed by `docker create`). Scale-up to fill slot 2: assert `DELETE /containers/<id>?force=true` is called before `POST /containers/create`. (FR-015, Q5=A)

- [ ] **T026** [P] [US1] Update `packages/control-plane/__tests__/routes/lifecycle-worker-scale.test.ts`. Drop the `DOCKER_CLI_UNAVAILABLE` case. Add `DOCKER_DAEMON_UNAVAILABLE` → 503 case. Add partial-failure case: stubbed `scaleWorkers` throws `PartialScaleError(5, 3, cause)`, assert 200 OK with `partial: true`, `actualCount: 3`, `error.code: 'PARTIAL_SCALE'`. Add success case includes `actualCount` field in response body. (contracts/worker-scale-response.md)

---

## Phase 6: Validation
<!-- Phase boundary: All prior phases complete. Runtime/manual validation against a real cluster. -->

- [ ] **T027** [US2] Code audit per SC-007: grep `packages/control-plane/src/services/worker-scaler.ts` for any `spawn`, `exec`, or shell-out to `docker`. Should return zero matches. Also grep for any read of `.env` or `WORKER_COUNT` in this file — should also be zero.

- [ ] **T028** [US1] Manual smoke test per SC-001/SC-002 (per `quickstart.md`): launch a cluster via `npx generacy launch`, send `PATCH /workers count: 3` from the cloud UI, verify 3 worker containers via `docker compose ps` on the host with correct `com.docker.compose.container-number` labels. Then `PATCH /workers count: 1`, verify only worker-1 remains. Then verify `cluster.yaml.workers === 1`.

---

## Dependencies & Execution Order

**Sequential phase boundaries**:
- **Phase 1** (T001–T004): Foundation — types, client, client tests. T004 (tests) is independent of T005+.
- **Phase 2** (T005–T008): Pure helpers — depend on Phase 1 types being importable. T007 and T008 (tests) are independent of Phase 3.
- **Phase 3** (T009–T017): Worker-scaler rewrite — depends on Phase 1 (client) and Phase 2 (helpers). Tasks within are largely sequential since they all edit the same file (`worker-scaler.ts`).
- **Phase 4** (T018–T019): Route wiring — depends on `PartialScaleError` (T009) and rewritten `scaleWorkers` (T016) being importable.
- **Phase 5** (T020–T026): Tests — depends on Phase 3 (scaler) and Phase 4 (route) complete. All test tasks are parallel-eligible (different test cases, mocks isolated).
- **Phase 6** (T027–T028): Validation — final.

**Parallel opportunities** (run together within a phase):
- T003 + T004 sequentially (T004 tests T003). T001/T002 can be combined into one PR with T003.
- T005 + T006 are sequential within the same file; T007 + T008 (their tests) are parallel.
- T020, T021, T022, T023, T024, T025, T026 are all parallel-eligible test additions.

**Critical path**: T001 → T002 → T003 → T005 → T006 → T009 → T010 → T011 → T012 → T013 → T015 → T016 → T018 → T019 → T028.

**File-coupling notes**:
- T005, T006, T009–T017 all edit `packages/control-plane/src/services/worker-scaler.ts` (the rewrite). Sequence them as listed.
- T020–T025 all edit `packages/control-plane/__tests__/services/worker-scaler.test.ts`. They can be added in parallel branches but final merge is sequential.
- T026 edits `packages/control-plane/__tests__/routes/lifecycle-worker-scale.test.ts` — fully independent.
