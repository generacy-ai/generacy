# Quickstart: SSE Events API

## Overview

The orchestrator provides real-time event streams via Server-Sent Events (SSE). Clients can subscribe to workflow progress, queue updates, and agent status changes.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /events` | Global event stream (all channels) |
| `GET /workflows/:id/events` | Workflow-specific events |
| `GET /queue/events` | Queue update events |

## Authentication

All SSE endpoints require authentication via Bearer token:

```bash
curl -N \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/events
```

## Basic Usage

### JavaScript (Browser)

```javascript
// Using EventSource (standard browser API)
const token = 'your-jwt-token';

// Note: EventSource doesn't support custom headers
// Use query parameter for auth or cookies
const source = new EventSource('/events?token=' + token);

// Listen for specific event types
source.addEventListener('workflow:started', (e) => {
  const data = JSON.parse(e.data);
  console.log('Workflow started:', data.workflowId);
});

source.addEventListener('workflow:progress', (e) => {
  const data = JSON.parse(e.data);
  console.log(`Progress: ${data.progress}%`);
});

// Handle errors
source.onerror = (e) => {
  if (source.readyState === EventSource.CLOSED) {
    console.log('Connection closed');
  } else {
    console.log('Error, will reconnect...');
  }
};

// Close when done
source.close();
```

### JavaScript (Node.js)

```javascript
import EventSource from 'eventsource';

const source = new EventSource('http://localhost:3000/events', {
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN'
  }
});

source.onmessage = (e) => {
  console.log('Event:', e.data);
};

source.addEventListener('workflow:completed', (e) => {
  console.log('Workflow completed:', JSON.parse(e.data));
});
```

### cURL

```bash
# Stream all events
curl -N \
  -H "Authorization: Bearer TOKEN" \
  -H "Accept: text/event-stream" \
  http://localhost:3000/events

# Stream specific workflow events
curl -N \
  -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/workflows/wf_abc123/events

# Stream queue events only
curl -N \
  -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/queue/events
```

## Query Parameters

### Channel Filtering

Filter to specific channels:

```bash
# Only workflow events
curl -N -H "Authorization: Bearer TOKEN" \
  "http://localhost:3000/events?channels=workflows"

# Workflows and queue
curl -N -H "Authorization: Bearer TOKEN" \
  "http://localhost:3000/events?channels=workflows,queue"
```

### Workflow Filtering

Filter to specific workflow:

```bash
curl -N -H "Authorization: Bearer TOKEN" \
  "http://localhost:3000/events?workflowId=wf_abc123"
```

## Event Format

Events follow the SSE specification:

```
event: workflow:progress
id: 1706097600000_conn_abc_42
data: {"workflowId":"wf_abc","step":"verify","progress":75}

event: queue:updated
id: 1706097600001_conn_abc_43
data: {"action":"added","item":{"id":"qi_xyz"}}

: heartbeat

event: error
id: 1706097600002_conn_abc_44
data: {"type":"error","title":"Rate Limited","status":429}
```

### Event Fields

| Field | Description |
|-------|-------------|
| `event` | Event type (e.g., `workflow:progress`) |
| `id` | Unique event ID for reconnection |
| `data` | JSON payload |
| `:` | Comment (heartbeat, ignored by client) |

## Event Types

### Workflow Events

| Event | Description |
|-------|-------------|
| `workflow:started` | Workflow execution began |
| `workflow:completed` | Workflow finished successfully |
| `workflow:failed` | Workflow failed with error |
| `workflow:paused` | Workflow paused (awaiting decision) |
| `workflow:resumed` | Workflow resumed after decision |
| `workflow:cancelled` | Workflow was cancelled |
| `step:started` | Step execution began |
| `step:completed` | Step finished successfully |
| `step:failed` | Step failed with error |
| `decision:requested` | Human decision required |
| `decision:resolved` | Human decision provided |

### Queue Events

| Event | Description |
|-------|-------------|
| `queue:updated` | Queue state changed |
| `queue:item:added` | New item added to queue |
| `queue:item:removed` | Item removed from queue |

### Agent Events

| Event | Description |
|-------|-------------|
| `agent:connected` | Agent connected to orchestrator |
| `agent:disconnected` | Agent disconnected |
| `agent:status` | Agent status update |

### System Events

| Event | Description |
|-------|-------------|
| `connected` | Initial connection confirmation |
| `error` | Error notification |

## Reconnection

SSE supports automatic reconnection. The client can resume from the last received event:

```javascript
// Browser EventSource handles this automatically
// For custom clients, use Last-Event-ID header:
```

```bash
curl -N \
  -H "Authorization: Bearer TOKEN" \
  -H "Last-Event-ID: 1706097600000_conn_abc_42" \
  http://localhost:3000/events
```

The server will replay any missed events since that ID.

## Heartbeats

The server sends periodic heartbeat comments to keep the connection alive:

```
: heartbeat
```

Default interval is 30 seconds. Clients should expect and ignore these.

## Error Handling

### HTTP Errors

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid auth token |
| 403 | Insufficient permissions |
| 404 | Resource not found (e.g., invalid workflow ID) |
| 429 | Too many connections |

### Stream Errors

Errors during streaming are sent as events:

```
event: error
data: {"type":"error","title":"Internal Error","status":500,"detail":"..."}
```

## Connection Limits

- Maximum 3 concurrent SSE connections per client
- Connections are automatically closed after extended inactivity
- Reconnection is automatic (browser) or use `Last-Event-ID` (custom)

## Troubleshooting

### Connection Closes Immediately

1. Check authentication token is valid
2. Verify you're not exceeding connection limits
3. Check server logs for errors

### Missing Events

1. Ensure you're listening to correct event types
2. Check channel/filter parameters
3. Use `Last-Event-ID` header after reconnection

### Buffering Issues

Add `X-Accel-Buffering: no` header if behind nginx:

```nginx
location /events {
  proxy_buffering off;
  proxy_cache off;
}
```

---

*Generated by speckit*
