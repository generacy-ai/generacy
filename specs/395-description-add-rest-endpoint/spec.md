# Feature Specification: Add /sessions/:id REST Endpoint

Return full Claude Code conversation history for a given session by reading its JSONL file.

**Branch**: `395-description-add-rest-endpoint` | **Date**: 2026-03-19 | **Status**: Draft

## Summary

Add a REST endpoint to the orchestrator that reads Claude Code session JSONL files from the filesystem and returns structured conversation history — including user messages, assistant responses (text + tool_use blocks), tool results, and session metadata. The web UI will consume this to display complete conversation threads.

## Context

Claude Code stores full conversation history as JSONL files on disk (one file per session). The orchestrator already manages conversations and knows about workspace directories via `config.conversations.workspaces`. The web UI needs read access to completed/in-progress session data to render conversation threads with text, tool calls, and tool results.

The orchestrator already has:
- Fastify route infrastructure (`packages/orchestrator/src/routes/index.ts`)
- Workspace resolution (`ConversationManager` resolves `workspaceId` → filesystem path)
- SSE infrastructure for real-time events
- Conversation types in `packages/orchestrator/src/conversation/types.ts`

## User Stories

### US1: View Full Session History

**As a** web UI user,
**I want** to retrieve the complete conversation history for a Claude Code session,
**So that** I can review the full thread including text responses, tool calls, and tool results.

**Acceptance Criteria**:
- [ ] `GET /sessions/:sessionId` returns the full conversation as structured JSON
- [ ] Response includes all message types: user, assistant, tool results
- [ ] Assistant messages include content blocks (text + tool_use) with model and token usage
- [ ] Messages are ordered chronologically with timestamps

### US2: Scope Session Lookup to a Workspace

**As a** web UI user managing multiple workspaces,
**I want** to scope my session lookup to a specific workspace,
**So that** the lookup is fast and unambiguous.

**Acceptance Criteria**:
- [ ] `GET /sessions/:sessionId?workspace=<workspaceId>` searches only that workspace
- [ ] Returns 400 if workspace ID is not found in configuration
- [ ] Without `?workspace`, searches all configured workspaces

### US3: Session Metadata

**As a** web UI user,
**I want** to see session metadata alongside the conversation,
**So that** I can understand the context (branch, model, token usage) at a glance.

**Acceptance Criteria**:
- [ ] Response includes metadata: slug, branch, model, total tokens, message count
- [ ] Token totals are aggregated from individual assistant message usage blocks

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `GET /sessions/:sessionId` route registered in orchestrator | P1 | Add to `routes/index.ts` |
| FR-002 | Parse JSONL file line-by-line into structured messages | P1 | Handle `user`, `assistant`, `queue-operation`, `last-prompt` types |
| FR-003 | Return user messages with role, content, timestamp | P1 | |
| FR-004 | Return assistant messages with role, content blocks (text + tool_use), model, usage | P1 | Preserve `message.content[]` structure |
| FR-005 | Return tool results with tool_use_id, content, is_error | P1 | |
| FR-006 | Include session metadata (slug, branch, model, total tokens, message count) | P1 | Aggregate from message-level data |
| FR-007 | Accept `?workspace=<workspaceId>` query param to scope lookup | P1 | Use existing workspace resolution from config |
| FR-008 | Search all configured workspaces when no workspace specified | P2 | Stop at first match |
| FR-009 | Return 404 with descriptive message when session not found | P1 | |
| FR-010 | Return 400 for invalid workspace ID | P1 | |
| FR-011 | Preserve `uuid` and `parentUuid` fields for message threading | P2 | UI needs these for thread rendering |

## Session JSONL Structure

Each line in the JSONL file is a JSON object with a `type` field:

- **`user`** — User messages with `content` (text), `uuid`, `parentUuid`, timestamp
- **`assistant`** — Assistant responses with `message.content[]` (array of text/tool_use blocks), `message.model`, `message.usage` (input/output tokens), `uuid`, `parentUuid`
- **`queue-operation`** — Internal queue operations (may be skipped or minimally represented)
- **`last-prompt`** — Session continuation markers (may be skipped or minimally represented)

## API Response Shape

```jsonc
{
  "sessionId": "abc-123",
  "metadata": {
    "slug": "fix-auth-bug",
    "branch": "feature/auth",
    "model": "claude-sonnet-4-6",
    "totalInputTokens": 45000,
    "totalOutputTokens": 12000,
    "messageCount": 24
  },
  "messages": [
    {
      "type": "user",
      "uuid": "...",
      "parentUuid": "...",
      "content": "Fix the login bug",
      "timestamp": "2026-03-19T10:00:00Z"
    },
    {
      "type": "assistant",
      "uuid": "...",
      "parentUuid": "...",
      "content": [
        { "type": "text", "text": "I'll look at the auth module..." },
        { "type": "tool_use", "id": "tool_1", "name": "Read", "input": { "file_path": "/src/auth.ts" } }
      ],
      "model": "claude-sonnet-4-6",
      "usage": { "input_tokens": 1500, "output_tokens": 400 },
      "timestamp": "2026-03-19T10:00:01Z"
    },
    {
      "type": "tool_result",
      "tool_use_id": "tool_1",
      "content": "...",
      "is_error": false,
      "timestamp": "2026-03-19T10:00:02Z"
    }
  ]
}
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Endpoint returns valid structured JSON for any existing session | 100% | Integration test with sample JSONL files |
| SC-002 | Response time for typical session (<500 messages) | < 500ms | Load test |
| SC-003 | 404 returned for non-existent sessions | 100% | Unit test |
| SC-004 | Workspace scoping correctly limits search | 100% | Unit test with multiple workspaces |

## Assumptions

- Claude Code JSONL files are stored in a known location within each workspace directory (e.g., `~/.claude/projects/<project>/` or within the workspace path)
- The orchestrator process has filesystem read access to all configured workspace directories
- Session IDs are unique across the system (or unique within a workspace)
- JSONL files are not actively being written to during reads (or partial reads are acceptable)

## Out of Scope

- Real-time streaming of in-progress sessions (covered by existing SSE infrastructure)
- Writing or modifying session files
- Authentication/authorization for the endpoint (handled at a higher layer)
- Pagination of large session histories (can be added later if needed)
- Full-text search across sessions

## Phase

**Phase 1** — Can be worked on in parallel with other Phase 1 issues.

---

*Generated by speckit*
