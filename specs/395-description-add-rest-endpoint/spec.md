# Feature Specification: Add /sessions/:id REST Endpoint

Add a REST endpoint that returns the full conversation history for a specific Claude Code session by reading its JSONL file

**Branch**: `395-description-add-rest-endpoint` | **Date**: 2026-03-19 | **Status**: Draft

## Summary

Add a `GET /sessions/:sessionId` REST endpoint that reads Claude Code session JSONL files and returns structured conversation history including messages, tool calls, tool results, and session metadata.

## Description

Add a REST endpoint that returns the full conversation history for a specific Claude Code session by reading its JSONL file.

## Context

Claude Code stores full conversation history as JSONL files. The web UI needs to display complete conversation threads including text, tool calls, and tool results.

## Requirements

- `GET /sessions/:sessionId` — Return full session history
- `GET /sessions/:sessionId?workspace={workspaceId}` — Scope to workspace
- Parse JSONL and return structured messages:
  - User messages (role, content, timestamp)
  - Assistant messages (role, content blocks including text + tool_use, model, usage)
  - Tool results — extracted from user-type JSONL entries and promoted to separate top-level messages (tool_use_id, content, is_error)
- Include session metadata (slug, branch, model, total tokens, file count, isActive)
- Handle sessions across workspace directories (search all configured workspaces if no workspace specified)
- Return 404 if session not found

## Session JSONL File Location

Session files are stored at `~/.claude/projects/<path-encoded>/<sessionId>.jsonl` where `<path-encoded>` is the workspace path with `/` replaced by `-`.

**Example**: workspace path `/workspaces/todo-list-example1` → `~/.claude/projects/-workspaces-todo-list-example1/`

**Lookup strategy**:
1. If `workspaceId` is provided, encode the workspace path and look in that specific directory
2. If no `workspaceId`, scan all directories under `~/.claude/projects/` for a matching `{sessionId}.jsonl` file

## Session JSONL Structure

Each line has `type`: `user`, `assistant`, `queue-operation`, `last-prompt`.
Messages have `parentUuid` for threading, `uuid` for identification.
Assistant messages include `message.content[]` with text/tool_use blocks and `message.usage` for token counts.

**Message type handling**:
- `user` and `assistant` types: Include in response as structured messages
- `user` entries with `tool_result` content blocks: Extract and promote each `tool_result` to a separate top-level message in the response
- `queue-operation` and `last-prompt` types: Exclude entirely from response; do not count in `messageCount`

**Metadata fields**:
- `slug` and `gitBranch` are present on JSONL entries (assistant-type and user-type tool result entries)
- Parse from the first assistant message in the file; null if no assistant message exists

## In-Progress Sessions

The endpoint serves partial data for active sessions (JSONL is append-only, partial reads are safe). Include `isActive: boolean` in metadata to let the frontend indicate session status. Determine active status by checking the orchestrator's `ConversationManager` for an active conversation with the matching `sessionId`.

## Phase

**Phase 1** — Can be worked on in parallel with other Phase 1 issues.

## User Stories

### US1: View Session History

**As a** developer using the Generacy web UI,
**I want** to retrieve the full conversation history for a Claude Code session,
**So that** I can review past interactions including text, tool calls, and results.

**Acceptance Criteria**:
- [ ] `GET /sessions/:sessionId` returns structured conversation history
- [ ] Tool results are extracted from user entries and presented as separate top-level messages
- [ ] Session metadata includes slug, branch, model, total tokens, and isActive status
- [ ] 404 returned when session not found
- [ ] Workspace scoping works via `?workspace={workspaceId}` query parameter

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Parse JSONL and return user/assistant messages with content blocks | P1 | |
| FR-002 | Extract tool_result blocks from user entries into separate top-level messages | P1 | |
| FR-003 | Exclude queue-operation and last-prompt entries entirely | P1 | |
| FR-004 | Parse slug and gitBranch from first assistant JSONL entry | P1 | Null if no assistant entry |
| FR-005 | Support workspace-scoped lookup via query parameter | P1 | |
| FR-006 | Scan all project dirs when no workspace specified | P2 | |
| FR-007 | Include isActive boolean in metadata for in-progress sessions | P1 | Check ConversationManager |
| FR-008 | Return 404 for unknown session IDs | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Endpoint returns correct message structure | 100% | Integration tests |
| SC-002 | Tool results correctly promoted to top-level | 100% | Unit tests with sample JSONL |
| SC-003 | Response time for typical session | < 500ms | Load test with representative JSONL files |

## Assumptions

- JSONL files are append-only and partial reads during active writes are acceptable
- The path encoding convention (replace `/` with `-`) is consistent across all workspaces
- The orchestrator's ConversationManager can be queried for active session status

## Out of Scope

- Real-time streaming of in-progress sessions (WebSocket/SSE)
- Modifying or deleting session data
- Authentication/authorization (handled by existing middleware)
- Pagination of message history

---

*Generated by speckit*
