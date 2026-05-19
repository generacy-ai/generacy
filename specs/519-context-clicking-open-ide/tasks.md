# Tasks: Cluster-Side IDE Tunnel Support

**Input**: Design documents from `/specs/519-context-clicking-open-ide/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Message Types & Schema

- [X] T001 [P] [US1] Add four tunnel message Zod schemas to `packages/cluster-relay/src/messages.ts` — `TunnelOpenMessageSchema`, `TunnelOpenAckMessageSchema`, `TunnelDataMessageSchema`, `TunnelCloseMessageSchema`
- [X] T002 [P] [US1] Add four tunnel message TypeScript interfaces and include in `RelayMessage` type union in `packages/cluster-relay/src/messages.ts`
- [X] T003 [US1] Update `RelayMessageSchema` discriminated union to include the four new tunnel schemas in `packages/cluster-relay/src/messages.ts`

## Phase 2: Orchestrator Relay Types

- [X] T004 [P] [US1] Add `RelayTunnelOpen`, `RelayTunnelOpenAck`, `RelayTunnelData`, `RelayTunnelClose` interfaces and extend `RelayMessage` union in `packages/orchestrator/src/types/relay.ts`
- [X] T005 [P] [US1] Add `setTunnelHandler()` setter and tunnel message dispatch branches (`tunnel_open`, `tunnel_data`, `tunnel_close`) to `packages/orchestrator/src/services/relay-bridge.ts`

## Phase 3: TunnelHandler Service

- [X] T006 [US1] Create `packages/control-plane/src/services/tunnel-handler.ts` — `TunnelHandler` class with `RelayMessageSender` DI, `tunnels: Map<string, net.Socket>`, constructor accepting `relaySend`, `codeServerManager`, `allowedTarget`
- [X] T007 [US1] Implement `handleOpen()` — target validation (FR-004), auto-start code-server with 10s timeout (FR-005), connect Unix socket, send `tunnel_open_ack`, wire socket `data` event for relay-bound base64 encoding, wire socket `close`/`error` for cleanup (FR-007)
- [X] T008 [US2] Implement `handleData()` — base64 decode, socket write, call `codeServerManager.touch()` (FR-006)
- [X] T009 [US3] Implement `handleClose()` — destroy socket, remove from map
- [X] T010 [US2] Implement `cleanup()` — destroy all sockets, clear map (FR-008, stateless across reconnects)

## Phase 4: Wiring & Exports

- [X] T011 [P] [US1] Export `TunnelHandler` and `RelayMessageSender` from `packages/control-plane/src/index.ts`
- [X] T012 [US1] Wire `TunnelHandler` in `packages/orchestrator/src/server.ts` — construct with relay send callback + `getCodeServerManager()`, call `relayBridge.setTunnelHandler()`, register relay disconnect handler for `cleanup()`, add to shutdown hook

## Phase 5: Tests

- [X] T013 [P] [US1] Unit tests for tunnel message Zod schemas — valid parse and reject cases for all 4 types in `packages/cluster-relay/src/__tests__/messages.test.ts`
- [X] T014 [P] [US1] Unit tests for `TunnelHandler.handleOpen()` — target validation rejects invalid path, auto-start called, timeout error ack, success ack, socket data→relay base64 flow
- [X] T015 [P] [US2] Unit tests for `TunnelHandler.handleData()` — base64 decode + socket write, `touch()` called, missing tunnelId silently dropped
- [X] T016 [P] [US3] Unit tests for `TunnelHandler.handleClose()` — socket destroyed, removed from map, missing tunnelId no-op
- [X] T017 [P] [US2] Unit tests for `TunnelHandler.cleanup()` — all sockets destroyed, map cleared
- [X] T018 [US1] Unit tests for `RelayBridge` tunnel dispatch — tunnel messages routed to handler, null handler silently skips
- [X] T019 [US1] Integration test: full tunnel lifecycle — open → data (both directions) → close with mock socket and relay sender

## Dependencies & Execution Order

**Phase 1** (T001-T003): T001 and T002 can run in parallel; T003 depends on both.
**Phase 2** (T004-T005): Can start after Phase 1. T004 and T005 can run in parallel.
**Phase 3** (T006-T010): Can start after Phase 1 (needs message types). T006 first (class skeleton), then T007-T010 sequentially (build on class).
**Phase 4** (T011-T012): T011 can start after T006. T012 depends on T005 (bridge setter) and T006-T010 (handler complete).
**Phase 5** (T013-T019): T013 can start after Phase 1. T014-T017 can run in parallel after Phase 3. T018 after T005. T019 after all implementation complete.

**Parallel opportunities**: Phase 2 and Phase 3 can run in parallel (different packages). Within Phase 5, T013-T017 are all parallelizable.
