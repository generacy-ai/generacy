# Tasks: control-plane GET /roles (list) endpoint + real role reads

**Input**: Design documents from `/specs/580-symptoms-bootstrap-wizard-step/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Tests

- [X] T001 [US1] Create test file `packages/control-plane/test/routes/roles.test.ts` with unit tests for `handleListRoles`: empty/missing roles dir returns `{ roles: [] }` (200), directory with `.yaml` files returns parsed roles with `id` and `description`, malformed YAML includes role with `id` only
- [X] T002 [P] [US2] Add unit tests for rewritten `handleGetRole` to `packages/control-plane/test/routes/roles.test.ts`: returns parsed YAML content (id, description, credentials) when file exists, returns 404 with `NOT_FOUND` code when file missing, returns 500 with `INTERNAL_ERROR` code on parse failure

## Phase 2: Core Implementation

- [X] T003 [US1] Implement `handleListRoles` in `packages/control-plane/src/routes/roles.ts` — resolve agency dir via `CREDHELPER_AGENCY_DIR` env (`.agency` fallback), read `roles/` directory, filter `.yaml` files, parse each with `yaml` package extracting `description`, return `{ roles: [{ id, description? }] }`. Handle ENOENT → empty array, malformed YAML → include role with `id` only
- [X] T004 [US2] Rewrite `handleGetRole` in `packages/control-plane/src/routes/roles.ts` — read `<agencyDir>/roles/<id>.yaml`, parse with `yaml`, return `{ id, description?, credentials? }`. Return 404 `NOT_FOUND` for missing file, 500 `INTERNAL_ERROR` for parse failure. Follow `handleGetCredential` pattern from `credentials.ts`
- [X] T005 [US1] Add `GET /roles` route to `packages/control-plane/src/router.ts` — insert `{ method: 'GET', pattern: /^\/roles$/, paramNames: [], handler: handleListRoles }` before the existing `GET /roles/:id` route. Import `handleListRoles` from `routes/roles.js`

## Dependencies & Execution Order

- T001 and T002 can run in parallel (both write to the same test file but different describe blocks — combine in a single session)
- T003, T004, T005 depend on T001/T002 (TDD: tests first)
- T003 and T004 modify the same file (`roles.ts`) — execute sequentially
- T005 depends on T003 (needs `handleListRoles` export to import)
- Recommended order: T001+T002 → T003 → T004 → T005
