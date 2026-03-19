# Tasks: Add /sessions/:id REST Endpoint

**Input**: Design documents from `/specs/395-description-add-rest-endpoint/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/sessions-api.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup & Types

- [X] T001 [US1] Define TypeScript interfaces and Zod schemas for session endpoint in `packages/orchestrator/src/services/session-reader.ts`
  - `SessionMessage`, `ContentBlock` (TextBlock | ToolUseBlock | ToolResultBlock), `TokenUsage`, `SessionMetadata`, `SessionResponse`
  - `SessionParamsSchema` (sessionId: string, min 1, max 128)
  - `SessionQuerySchema` (workspace: optional string)

## Phase 2: Core Implementation

- [X] T002 [US1] Implement `SessionReader` service — JSONL file discovery and parsing in `packages/orchestrator/src/services/session-reader.ts`
  - `findSessionFile(sessionId, workspace?)`: locate JSONL file at `~/.claude/projects/<path-encoded>/<sessionId>.jsonl`
  - With workspace: encode path (`/` → `-`), resolve via `config.conversations.workspaces`, look in specific directory
  - Without workspace: scan all subdirectories of `~/.claude/projects/` for matching file
  - `parseSessionFile(filePath)`: read file, split lines, JSON.parse each, skip corrupted lines
  - Filter out `queue-operation` and `last-prompt` entry types
  - Transform user entries: emit as `role: 'user'` messages; extract `tool_result` blocks into separate `role: 'tool_result'` messages
  - Transform assistant entries: emit as `role: 'assistant'` with `model` and `usage`
  - Extract metadata: `slug`, `gitBranch` from first assistant entry; accumulate token totals

- [X] T003 [US1] Expose active session check on `ConversationManager` in `packages/orchestrator/src/conversation/conversation-manager.ts`
  - Add `isSessionActive(sessionId: string): boolean` method that iterates internal `conversations` map and checks handles for matching `sessionId`
  - This avoids exposing `sessionId` on the public `ConversationInfo` type

- [X] T004 [P] [US1] Implement session route handler in `packages/orchestrator/src/routes/sessions.ts`
  - Export `setupSessionRoutes(server, manager?)` following existing pattern (see `conversations.ts`)
  - `GET /sessions/:sessionId` with optional `?workspace=` query param
  - Validate params/query with Zod schemas
  - Call `SessionReader` for file discovery and parsing
  - Check `manager?.isSessionActive(sessionId)` for `isActive` metadata field
  - Return `SessionResponse` (200), or RFC 7807 errors (400 for bad workspace, 404 for not found, 500 for filesystem errors)

- [X] T005 [US1] Register session routes in `packages/orchestrator/src/server.ts`
  - Import `setupSessionRoutes` from `./routes/sessions`
  - Call `setupSessionRoutes(server, conversationManager)` in the `registerRoutes()` function alongside existing route registrations

## Phase 3: Testing

- [X] T006 [P] [US1] Write unit tests for `SessionReader` in `packages/orchestrator/tests/unit/services/session-reader.test.ts`
  - Test JSONL parsing: user messages, assistant messages with content blocks
  - Test tool result promotion: user entries with `tool_result` blocks → separate top-level messages
  - Test entry filtering: `queue-operation` and `last-prompt` excluded
  - Test metadata extraction: slug, branch, model from first assistant entry; token accumulation
  - Test corrupted line handling: skip bad lines, return valid messages
  - Test file discovery: with workspace (direct path lookup), without workspace (directory scan)
  - Use temp files or mocked filesystem

- [X] T007 [P] [US1] Write integration tests for sessions endpoint in `packages/orchestrator/tests/integration/routes/sessions.test.ts`
  - Use `server.inject()` pattern (see existing integration tests)
  - Test 200 response with correct message structure and metadata
  - Test 404 for unknown session ID
  - Test 400 for invalid workspace
  - Test workspace-scoped lookup via query parameter
  - Test `isActive` field (mock ConversationManager)
  - Create fixture JSONL files for test data

## Dependencies & Execution Order

```
T001 ─────┬──→ T002 ──→ T005
          │         ↘
          │    T003 ──→ T004 ──→ T005
          │
          └──→ T006 (parallel with T002-T004, uses same types)
                T007 (parallel with T006, after T005)
```

**Sequential dependencies**:
- T001 (types) must complete before T002, T003, T004
- T002 (SessionReader) and T003 (isSessionActive) must complete before T004 (route handler can use both)
- T004 + T005 (route registration) must complete before T007 (integration tests need full endpoint)

**Parallel opportunities**:
- T002 and T003 can run in parallel (different files)
- T006 (unit tests) can run in parallel with T004/T005 (unit tests only need SessionReader, not the route)
- T006 and T007 can run in parallel with each other (different test files)
