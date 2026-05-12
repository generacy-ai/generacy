# Tasks: Wizard-mode relay bridge initialization failure

**Input**: Design documents from `/specs/598-symptoms-after-creating-fresh/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Route Handler Refactor

- [ ] T001 [US1] Modify `setupInternalRelayEventsRoute` in `packages/orchestrator/src/routes/internal-relay-events.ts` to accept `getRelayClient: () => ClusterRelayClient | null` instead of direct `relayClient` parameter (FR-002)
- [ ] T002 [US1] Add 503 early return in route handler when `getRelayClient()` returns `null`, responding with `{ error: "relay not yet initialized" }` (FR-003)

## Phase 2: Server Startup Rewiring

- [ ] T003 [US1] In `packages/orchestrator/src/server.ts` `createServer()`, add mutable `relayClientRef` variable and register `ORCHESTRATOR_INTERNAL_API_KEY` in `apiKeyStore` **before** `server.listen()` (FR-006)
- [ ] T004 [US1] Call `setupInternalRelayEventsRoute(server, () => relayClientRef)` before `server.listen()` in `createServer()` (FR-001)
- [ ] T005 [US1] Remove `setupInternalRelayEventsRoute()` call and API key registration from `initializeRelayBridge()` (FR-005)
- [ ] T006 [US1] Add optional `setRelayClient` callback parameter to `initializeRelayBridge()` signature; call it after relay client construction to assign `relayClientRef` (FR-004)

## Phase 3: Verification

- [ ] T007 [US2] Verify non-wizard mode path: ensure `relayClientRef` is assigned before `server.listen()` when `config.relay.apiKey` is present (no behavioral change)
- [ ] T008 [US1] Build packages (`pnpm build` in orchestrator) and verify no type errors

## Dependencies & Execution Order

- T001 and T002 are sequential (T002 depends on T001's signature change)
- T003 and T004 are sequential (T004 depends on T003's `relayClientRef` variable)
- T005 and T006 depend on T001 (new signature must exist before call sites change)
- T007 depends on T003-T006 (needs full rewiring to verify)
- T008 depends on all previous tasks

**Parallel opportunities**:
- Phase 1 (T001-T002) and Phase 2 (T003-T006) can partially overlap since they touch different files, but T005-T006 depend on T001's new signature
- Recommended execution: T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008
