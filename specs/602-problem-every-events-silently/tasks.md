# Tasks: Canonical Relay Event Schema

**Input**: Design documents from `/specs/602-problem-every-events-silently/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Canonical Schema (cluster-relay)

- [ ] T001 [US2] Update `EventMessage` interface in `packages/cluster-relay/src/messages.ts`: rename `channel` → `event` (string), `event` → `data` (unknown), add `timestamp: string`
- [ ] T002 [US2] Update `EventMessageSchema` Zod schema in `packages/cluster-relay/src/messages.ts`: rename `channel` → `event` (z.string().min(1)), `event` → `data` (z.unknown()), add `timestamp` (z.string().datetime())
- [ ] T003 [US2] Export `EventMessageSchema` and `RelayMessageSchema` as named exports from `packages/cluster-relay/src/messages.ts` (currently non-exported consts)
- [ ] T004 [P] [US2] Add round-trip unit test for `EventMessage` schema in cluster-relay: construct, serialize to JSON, parse with schema, assert equality (FR-008)

## Phase 2: Orchestrator Type Cleanup

- [ ] T005 [US2] Delete `RelayEvent` and `RelayJobEvent` types from `packages/orchestrator/src/types/relay.ts`
- [ ] T006 [US2] Import `EventMessage` from `@generacy-ai/cluster-relay` in `packages/orchestrator/src/types/relay.ts` and update `RelayMessage` union to use it
- [ ] T007 [US2] Fix all import sites that reference `RelayEvent` or `RelayJobEvent` — update to use `EventMessage`

## Phase 3: Fix All Send Sites

- [ ] T008 [US1] Fix `packages/orchestrator/src/services/relay-bridge.ts:~390` (SSE forward): change `{channel, event}` → `{event, data, timestamp}`, remove cast
- [ ] T009 [P] [US1] Fix `packages/orchestrator/src/services/relay-bridge.ts:~148` (job events): remove `as RelayMessage` cast — already canonical shape
- [ ] T010 [P] [US1] Fix `packages/orchestrator/src/server.ts:~225` (worker job events): remove `as RelayMessage` cast — already canonical shape
- [ ] T011 [US1] Fix `packages/orchestrator/src/routes/internal-relay-events.ts:~46` (IPC handler): change `{channel, event: payload}` → `{type: 'event', event, data, timestamp}`, remove `as unknown as RelayMessage` cast

## Phase 4: PushEventFn Rename (control-plane IPC)

- [ ] T012 [US2] Rename `PushEventFn` in `packages/control-plane/src/relay-events.ts`: `(channel, payload)` → `(event, data)`
- [ ] T013 [US2] Update all callers of `setRelayPushEvent`/`getRelayPushEvent` in control-plane to use `(event, data)` parameter names
- [ ] T014 [US1] Update HTTP body in `packages/control-plane/bin/control-plane.ts`: `{channel, payload}` → `{event, data, timestamp: new Date().toISOString()}`
- [ ] T015 [US1] Update Zod schema in `packages/orchestrator/src/routes/internal-relay-events.ts`: `{channel, payload}` → `{event, data, timestamp}`

## Phase 5: Verification

- [ ] T016 [P] [US1] Run TypeScript compilation across all three packages (`cluster-relay`, `orchestrator`, `control-plane`) — zero errors
- [ ] T017 [P] [US1] Run existing tests in cluster-relay (`pnpm --filter @generacy-ai/cluster-relay test`)
- [ ] T018 [US1] Grep for remaining `as RelayMessage` and `as unknown as RelayMessage` casts on event sends — zero matches (SC-001)

## Dependencies & Execution Order

**Phase 1** must complete first — T001-T003 define the canonical type that all other phases depend on. T004 (unit test) can run in parallel once T001-T003 are done.

**Phase 2** depends on Phase 1 — deleting orchestrator types requires the import target to exist.

**Phase 3** depends on Phase 2 — send sites reference the `RelayMessage` union which must already include `EventMessage`.

**Phase 4** can partially overlap with Phase 3 — T012-T013 (control-plane rename) are independent of orchestrator send fixes. T014 (HTTP body) and T015 (Zod schema) touch the IPC boundary and should be done together with T011.

**Phase 5** runs after all changes — verification pass.

**Parallel opportunities**:
- T004 (unit test) is independent once Phase 1 types exist
- T009, T010 (removing casts on already-correct sites) are independent of each other
- T016, T017 (build + test) are independent of each other
