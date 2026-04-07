# Quickstart: Add /sessions/:id REST Endpoint

## Prerequisites

- Node.js + pnpm installed
- Development stack running (`/workspaces/tetrad-development/scripts/stack start`)
- Orchestrator configured with at least one workspace

## Development Setup

```bash
# Install dependencies
pnpm install

# Start dev server (from orchestrator package)
cd packages/orchestrator
pnpm dev
```

## Testing the Endpoint

### With a real session file

```bash
# Find an existing session ID
ls ~/.claude/projects/-workspaces-generacy/

# Fetch session history
curl http://localhost:3000/sessions/<sessionId>

# With workspace scoping
curl "http://localhost:3000/sessions/<sessionId>?workspace=generacy"
```

### Running tests

```bash
# All orchestrator tests
cd packages/orchestrator
pnpm test

# Just session tests
pnpm test -- --grep "session"

# Unit tests only (JSONL parsing)
pnpm test -- tests/unit/services/session-reader.test.ts

# Integration tests only (HTTP endpoint)
pnpm test -- tests/integration/routes/sessions.test.ts
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/orchestrator/src/routes/sessions.ts` | Route handler — HTTP concerns |
| `packages/orchestrator/src/services/session-reader.ts` | JSONL parsing + file discovery |
| `packages/orchestrator/src/server.ts` | Route registration (modified) |
| `packages/orchestrator/tests/unit/services/session-reader.test.ts` | Unit tests |
| `packages/orchestrator/tests/integration/routes/sessions.test.ts` | Integration tests |

## Architecture Notes

- **Route** (`sessions.ts`): Thin handler. Validates params/query with Zod, delegates to `SessionReader`, returns response or RFC 7807 error.
- **Service** (`session-reader.ts`): Encapsulates JSONL file discovery, reading, parsing, and message transformation. Stateless — takes config + ConversationManager reference in constructor.
- **Active detection**: Checks `ConversationManager.list()` for matching `sessionId`. Returns `isActive: false` if ConversationManager is null.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 404 for known session | Check `~/.claude/projects/` directory — verify path encoding matches |
| Empty messages array | Session file may only contain `queue-operation`/`last-prompt` entries |
| `isActive` always false | Ensure orchestrator has `conversations.workspaces` configured |
| Workspace not found | Check `ORCHESTRATOR_CONVERSATIONS_WORKSPACES` env var or config file |
