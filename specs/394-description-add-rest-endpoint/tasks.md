# Tasks: Sessions REST Endpoint

**Input**: Design documents from `/specs/394-description-add-rest-endpoint/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/sessions-api.yaml
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Schemas

- [X] T001 Add Session Zod schemas and types to `packages/orchestrator/src/types/api.ts` — add `SessionTypeSchema`, `SessionMetadataSchema`, `ListSessionsQuerySchema`, `SessionListResponseSchema`, and `sessions:read` to `ApiScopeSchema`
- [X] T002 [P] Export new Session types from `packages/orchestrator/src/types/index.ts`

## Phase 2: Service Implementation

- [X] T003 Create `packages/orchestrator/src/services/session-service.ts` — implement `SessionService` class with:
  - `discoverDirectories(claudeProjectsDir)` — scan `~/.claude/projects/` for workspace directories
  - `parseSessionFile(filePath, workspace)` — stream-parse JSONL via `node:readline` to extract `SessionMetadata`
  - `list(query: ListSessionsQuery)` — discover, parse, filter by workspace, sort by `lastActivityAt` desc, paginate
  - Workspace path encoding/decoding logic (match config workspaces by encoding path `/` → `-`)
  - Error handling: skip malformed files with warning, return empty on missing directories

## Phase 3: Route & Wiring

- [X] T004 Create `packages/orchestrator/src/routes/sessions.ts` — implement `setupSessionRoutes(server, sessionService)` with:
  - `GET /sessions` with `requireRead('sessions')` preHandler
  - Zod validation of query params (`workspace`, `page`, `pageSize`)
  - Call `sessionService.list()` and return `SessionListResponse`
- [X] T005 Register session routes in `packages/orchestrator/src/routes/index.ts` — add `sessionService` to `RouteRegistrationOptions`, call `setupSessionRoutes()` in `registerRoutes()`
- [X] T006 Wire `SessionService` in `packages/orchestrator/src/server.ts` — instantiate in `createServer()`, pass to `registerRoutes()`

## Phase 4: Tests

- [X] T007 Create test fixture JSONL files in `packages/orchestrator/tests/fixtures/sessions/` — sample session files covering: normal session, automated session (`bypassPermissions`), session with missing fields, malformed lines, empty file
- [X] T008 [P] Create unit tests `packages/orchestrator/tests/unit/services/session-service.test.ts` — test `parseSessionFile()` (metadata extraction, malformed line handling, empty files), `discoverDirectories()` (directory scanning, missing dir), `list()` (filtering, sorting, pagination)
- [X] T009 [P] Create integration tests `packages/orchestrator/tests/integration/routes/sessions.test.ts` — test `GET /sessions` (200 response shape, pagination, workspace filter, empty results, auth)

## Dependencies & Execution Order

```
T001 ──┬──→ T003 ──→ T004 ──┬──→ T007 ──┬──→ T008
T002 ──┘              │      │           └──→ T009
                      T005 ──┘
                      T006 ──┘
```

- **T001 + T002**: parallel (different files) — types must exist before service
- **T003**: depends on T001 (uses Zod schemas)
- **T004, T005, T006**: depend on T003 (route uses service); T005/T006 can be done together but touch different files
- **T007**: depends on route wiring complete (fixtures needed for tests)
- **T008 + T009**: parallel (unit vs integration tests, different files); both depend on T007 (fixtures)
