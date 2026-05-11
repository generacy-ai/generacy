# Tasks: Fix cloud-to-cluster /control-plane/* 404s

**Input**: Design documents from `/specs/574-symptoms-bootstrap-wizard/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [P] [US2] Add `routes?: RouteEntry[]` to `ClusterRelayClientOptions` in `packages/cluster-relay/src/relay.ts` and thread it into the `RelayConfigSchema.parse()` call in the constructor's options branch
- [ ] T002 [P] [US2] Add unit test in `packages/cluster-relay/src/__tests__/relay.test.ts` verifying that `routes` passed via `ClusterRelayClientOptions` appear in the parsed `config.routes`

## Phase 2: Orchestrator Wiring

- [ ] T003 [US1] Pass `/control-plane` route to relay client in `initializeRelayBridge` in `packages/orchestrator/src/server.ts` — add `routes: [{ prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock' }]` to the relay client constructor call
- [ ] T004 [US1] Add unit test in `packages/orchestrator/src/__tests__/server.test.ts` asserting `initializeRelayBridge` passes a route with `prefix: '/control-plane'` and `target: 'unix:///run/generacy-control-plane/control.sock'`

## Phase 3: Validation

- [ ] T005 Run existing test suites for both `packages/cluster-relay` and `packages/orchestrator` to confirm no regressions

## Dependencies & Execution Order

- **T001 and T002** can run in parallel (both touch cluster-relay but different files: source vs test)
- **T003** depends on T001 (needs `routes` field available on `ClusterRelayClientOptions`)
- **T004** depends on T003 (tests the wiring added in T003)
- **T005** depends on all prior tasks (final validation)
