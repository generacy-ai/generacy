# Quickstart: Sessions REST Endpoint

## Prerequisites

- Orchestrator running (`pnpm dev` in `packages/orchestrator`)
- Claude Code sessions exist at `~/.claude/projects/`

## Usage

### List all sessions

```bash
curl http://localhost:3000/sessions \
  -H "Authorization: Bearer <api-key>"
```

### Filter by workspace

```bash
curl "http://localhost:3000/sessions?workspace=main" \
  -H "Authorization: Bearer <api-key>"
```

### Paginate

```bash
curl "http://localhost:3000/sessions?page=2&pageSize=10" \
  -H "Authorization: Bearer <api-key>"
```

### Example response

```json
{
  "sessions": [
    {
      "sessionId": "9d03592b-5856-4cab-956b-57ac2b8db6cf",
      "slug": "majestic-baking-parasol",
      "startedAt": "2026-03-14T16:54:13.545Z",
      "lastActivityAt": "2026-03-14T17:02:36.871Z",
      "messageCount": 12,
      "model": "claude-opus-4-6",
      "gitBranch": "382-phase-4-2-cloud",
      "type": "automated",
      "workspace": "/workspaces/generacy"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 42,
    "hasMore": true
  }
}
```

## Files Modified

| File | Change |
|------|--------|
| `src/routes/sessions.ts` | New route handler |
| `src/services/session-service.ts` | New service (JSONL parsing, discovery) |
| `src/types/api.ts` | Session schemas added |
| `src/routes/index.ts` | Route registration |
| `src/server.ts` | Service wiring |

## Testing

```bash
# Unit tests (JSONL parsing)
pnpm test -- --grep "SessionService"

# Integration tests (route)
pnpm test -- --grep "GET /sessions"
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Empty response | Check `~/.claude/projects/` contains session directories |
| 401 Unauthorized | API key needs `sessions:read` scope |
| Workspace filter returns nothing | Verify workspace name matches orchestrator config key |
| Slow response | Many large JSONL files — Phase 2 will add caching |
