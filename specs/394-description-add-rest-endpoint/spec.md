# Feature Specification: Sessions REST Endpoint

Add a REST endpoint to the orchestrator that reads Claude Code's native session storage and returns session metadata.

**Branch**: `394-description-add-rest-endpoint` | **Date**: 2026-03-19 | **Status**: Draft

## Summary

The orchestrator needs a `GET /sessions` endpoint that reads Claude Code's JSONL session files from the devcontainer filesystem and returns parsed session metadata. This replaces Firestore as the source of truth for conversation data, making the devcontainer authoritative.

## Context

Claude Code stores conversation sessions as JSONL files at `~/.claude/projects/{project-path}/{sessionId}.jsonl`. These include sessions from:
- Interactive conversations started via the web UI
- VS Code Claude Code sessions from the developer
- Automated workflow conversations

Currently conversations are stored in Firestore, but we want to use the devcontainer as the single source of truth.

## Session File Format

Files: `~/.claude/projects/-workspaces-{name}/{uuid}.jsonl`

Each line is a JSON object with `type` field: `queue-operation`, `user`, `assistant`, `last-prompt`.

Key fields per message: `sessionId`, `uuid`, `timestamp`, `type`, `slug`, `gitBranch`, `message.model`, `message.usage`.

## User Stories

### US1: Frontend Lists Sessions

**As a** frontend developer viewing the Generacy dashboard,
**I want** to fetch a list of all Claude Code sessions via REST API,
**So that** I can display session history without depending on Firestore.

**Acceptance Criteria**:
- [ ] `GET /sessions` returns a JSON array of session metadata objects
- [ ] Each session includes `sessionId`, `slug`, `startedAt`, `lastActivityAt`, `messageCount`, `model`, `gitBranch`, and `type`
- [ ] Sessions are sorted by `lastActivityAt` descending by default

### US2: Filter Sessions by Workspace

**As a** user managing multiple workspaces,
**I want** to filter sessions by workspace,
**So that** I only see sessions relevant to my current context.

**Acceptance Criteria**:
- [ ] `GET /sessions?workspace={workspaceId}` returns only sessions from the specified workspace
- [ ] Invalid workspace IDs return an empty array (not an error)

### US3: Paginate Session Results

**As a** frontend consuming the API,
**I want** pagination support,
**So that** I can efficiently load sessions without fetching the entire history at once.

**Acceptance Criteria**:
- [ ] `?limit=N&offset=N` query parameters control pagination
- [ ] Response includes total count for pagination UI

### US4: Distinguish Session Types

**As a** user reviewing session history,
**I want** to see whether a session was interactive or automated,
**So that** I can distinguish my own conversations from workflow-driven ones.

**Acceptance Criteria**:
- [ ] Each session has a `type` field: `interactive` or `workflow`
- [ ] Type is inferred from `permissionMode` or `userType` in the JSONL data

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `GET /sessions` lists all sessions across configured workspaces | P1 | Core endpoint |
| FR-002 | `GET /sessions?workspace={workspaceId}` filters by workspace | P1 | Query parameter filter |
| FR-003 | Parse JSONL files to extract session metadata | P1 | `sessionId`, `slug`, `startedAt`, `lastActivityAt`, `messageCount`, `model`, `gitBranch`, `type` |
| FR-004 | Sort results by `lastActivityAt` descending | P1 | Default sort order |
| FR-005 | Support `?limit=N&offset=N` pagination | P1 | Include total count in response |
| FR-006 | Infer session `type` from `permissionMode` or `userType` | P2 | `interactive` vs `workflow` |
| FR-007 | Derive `slug` from assistant messages | P2 | Human-readable session name |
| FR-008 | Handle malformed or incomplete JSONL files gracefully | P1 | Skip bad lines, log warnings |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Endpoint responds within acceptable latency | < 500ms for typical workspace (< 100 sessions) | Manual timing / integration test |
| SC-002 | All required metadata fields populated | 100% for well-formed sessions | Integration test assertions |
| SC-003 | Pagination works correctly | Offset + limit return correct slices | Unit tests |
| SC-004 | Graceful handling of edge cases | No 500 errors on malformed files | Error scenario tests |

## Assumptions

- The orchestrator process has filesystem access to `~/.claude/projects/` in the devcontainer
- Workspace names map to directory names under `~/.claude/projects/` (e.g., `-workspaces-{name}`)
- JSONL files follow the documented format with `type`, `sessionId`, `timestamp` fields
- Session count per workspace is manageable for in-memory parsing (< 1000 sessions)

## Out of Scope

- Session message content (full conversation) — this endpoint returns metadata only
- Write operations (create/update/delete sessions)
- Real-time updates / streaming (SSE for session changes)
- Authentication/authorization on the endpoint (handled at a higher level)
- Migration of existing Firestore data

---

*Generated by speckit*
