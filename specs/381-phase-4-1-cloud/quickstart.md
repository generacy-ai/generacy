# Quickstart: Interactive Conversation Proxy

## Prerequisites

- Node.js >= 20.0.0
- pnpm >= 9.x
- Claude CLI installed and authenticated
- Orchestrator running (local or via dev stack)

## Setup

### 1. Configure conversation workspaces

Add workspace mappings to your orchestrator config (env vars or config file):

```bash
# Environment variables
export CONVERSATIONS_WORKSPACES_PRIMARY="/home/node/workspace"
export CONVERSATIONS_WORKSPACES_DEV="/home/node/workspace-dev"
export CONVERSATIONS_MAX_CONCURRENT=3
```

Or in orchestrator config:
```json
{
  "conversations": {
    "maxConcurrent": 3,
    "workspaces": {
      "primary": "/home/node/workspace",
      "dev": "/home/node/workspace-dev"
    }
  }
}
```

### 2. Start the orchestrator

```bash
cd packages/orchestrator
pnpm dev
```

## Usage

### Start a conversation

```bash
curl -X POST http://localhost:3000/conversations \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "conversationId": "conv-001",
    "workingDirectory": "primary",
    "skipPermissions": true
  }'
```

Response:
```json
{
  "conversationId": "conv-001",
  "workspaceId": "primary",
  "skipPermissions": true,
  "startedAt": "2026-03-14T10:00:00.000Z",
  "state": "starting"
}
```

### Send a message

```bash
curl -X POST http://localhost:3000/conversations/conv-001/message \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "message": "What files are in the src directory?"
  }'
```

Response:
```json
{
  "conversationId": "conv-001",
  "accepted": true
}
```

Output arrives as `conversation` relay messages (cluster → cloud) or can be observed in orchestrator logs.

### Start with an initial command

```bash
curl -X POST http://localhost:3000/conversations \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "conversationId": "conv-002",
    "workingDirectory": "primary",
    "initialCommand": "/onboard-evaluate",
    "model": "claude-sonnet-4-6"
  }'
```

### List active conversations

```bash
curl http://localhost:3000/conversations \
  -H "x-api-key: YOUR_API_KEY"
```

Response:
```json
{
  "conversations": [
    {
      "conversationId": "conv-001",
      "workspaceId": "primary",
      "skipPermissions": true,
      "startedAt": "2026-03-14T10:00:00.000Z",
      "state": "active"
    }
  ],
  "maxConcurrent": 3
}
```

### End a conversation

```bash
curl -X DELETE http://localhost:3000/conversations/conv-001 \
  -H "x-api-key: YOUR_API_KEY"
```

Response:
```json
{
  "conversationId": "conv-001",
  "state": "ending"
}
```

## Relay Message Flow

When the relay is connected, conversation I/O flows as dedicated relay messages:

### Cloud → Cluster (user message)
```json
{
  "type": "conversation",
  "conversationId": "conv-001",
  "data": {
    "action": "message",
    "content": "What files are in the src directory?"
  }
}
```

### Cluster → Cloud (streamed output)
```json
{
  "type": "conversation",
  "conversationId": "conv-001",
  "data": {
    "event": "output",
    "payload": { "text": "Let me check the src directory for you." },
    "timestamp": "2026-03-14T10:00:01.234Z"
  }
}
```

```json
{
  "type": "conversation",
  "conversationId": "conv-001",
  "data": {
    "event": "tool_use",
    "payload": { "toolName": "Bash", "callId": "call_1", "input": { "command": "ls src/" } },
    "timestamp": "2026-03-14T10:00:02.000Z"
  }
}
```

## Testing

### Run unit tests

```bash
cd packages/orchestrator
pnpm test -- --grep "conversation"
```

### Manual end-to-end test

1. Start orchestrator: `pnpm dev`
2. Start a conversation via curl (see above)
3. Send messages and observe relay output in logs
4. End the conversation
5. Verify process cleanup: `ps aux | grep claude` (should show no orphans)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 429 on start | Max concurrent conversations reached. End an existing conversation or increase `maxConcurrent` |
| 400 "Unknown workspace" | Add the workspace identifier to `conversations.workspaces` config |
| No output events | Check orchestrator logs for CLI spawn errors. Verify Claude CLI is installed and authenticated |
| Process not cleaning up | Check orchestrator shutdown logs. Process should receive SIGTERM then SIGKILL after 5s grace |
| Relay messages not flowing | Verify relay connection (`GENERACY_API_KEY` set, cloud relay reachable) |
