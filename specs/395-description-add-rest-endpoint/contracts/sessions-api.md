# API Contract: GET /sessions/:sessionId

## Endpoint

```
GET /sessions/:sessionId
GET /sessions/:sessionId?workspace={workspaceId}
```

## Parameters

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | Yes | Claude Code session identifier (1-128 chars) |

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | No | Workspace identifier to scope the lookup. If omitted, scans all project directories. |

## Response

### 200 OK

```json
{
  "metadata": {
    "sessionId": "abc123-def456",
    "slug": "partitioned-shimmying-forest",
    "branch": "main",
    "model": "claude-sonnet-4-20250514",
    "totalInputTokens": 15234,
    "totalOutputTokens": 8921,
    "messageCount": 12,
    "isActive": false
  },
  "messages": [
    {
      "role": "user",
      "uuid": "msg-001",
      "parentUuid": null,
      "timestamp": "2026-03-19T10:00:00.000Z",
      "content": [
        {
          "type": "text",
          "text": "Help me fix the login bug"
        }
      ]
    },
    {
      "role": "assistant",
      "uuid": "msg-002",
      "parentUuid": "msg-001",
      "timestamp": "2026-03-19T10:00:05.000Z",
      "content": [
        {
          "type": "text",
          "text": "I'll look into the login issue."
        },
        {
          "type": "tool_use",
          "id": "tool-001",
          "name": "Read",
          "input": { "file_path": "/src/auth/login.ts" }
        }
      ],
      "model": "claude-sonnet-4-20250514",
      "usage": {
        "input_tokens": 1523,
        "output_tokens": 892
      }
    },
    {
      "role": "tool_result",
      "uuid": "msg-003",
      "parentUuid": "msg-002",
      "timestamp": "2026-03-19T10:00:06.000Z",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "tool-001",
          "content": "file contents here...",
          "is_error": false
        }
      ]
    }
  ]
}
```

### 400 Bad Request

Returned when the workspace query parameter references an unknown workspace.

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Unknown workspace \"invalid-ws\". Available: ws1, ws2"
}
```

### 404 Not Found

Returned when no JSONL file exists for the given session ID.

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "Session abc123-def456 not found"
}
```

### 500 Internal Server Error

Returned on filesystem or unexpected errors.

```json
{
  "type": "about:blank",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "Failed to read session data"
}
```

## Notes

- Corrupted JSONL lines (e.g., from in-progress writes) are silently skipped
- `isActive` is `true` only when `ConversationManager` reports an active conversation with a matching `sessionId`
- `slug` and `branch` are `null` if no assistant-type entry exists in the JSONL file
- Messages are returned in file order (chronological, as appended to JSONL)
- `queue-operation` and `last-prompt` JSONL entry types are excluded entirely
