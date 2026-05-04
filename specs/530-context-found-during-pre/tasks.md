# Tasks: Complete Cluster Control-Plane Lifecycle Handlers

**Input**: Design documents from `/specs/530-context-found-during-pre/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup & Schema

- [ ] T001 Add `yaml` dependency to `packages/control-plane/package.json`
- [ ] T002 [P] Extend `LifecycleActionSchema` in `packages/control-plane/src/schemas.ts` to 5 entries: add `'set-default-role'` and `'stop'`
- [ ] T003 [P] Add `ClonePeerReposBodySchema` and `SetDefaultRoleBodySchema` to `packages/control-plane/src/schemas.ts`

## Phase 2: Shared Infrastructure

- [ ] T004 Extract `setRelayPushEvent`/`getRelayPushEvent` from `packages/control-plane/src/routes/audit.ts` into `packages/control-plane/src/relay-events.ts`; update audit.ts to import from new module

## Phase 3: Core Services

- [ ] T005 [US1] Create `packages/control-plane/src/services/default-role-writer.ts` — validate role file exists in `.agency/roles/<role>.yaml`, read/create `.generacy/config.yaml`, set `defaults.role`, atomic write (temp+rename)
- [ ] T006 [P] [US2] Create `packages/control-plane/src/services/peer-repo-cloner.ts` — accept `{ repos, token? }`, iterate repos, check idempotency (dir exists → skip), emit `cluster.bootstrap` events via `getRelayPushEvent()`, spawn `git clone` with optional `x-access-token` HTTPS URL

## Phase 4: Route Wiring

- [ ] T007 Update `packages/control-plane/src/routes/lifecycle.ts` — import `readBody`, parse body with new schemas, dispatch `set-default-role` to `setDefaultRole()`, `clone-peer-repos` to `clonePeerRepos()`, `stop` as stub

## Phase 5: Tests

- [ ] T008 [P] [US1] Create `packages/control-plane/__tests__/services/default-role-writer.test.ts` — test role validation (exists/missing), config creation, config merge, atomic write
- [ ] T009 [P] [US2] Create `packages/control-plane/__tests__/services/peer-repo-cloner.test.ts` — test clone invocation, token auth URL building, idempotent skip, empty repos, event emission order
- [ ] T010 [P] Update `packages/control-plane/__tests__/routes/lifecycle.test.ts` — add tests for `set-default-role` (success, missing role), `clone-peer-repos` (success, empty), `stop` (stub), schema validation of new actions
- [ ] T011 Verify existing tests pass: run `pnpm test` in `packages/control-plane`

## Dependencies & Execution Order

**Sequential phases**: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

**Within-phase parallelism**:
- Phase 1: T002 and T003 can run in parallel (both modify schemas.ts but are logically coupled — combine if needed)
- Phase 3: T005 and T006 can run in parallel (separate service files, no shared state)
- Phase 5: T008, T009, T010 can all run in parallel (separate test files)

**Key dependencies**:
- T004 must complete before T005/T006 (services import `getRelayPushEvent`)
- T005/T006 must complete before T007 (route imports services)
- T007 must complete before T010 (route test covers dispatching to real services)
- T011 runs last as final validation
