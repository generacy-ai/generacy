# Tasks: Expose `routes` in ClusterRelayClientOptions

**Input**: Design documents from `/specs/576-problem/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US1] Add `routes?: RouteEntry[]` to `ClusterRelayClientOptions` interface in `packages/cluster-relay/src/relay.ts:22-33`. Import `RouteEntry` type from `./config.js`.
- [ ] T002 [US1] Thread `routes: opts.routes` into the `RelayConfigSchema.parse()` call in the `ClusterRelayClientOptions` branch of the constructor (`packages/cluster-relay/src/relay.ts:83-89`). Sort routes after parse for consistency with the `RelayConfig` path: `const parsed = RelayConfigSchema.parse({ ... }); this.config = { ...parsed, routes: sortRoutes(parsed.routes) };`

## Phase 2: Tests

- [ ] T003 [US1] Add unit test in `packages/cluster-relay/tests/relay.test.ts`: construct `ClusterRelay` with `routes` option, verify `config.routes` is populated and sorted longest-prefix-first (SC-001).
- [ ] T004 [P] [US1] Add unit test: construct `ClusterRelay` without `routes`, verify `config.routes` defaults to `[]` (SC-003).
- [ ] T005 Run existing test suite (`pnpm test` in `packages/cluster-relay`) to confirm zero regressions (SC-002).

## Dependencies & Execution Order

- **T001 → T002**: Interface must exist before constructor can reference the field.
- **T002 → T003, T004**: Tests verify the implementation.
- **T003 ∥ T004**: Both tests are independent and can be written in parallel.
- **T005**: Runs after all changes are complete.
