# Research: Sessions REST Endpoint

## Technology Decisions

### JSONL Parsing: `node:readline` (stream-based)

**Choice**: Use `node:readline` with `fs.createReadStream()` to process session files line by line.

**Rationale**: Session JSONL files can grow large (hundreds of MB for long conversations with tool use). Loading entire files into memory with `fs.readFile` + `split('\n')` risks OOM for large sessions. `node:readline` processes one line at a time with constant memory overhead.

**Alternatives considered**:
- `fs.readFile` + `String.split('\n')` — simple but memory-unsafe for large files
- Third-party JSONL streaming library — unnecessary dependency for simple line-by-line parsing
- `ndjson` npm package — adds a dependency for trivial functionality

### Directory Scanning: `fs.readdir` with `withFileTypes`

**Choice**: Use `fs.readdir(dir, { withFileTypes: true })` to enumerate directories and `.jsonl` files.

**Rationale**: Built-in, no dependencies. `withFileTypes` avoids extra `stat` calls. For Phase 1 scanning, this is sufficient — the number of session directories and files is bounded by actual usage.

### Workspace Path Encoding

Claude Code encodes workspace paths by replacing `/` with `-`:
- `/workspaces/generacy` → `-workspaces-generacy`
- `/workspaces/todo-list-example1` → `-workspaces-todo-list-example1`

To decode: replace leading `-` then split on `-` and reconstruct... but this is ambiguous. Instead, encode the configured workspace paths and match against directory names.

**Reverse mapping strategy**: For `GET /sessions` without filter, scan all directories and attempt to match each against configured workspaces. For unrecognized directories, include them with `workspace: null` or the raw directory name decoded as best-effort.

### Session Type Inference

Per clarification Q2, Phase 1 uses a simple heuristic:
- Parse first `user` type message
- If `permissionMode === "bypassPermissions"` → `type: "automated"`
- Otherwise → `type: "developer"`

This is sufficient because orchestrator-spawned conversations always use `bypassPermissions`, while VS Code / CLI sessions use `"default"` or no `permissionMode` field.

## Implementation Patterns

### Service Pattern

Follow `WorkflowService` pattern:
- Service class with constructor accepting config
- Methods return typed Zod-validated response shapes
- Pagination computed in service layer (same as `InMemoryWorkflowStore.list()`)

### Route Pattern

Follow `setupWorkflowRoutes()`:
- Export `setupSessionRoutes(server, sessionService)`
- Use Fastify JSON schema for querystring validation
- Use Zod for runtime parsing (`ListSessionsQuerySchema.parse(request.query)`)
- Use `requireRead('sessions')` preHandler

### Response Envelope

```typescript
{
  sessions: SessionMetadata[],
  pagination: { page, pageSize, total, hasMore }
}
```

Matches `WorkflowListResponse` structure exactly.

## JSONL Message Types Reference

From actual Claude Code session files:

| `type` | Key Fields | Notes |
|--------|-----------|-------|
| `queue-operation` | `operation`, `timestamp`, `sessionId`, `content` | First line(s), enqueue/dequeue |
| `user` | `message`, `uuid`, `timestamp`, `userType`, `permissionMode`, `slug`, `gitBranch`, `sessionId` | User messages; `slug` may be null |
| `assistant` | `message.model`, `message.usage`, `uuid`, `timestamp`, `sessionId` | Model info is in nested `message` object |
| `last-prompt` | `lastPrompt`, `sessionId` | Terminal line, no timestamp |

### Field Locations

- **sessionId**: every line has it (also derivable from filename)
- **slug**: on `user` type messages, often null early in session, becomes set after a few turns
- **model**: `message.model` on `assistant` type messages
- **gitBranch**: on `user` type messages
- **permissionMode**: on `user` type messages
- **userType**: on `user` type messages (`"external"` for orchestrator, may differ for CLI)
- **timestamp**: on every line except `last-prompt`

## Key Sources

- Existing route: `packages/orchestrator/src/routes/workflows.ts`
- Existing types: `packages/orchestrator/src/types/api.ts`
- Existing service: `packages/orchestrator/src/services/workflow-service.ts`
- Session files: `~/.claude/projects/-workspaces-{name}/{uuid}.jsonl`
- Config: `packages/orchestrator/src/config/schema.ts` (`ConversationConfigSchema.workspaces`)
