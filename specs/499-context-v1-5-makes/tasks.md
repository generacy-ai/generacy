# Tasks: Credential Audit Log

**Input**: Design documents from `/specs/499-context-v1-5-makes/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Schema Extensions

- [ ] T001 [P] [US1] Create audit types and Zod schemas in `packages/credhelper-daemon/src/audit/types.ts` — define `AuditAction`, `AuditEntry`, `AuditBatch`, `AuditConfig` interfaces and `AuditActionSchema`, `AuditEntrySchema`, `AuditBatchSchema` Zod schemas
- [ ] T002 [P] [US1] Extend `RoleConfig` schema in `packages/credhelper/src/schemas/roles.ts` — add `audit?: { recordAllProxy?: boolean }` with `RoleAuditConfigSchema`
- [ ] T003 [P] [US1] Extend `DaemonConfig` in `packages/credhelper-daemon/src/types.ts` — add optional `clusterId` and `workerId` fields

## Phase 2: Core Module

- [ ] T010 [US2] Implement ring buffer in `packages/credhelper-daemon/src/audit/ring-buffer.ts` — generic `RingBuffer<T>` class with O(1) push, capacity-bounded drop, `drain(max)` returning entries + dropped count
- [ ] T011 [US2] Write ring buffer tests in `packages/credhelper-daemon/tests/audit/ring-buffer.test.ts` — push/drain, overflow/drop counting, capacity boundary, empty drain
- [ ] T012 [US1] Implement sampler in `packages/credhelper-daemon/src/audit/sampler.ts` — deterministic counter-based sampling (1/100 default), `recordAllProxy` override to 100%
- [ ] T013 [US1] Write sampler tests in `packages/credhelper-daemon/tests/audit/sampler.test.ts` — default 1/100 rate, override to 100%, counter reset behavior

## Phase 3: Transport & AuditLog

- [ ] T020 [US1] Implement HTTP transport in `packages/credhelper-daemon/src/audit/transport.ts` — `flushBatch(batch, socketPath)` using `node:http` POST to Unix socket at `/internal/audit-batch`
- [ ] T021 [US1] Write transport tests in `packages/credhelper-daemon/tests/audit/transport.test.ts` — successful flush, control-plane unavailable (no throw), batch serialization
- [ ] T022 [US1] Implement `AuditLog` class in `packages/credhelper-daemon/src/audit/audit-log.ts` — `record()` API, ring buffer integration, timer-based flush (1s) with early flush at 50 entries, `droppedSinceLastBatch` tracking, dev-mode field length assertion (>256 chars)
- [ ] T023 [US1] Write AuditLog tests in `packages/credhelper-daemon/tests/audit/audit-log.test.ts` — record produces entry, batch flush at 50, timer flush at 1s, dropped counter, dev-mode assertion on long fields
- [ ] T024 [US1] Write dev-mode field length assertion tests in `packages/credhelper-daemon/tests/audit/field-length.test.ts` — assert failure on fields >256 chars, no assertion in production mode
- [ ] T025 [US1] Create barrel export in `packages/credhelper-daemon/src/audit/index.ts` — re-export `AuditLog`, `RingBuffer`, types, sampler

## Phase 4: Control-Plane Endpoint

- [ ] T030 [US1] Implement audit batch route in `packages/control-plane/src/routes/audit.ts` — `POST /internal/audit-batch` handler: validate with `AuditBatchSchema`, emit each entry via `relay.pushEvent('cluster.audit', entry)`, return 200
- [ ] T031 [US1] Register audit route in `packages/control-plane/src/router.ts` — wire the new route with relay `pushEvent` callback injection
- [ ] T032 [US1] Write control-plane audit route tests in `packages/control-plane/tests/audit-route.test.ts` — valid batch accepted, invalid batch rejected, relay pushEvent called per entry

## Phase 5: Hook Points (Integration)

- [ ] T040 [US1] Wire AuditLog into daemon startup in `packages/credhelper-daemon/bin/credhelper-daemon.ts` — construct `AuditLog` from `DaemonConfig` (env vars `GENERACY_CLUSTER_ID`, `GENERACY_WORKER_ID`), inject into `SessionManager`
- [ ] T041 [US1] Add audit hooks in `SessionManager` (`packages/credhelper-daemon/src/session-manager.ts`) — record `session.begin`/`session.end`, wrap plugin `mint()`/`resolve()` calls with audit try/catch recording `credential.mint`/`credential.resolve` success/failure
- [ ] T042 [US1] Add audit hooks in `ExposureRenderer` (`packages/credhelper-daemon/src/exposure-renderer.ts`) — record `exposure.render` per exposure rendered
- [ ] T043 [P] [US1] Add sampled audit hooks in Docker proxy handler (`packages/credhelper-daemon/src/docker-proxy-handler.ts`) — record `proxy.docker` per allow/deny at 1/100 default rate, respect `RoleConfig.audit.recordAllProxy`
- [ ] T044 [P] [US1] Add sampled audit hooks in localhost proxy (`packages/credhelper-daemon/src/exposure/localhost-proxy.ts`) — record `proxy.localhost` per allow/deny at allowlist matching point, same sampling as Docker proxy

## Phase 6: Integration Tests & Polish

- [ ] T050 [US2] Write audit pressure integration test in `packages/credhelper-daemon/tests/integration/audit-pressure.test.ts` — 10000 rapid mints with control-plane offline, verify non-zero `droppedSinceLastBatch`, bounded memory (ring buffer size <= capacity)
- [ ] T051 [US1] Verify end-to-end: audit entries flow from daemon record → ring buffer → HTTP POST → control-plane → relay `cluster.audit` channel
- [ ] T052 [US1] Run full test suite (`vitest`) across `credhelper-daemon`, `credhelper`, and `control-plane` packages — ensure no regressions

## Dependencies & Execution Order

**Phase 1** (parallelizable): T001, T002, T003 are independent schema/type changes across different packages — all can run in parallel.

**Phase 2** (depends on Phase 1): T010 depends on T001 (types). T011 depends on T010. T012 depends on T001. T013 depends on T012. T010 and T012 can run in parallel after Phase 1.

**Phase 3** (depends on Phase 2): T020 depends on T001 (AuditBatch type). T022 depends on T010 (RingBuffer), T012 (Sampler), T020 (transport). T023/T024 depend on T022. T025 depends on all audit module files.

**Phase 4** (depends on Phase 1): T030 depends on T001 (AuditBatchSchema). Can run in parallel with Phases 2-3 since it's a different package.

**Phase 5** (depends on Phases 3-4): T040 depends on T022 (AuditLog class) and T003 (DaemonConfig). T041-T042 depend on T040. T043 and T044 can run in parallel (different files, same pattern).

**Phase 6** (depends on Phase 5): T050-T052 are final validation, must run after all integration points are wired.

**Parallel opportunities**: T001/T002/T003 | T010/T012 | T030 with Phase 2-3 | T043/T044
