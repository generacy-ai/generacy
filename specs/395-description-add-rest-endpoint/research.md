# Research: Add /sessions/:id REST Endpoint

## Technology Decisions

### JSONL Parsing Approach

**Decision**: Simple `readFile` + `split('\n')` + `JSON.parse` per line.

**Rationale**: This is the established pattern in the codebase (see `conversation-logger.test.ts`). No streaming library needed — session JSONL files are typically small enough to read entirely into memory. The `readFile` approach is simpler and sufficient for the < 500ms performance target.

**Alternative rejected**: `readline` or streaming JSONL parser — unnecessary complexity for files that are typically < 1MB. If performance becomes an issue for very large sessions, streaming can be added later.

### File Discovery

**Decision**: Use `readdir` to scan `~/.claude/projects/` directories when no workspace is specified.

**Rationale**: The number of project directories is small (typically < 20). A sequential scan with early exit on first match is fast enough. No database or index needed.

**Alternative rejected**: Caching/indexing session locations — premature optimization. The filesystem scan is effectively instant for the expected directory count.

### Active Session Detection

**Decision**: Iterate `ConversationManager.list()` and match on `sessionId`.

**Rationale**: The `ConversationHandle` already captures `sessionId` from Claude CLI output (via `ConversationOutputParser.onSessionId`). The conversation list is small (max 20 concurrent), so iteration is trivial.

**Note**: The `ConversationManager` is only available when workspaces are configured. When it's `null`, `isActive` defaults to `false`.

## Implementation Patterns

### Route Handler Pattern

Follow the existing `conversations.ts` pattern:
1. Export `setupSessionRoutes(server, manager?)` — manager is optional (may be null)
2. Use Zod for query parameter validation
3. Return RFC 7807 Problem Details for errors
4. Keep handler thin — delegate to `SessionReader` service

### Error Handling

| Scenario | Status | Detail |
|----------|--------|--------|
| Session JSONL not found | 404 | `Session {id} not found` |
| Invalid workspace ID | 400 | `Unknown workspace "{id}"` |
| JSONL parse error (corrupted line) | 200 | Skip corrupted lines, return what parsed successfully |
| Filesystem error | 500 | `Failed to read session data` |

### JSONL Line Skip Strategy

If a JSONL line fails to parse (corrupted/truncated due to in-progress write), skip it silently. This is safer than failing the entire request for one bad line at the end of an active session's file.

## Key Sources

- Existing route pattern: `packages/orchestrator/src/routes/conversations.ts`
- JSONL read pattern: `packages/orchestrator/src/worker/__tests__/conversation-logger.test.ts`
- ConversationManager API: `packages/orchestrator/src/conversation/conversation-manager.ts`
- Config schema: `packages/orchestrator/src/config/schema.ts`
- Session file location: spec clarification Q1 (path encoding: `/` → `-`)
