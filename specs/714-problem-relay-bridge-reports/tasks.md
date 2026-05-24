# Tasks: Report actual worker container count in relay metadata

**Input**: Design documents from `/specs/714-problem-relay-bridge-reports/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md, research.md, data-model.md, contracts/docker-events-subscription.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story / acceptance criterion this task supports (US1 = "tile reports actual"; US2 = "tile updates within ~10s")

## Phase 1: Helper Extraction (control-plane)

Pure-move refactor per clarification C2. No behavioral change in `worker-scaler.ts`. Must land before Phase 3 imports anything from the new module.

- [X] T001 [US1] Create `packages/control-plane/src/services/worker-enumeration.ts` containing the moved bodies of `WorkerReplica` (type), `computeProjectName(client)`, and `enumerateWorkers(client, project)`. Copy verbatim from `worker-scaler.ts`; preserve the `ORCHESTRATOR_NOT_COMPOSE_MANAGED` error message and the container-number label skip behavior described in `data-model.md` §"Existing types — extracted, not changed".
- [X] T002 [US1] In `packages/control-plane/src/services/worker-scaler.ts`, replace the local definitions of `WorkerReplica`, `computeProjectName`, and `enumerateWorkers` with re-imports from `./worker-enumeration.js`. Re-export them if any external caller in this package depended on them.
- [X] T003 [P] [US1] Export `WorkerReplica`, `computeProjectName`, and `enumerateWorkers` from `packages/control-plane/src/index.ts` so the orchestrator can import them via `@generacy-ai/control-plane`.

## Phase 2: Engine Event Streaming (control-plane)

Additive capability on the existing `DockerEngineClient`. Runs in parallel with Phase 1 since it touches different files.

- [X] T004 [P] [US2] In `packages/control-plane/src/services/docker-engine-types.ts`, add the `EngineEvent` interface per `data-model.md` §"New: `EngineEvent`" (fields: `Type: 'container'`, `Action: string`, `id?`, `Actor?`, `time?`, `timeNano?`).
- [X] T005 [US2] In `packages/control-plane/src/services/docker-engine-client.ts`, add the `StreamContainerEventsOptions` interface (`filters.label?`, `filters.type?`, `signal?: AbortSignal`) and the `streamContainerEvents(opts): AsyncIterable<EngineEvent>` method. Implementation must:
  - Open `GET /events?filters=<urlencoded JSON>` on the configured Unix socket.
  - Parse newline-delimited JSON, yielding one `EngineEvent` per line; skip malformed lines with a single `console.warn`.
  - Resolve the iterator on stream end or `signal.abort()`.
  - Throw `DockerDaemonUnavailableError` if the initial connection is refused (`ECONNREFUSED` / `ENOENT`). No built-in reconnect — caller owns the loop.
  - Conform to all error-semantics rows in `contracts/docker-events-subscription.md`.
- [X] T006 [US2] Export `DockerEngineClient`, `EngineEvent`, and `StreamContainerEventsOptions` from `packages/control-plane/src/index.ts` (extend the same export block touched in T003).

## Phase 3: RelayBridge Wiring (orchestrator)

<!-- Phase boundary: Complete Phase 1 + Phase 2 before starting Phase 3 -->

Sequential within this phase — T007 → T008 → T009/T010 → T011 → T012. They all touch one or two files (`relay.ts`, `relay-bridge.ts`, `server.ts`).

- [X] T007 [US1] In `packages/orchestrator/src/types/relay.ts`, add the required `engineClient: DockerEngineClient` field to `RelayBridgeOptions` (import `DockerEngineClient` from `@generacy-ai/control-plane`). No optional — fail at compile time if not wired.
- [X] T008 [US1] In `packages/orchestrator/src/services/relay-bridge.ts`, accept `options.engineClient` in the constructor and store it on `this.engineClient`. Add the internal state fields from `data-model.md` §"Internal RelayBridge state additions": `workerEventAbort: AbortController | null`, `workerEventReconnectTimer: NodeJS.Timeout | null`, `workerEventBackoffMs: number = 5_000`, `cachedProjectName: string | null`.
- [X] T009 [US1] In `packages/orchestrator/src/services/relay-bridge.ts`'s `collectMetadata()`, replace the `metadata.workers = readClusterYaml().workers` branch with:
  - Call `enumerateWorkers(this.engineClient, await this.resolveProjectName())` (use `cachedProjectName` to avoid repeat `computeProjectName` calls).
  - Set `metadata.workers = replicas.filter(r => r.state === 'running').length`.
  - On any throw (including `DockerDaemonUnavailableError` and `ORCHESTRATOR_NOT_COMPOSE_MANAGED`), log warn once and **omit** the field per clarification C4. Do not fall back to YAML.
  - Keep `readClusterYaml()` for the `channel` field — only the `workers` source changes.
- [X] T010 [US2] In `packages/orchestrator/src/services/relay-bridge.ts`'s `start()`, after the existing setup, open the Engine event subscription:
  - Resolve project name via `computeProjectName(this.engineClient)`. If it throws `ORCHESTRATOR_NOT_COMPOSE_MANAGED`, skip the subscription entirely (running outside compose — no workers to watch). Log info.
  - Create an `AbortController`, store as `this.workerEventAbort`.
  - In an async loop: call `streamContainerEvents({ filters: { label: [\`com.docker.compose.project=\${project}\`, 'com.docker.compose.service=worker'], type: ['container'] }, signal: controller.signal })` and `for await` events. On each event with `Action ∈ { 'create', 'start', 'die', 'destroy' }`, call `this.sendMetadata()`.
  - On stream end or error (other than `AbortError`): log per `contracts/docker-events-subscription.md` §"Error semantics", wait `workerEventBackoffMs`, double (cap at 60_000), schedule reconnect via `workerEventReconnectTimer`. Reset backoff to 5_000 once the new stream stays open ≥30s or yields any event.
  - Suppress `AbortError`.
- [X] T011 [US2] In `packages/orchestrator/src/services/relay-bridge.ts`'s `stop()`, call `this.workerEventAbort?.abort()` and `clearTimeout(this.workerEventReconnectTimer)`. Confirm no further `sendMetadata()` calls fire after `stop()` resolves.
- [X] T012 [US1] In `packages/orchestrator/src/server.ts`'s `initializeRelayBridge()`, construct a single `new DockerEngineClient()` (default options pick up `DOCKER_HOST` or fall back to `/var/run/docker-host.sock`) and pass it into the `new RelayBridge({ ..., engineClient })` call. Keep the client reference at the same scope as the bridge so it lives as long as the relay does.

## Phase 4: Tests

<!-- Phase boundary: Complete Phase 3 before writing the integration tests in T013 -->

- [ ] T013 [US1, US2] Add or extend `packages/orchestrator/test/relay-bridge.test.ts` to cover the four scenarios from `plan.md` §"Project Structure":
  1. **Running count** — stub `engineClient.listContainers` to return 2 running + 1 exited; assert `collectMetadata().workers === 2`.
  2. **Engine error omission** — stub `engineClient` to throw `DockerDaemonUnavailableError`; assert `metadata.workers` is `undefined` and the rest of the payload is sent.
  3. **NOT_COMPOSE_MANAGED omission** — stub `computeProjectName` to throw `ORCHESTRATOR_NOT_COMPOSE_MANAGED`; assert subscription is not opened in `start()` and `metadata.workers` is omitted from heartbeats.
  4. **Event-driven refresh** — stub `streamContainerEvents` to yield `{ Action: 'die' }`; assert `sendMetadata` is invoked within 100ms (per `contracts/docker-events-subscription.md` §"Conformance test cases" case 1).
  Also assert filter shape and cancellation behavior (cases 2 and 3 from the same contract section).
- [ ] T014 [P] [US1] Add `packages/control-plane/test/worker-enumeration.test.ts` as a thin smoke test confirming `enumerateWorkers`, `computeProjectName`, and `WorkerReplica` are importable from both `./services/worker-enumeration.js` and `@generacy-ai/control-plane`. Existing `worker-scaler.test.ts` continues to cover behavior; do not duplicate.

## Phase 5: Manual Verification

<!-- Phase boundary: Complete Phase 4 before running quickstart. -->

- [ ] T015 [US1, US2] Run the four verification scenarios in `quickstart.md` against a `npx generacy launch`-created cluster:
  1. Baseline reads `workers: 1` (not `3`) with template-default `cluster.yaml: 3` and `.env: WORKER_COUNT=1`.
  2. `docker stop <project>-worker-1` → UI tile drops to `0` within ~10s.
  3. Restart orchestrator with no workers running → first heartbeat reports `workers: 0`, not `3`.
  4. Failure path: when Engine API is denied, `workers` field is **omitted** from the payload (cloud UI treats as unknown).

## Dependencies & Execution Order

**Sequential phases**:
- Phase 1 (extraction) and Phase 2 (event streaming) → must complete before Phase 3.
- Phase 3 (orchestrator wiring) → must complete before Phase 4 tests can pass.
- Phase 4 (tests) → must pass before Phase 5 manual verification.

**Parallel opportunities**:
- T001/T002 (worker-scaler.ts extraction) runs in parallel with T004 (engine-types.ts type add) and T005 (engine-client.ts method add) — different files, independent.
- T003 + T006 both edit `packages/control-plane/src/index.ts` — bundle them into the same edit to avoid conflicts.
- T014 (control-plane smoke test) runs in parallel with T013 (orchestrator relay-bridge tests).

**Within-file ordering** (Phase 3 sequential):
- T007 (add option type) → T008 (constructor wiring) → T009 (collectMetadata change) → T010 (event subscription in start()) → T011 (cancel in stop()) → T012 (server.ts construction & injection).

**Acceptance mapping**:
- Spec acceptance #1 ("workers equals N regardless of YAML") → T009, validated by T013 case 1 and T015 scenario 1.
- Spec acceptance #2 ("docker stop updates within ~10s") → T010, validated by T013 case 4 and T015 scenario 2.
- Spec acceptance #3 ("scale operation source value is honest") → no extra work; already enabled once T009 lands (existing `refresh-metadata` trigger calls `collectMetadata`).

---

*Generated by speckit*
