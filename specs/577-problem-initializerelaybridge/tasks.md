# Tasks: Register /control-plane Unix-Socket Route on Relay Client

**Input**: Design documents from `/specs/577-problem-initializerelaybridge/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Prerequisite Verification

- [ ] T001 Confirm #576 is merged and `ClusterRelayClientOptions` in `packages/cluster-relay/src/relay.ts` has `routes?: RouteEntry[]` field

## Phase 2: Core Implementation

- [ ] T002 [US1] Add `routes` array to `RelayClientImpl` constructor in `packages/orchestrator/src/server.ts` (`initializeRelayBridge` function, ~L635-640) with `{ prefix: '/control-plane', target: \`unix://${controlPlaneSocket}\` }`

## Phase 3: Tests

- [ ] T003 [US1] Create unit test `packages/orchestrator/src/__tests__/relay-route-config.test.ts` — mock `@generacy-ai/cluster-relay`, call `initializeRelayBridge`, assert relay client constructed with `/control-plane` route targeting `unix:///run/generacy-control-plane/control.sock` (default) and custom path when `CONTROL_PLANE_SOCKET_PATH` env is set
- [ ] T004 [US2] Extend test to verify non-`/control-plane` requests still fall through to orchestrator URL (assert `orchestratorUrl` is set and no catch-all route overrides it)

## Phase 4: Validation

- [ ] T005 Run existing orchestrator tests (`pnpm --filter @generacy-ai/orchestrator test`) to verify no regressions

## Dependencies & Execution Order

- T001 → T002 (must confirm #576 merged before code change compiles)
- T002 → T003, T004 (implementation before tests)
- T003, T004 → T005 (new tests before full suite)
- T003 and T004 can run in parallel [P] (same test file, but independent assertions)
