# Implementation Plan: Sessions REST Endpoint

**Feature**: Add a REST endpoint to read Claude Code's native session storage and return session metadata
**Branch**: `394-description-add-rest-endpoint`
**Status**: Complete

## Summary

Add `GET /sessions` endpoint to the orchestrator that scans `~/.claude/projects/` directories, parses Claude Code JSONL session files, and returns paginated session metadata. This is a read-only endpoint that treats the devcontainer filesystem as the single source of truth for conversation sessions.

## Technical Context

- **Runtime**: Node.js / TypeScript
- **Framework**: Fastify v5 with Zod validation
- **Existing patterns**: follows `GET /workflows` pagination & response envelope
- **Auth**: reuses existing `requireRead` preHandler middleware
- **No new dependencies** — uses `node:fs/promises`, `node:readline`, `node:os`, `node:path`

## Architecture

```
Route (sessions.ts)
  └─ SessionService (session-service.ts)
       ├── discoverDirectories()   — scan ~/.claude/projects/
       ├── parseSessionFile()      — stream-parse JSONL → SessionMetadata
       └── list()                  — filter, sort, paginate → SessionListResponse
```

The service is stateless — every request reads from disk. No caching in Phase 1 (files are small and the endpoint is low-frequency).

## Project Structure

```
packages/orchestrator/src/
├── routes/
│   └── sessions.ts               # NEW — GET /sessions route
├── services/
│   └── session-service.ts         # NEW — JSONL parsing & session discovery
├── types/
│   └── api.ts                     # MODIFY — add Session types & schemas
├── routes/
│   └── index.ts                   # MODIFY — register session routes
├── server.ts                      # MODIFY — wire SessionService, register route
tests/
├── unit/
│   └── session-service.test.ts    # NEW — parsing & discovery tests
└── integration/
    └── routes/
        └── sessions.test.ts       # NEW — route integration tests
```

## Data Flow

1. **Request**: `GET /sessions?workspace=main&page=1&pageSize=20`
2. **Route** validates query params via Zod schema
3. **SessionService.list()** is called:
   a. **Discover**: scan `~/.claude/projects/` for directories, optionally filter by workspace
   b. **Map workspace**: if `?workspace=main`, look up `main` → `/workspaces/generacy` in config, encode to `-workspaces-generacy`, scan only that directory
   c. **Parse**: for each `.jsonl` file, stream-parse lines to extract metadata:
      - `sessionId` — from filename (UUID before `.jsonl`)
      - `slug` — last non-null `slug` from user messages
      - `startedAt` — timestamp of first message
      - `lastActivityAt` — timestamp of last message
      - `messageCount` — count of `user` + `assistant` type lines
      - `model` — `message.model` from first assistant message
      - `gitBranch` — from first user message with `gitBranch`
      - `type` — `automated` if `permissionMode === "bypassPermissions"`, else `developer`
      - `workspace` — decoded from directory name (e.g., `-workspaces-generacy` → `/workspaces/generacy`)
   d. **Sort**: by `lastActivityAt` descending
   e. **Paginate**: apply `page`/`pageSize`
4. **Response**: `{ sessions: [...], pagination: { page, pageSize, total, hasMore } }`

## JSONL Parsing Strategy

Claude Code session files can be large. Use `node:readline` to stream-parse line by line rather than loading the entire file into memory. For metadata extraction, we only need to scan:
- First few lines: `sessionId`, `startedAt`, `permissionMode`, `gitBranch`
- First assistant message: `model`
- Last user message with slug: `slug`
- Last line: `lastActivityAt`
- All lines: count `user`/`assistant` types for `messageCount`

For Phase 1, do a full scan of each file (simple, correct). Optimization with early termination can come later if needed.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pagination | `page/pageSize` | Match existing `GET /workflows` convention (per clarification Q1) |
| Response envelope | `{ sessions, pagination }` | Match existing pattern (per clarification Q5) |
| Session discovery | Scan all `~/.claude/projects/` dirs | Auto-discover all sessions including ad-hoc (per clarification Q4) |
| Workspace mapping | Path encoding: `/` → `-` | Claude Code convention (per clarification Q3) |
| Type inference | Simple: `bypassPermissions` → `automated`, else `developer` | Phase 1 heuristic (per clarification Q2) |
| Caching | None (Phase 1) | Low-frequency endpoint, files are small |
| Auth scope | `sessions:read` | New scope, consistent with `workflows:read` pattern |

## Auth Scope

Add `sessions:read` to the `ApiScopeSchema` enum in `types/api.ts`. The sessions route uses `requireRead('sessions')` preHandler, matching the workflows pattern.

## Error Handling

- If `~/.claude/projects/` doesn't exist → return empty `{ sessions: [], pagination: { ... total: 0 } }`
- If a workspace filter doesn't match a known config entry → still try to scan all dirs, match by decoded path
- If a JSONL file is malformed/truncated → skip that file, log warning, continue
- If a JSONL line is invalid JSON → skip that line, continue parsing

## Constitution Check

No constitution.md found — no constraints to verify against.
