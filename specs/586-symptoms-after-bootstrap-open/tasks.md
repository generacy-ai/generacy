# Tasks: Open IDE Flow Fix (#586)

**Input**: Design documents from `/specs/586-symptoms-after-bootstrap-open/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Code-Server Auto-Start (Gap C)

- [ ] T001 [US1] Trigger code-server start on `bootstrap-complete` in `packages/control-plane/src/routes/lifecycle.ts`
  - After the sentinel file write (line 74), add async fire-and-forget call: `getCodeServerManager().start().catch(err => logger.error(...))`
  - Do NOT await — keep `bootstrap-complete` response fast
  - Logger import may be needed (check existing imports)

- [ ] T002 [US1] Add test for bootstrap-complete triggering code-server-start in `packages/control-plane/__tests__/routes/lifecycle.test.ts`
  - Mock `getCodeServerManager()` to return a mock with `start()` spy
  - Assert `start()` is called after `bootstrap-complete` action
  - Assert the response returns immediately (not blocked by start)

## Phase 2: Relay Route & Health Endpoint (Gap B + FR-003)

- [ ] T003 [P] [US1] Add `/code-server` relay route in `packages/orchestrator/src/server.ts` `initializeRelayBridge()` (~line 640)
  - Read `CODE_SERVER_SOCKET_PATH` env var with default `/run/code-server.sock`
  - Add `{ prefix: '/code-server', target: \`unix://${codeServerSocket}\` }` to the `routes` array
  - Same pattern as existing `/control-plane` route

- [ ] T004 [P] [US1] Add `codeServerReady` to health response schema in `packages/orchestrator/src/types/api.ts` (~line 209)
  - Add `codeServerReady: z.boolean().optional()` to `HealthResponseSchema`

- [ ] T005 [US1] Add `codeServerReady` to `/health` handler in `packages/orchestrator/src/routes/health.ts`
  - Import `getCodeServerManager` from `@generacy-ai/control-plane`
  - In the handler (~line 84), add `codeServerReady: getCodeServerManager()?.getStatus() === 'running'` to the response object
  - Also add `codeServerReady` to the Fastify JSON schema (lines 38-44) as `{ type: 'boolean' }`
  - Handle case where `getCodeServerManager()` returns null (use `false`)

- [ ] T006 [US1] Add health endpoint test in `packages/orchestrator/__tests__/routes/health.test.ts`
  - Test that `/health` response includes `codeServerReady: false` when manager status is not 'running'
  - Test that `/health` response includes `codeServerReady: true` when manager status is 'running'
  - Mock `getCodeServerManager()` singleton

## Phase 3: Dual Metadata Path (Gap A)

- [ ] T007 [P] [US1] Add `codeServerReady` to `cluster-relay/src/metadata.ts` `collectMetadata`
  - Add `codeServerReady: boolean` to `HealthData` interface (line 28-32)
  - In `fetchHealth()` (line 41-45), extract `codeServerReady: data['codeServerReady'] === true` (default `false`)
  - In `collectMetadata()` return (line 18-26), add `codeServerReady: health.codeServerReady`

- [ ] T008 [P] [US1] Add `codeServerReady` to `relay-bridge.ts` `collectMetadata` in `packages/orchestrator/src/services/relay-bridge.ts`
  - Import `getCodeServerManager` from control-plane (or use existing import path)
  - In `collectMetadata()` (line 493-514), add `codeServerReady: getCodeServerManager()?.getStatus() === 'running'` to returned object
  - Update `ClusterMetadataPayload` type in `packages/orchestrator/src/types/relay.ts` if needed

- [ ] T009 [US1] Add metadata tests
  - `packages/cluster-relay/__tests__/metadata.test.ts`: Test `collectMetadata` includes `codeServerReady` from `/health` response; test default `false` when field missing
  - `packages/orchestrator/__tests__/services/relay-bridge.test.ts`: Test `collectMetadata` includes `codeServerReady` from code-server manager status

## Phase 4: Out-of-Band Metadata Push (FR-006)

- [ ] T010 [US1] Add `onStatusChange` callback to `CodeServerManager` interface and implementation in `packages/control-plane/src/services/code-server-manager.ts`
  - Add `onStatusChange(callback: (status: CodeServerStatus) => void): void` to `CodeServerManager` interface (line 12-18)
  - In `CodeServerProcessManager`: add private `statusChangeCallback` field, implement `onStatusChange()` setter
  - In `start()` method: after `this.status = 'running'` (line 105), call `this.statusChangeCallback?.('running')`
  - In exit/error handlers: after `this.status = 'stopped'`, call `this.statusChangeCallback?.('stopped')`

- [ ] T011 [US1] Make `sendMetadata()` callable externally in `packages/orchestrator/src/services/relay-bridge.ts`
  - `sendMetadata()` is currently private (line 476). Either make it public or add a public wrapper method
  - This is needed so the orchestrator can trigger a metadata send from the code-server callback

- [ ] T012 [US1] Wire code-server status change to relay metadata push in `packages/orchestrator/src/server.ts` `initializeRelayBridge()`
  - After creating the relay bridge and getting `codeServerManager` (~line 658-665), wire: `codeServerManager.onStatusChange((status) => { if (status === 'running') relayBridge.sendMetadata(); })`
  - This ensures `codeServerReady: true` reaches cloud within seconds of code-server starting

- [ ] T013 [US1] Add test for out-of-band metadata push
  - Test that `CodeServerProcessManager.onStatusChange` callback fires on status transitions
  - Test that the wiring in `initializeRelayBridge` calls `sendMetadata()` when status becomes 'running'

## Dependencies & Execution Order

**Phase 1** (T001-T002): No dependencies. Code-server auto-start is self-contained.

**Phase 2** (T003-T006): T003 and T004 are parallel (different files). T005 depends on T004 (schema must exist). T006 depends on T005.

**Phase 3** (T007-T009): T007 and T08 are parallel (different packages). Both depend on Phase 2 (T005 adds `codeServerReady` to `/health`). T009 depends on T007+T008.

**Phase 4** (T010-T013): T010 is independent (control-plane). T011 is independent (relay-bridge). T012 depends on T010+T011. T013 depends on T010+T012.

**Cross-phase**: Phase 3 depends on Phase 2. Phase 4 depends on Phase 3 (metadata must be wired before push makes sense). Phase 1 is independent of all others.

**Parallel opportunities**: T003∥T004, T007∥T008, T010∥T011. Phase 1 can run in parallel with Phase 2.
