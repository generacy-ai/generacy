# Research: SSE vs WebSocket Migration

## Technology Decision: Server-Sent Events

### Why SSE Over WebSocket

| Factor | WebSocket | SSE |
|--------|-----------|-----|
| Direction | Bidirectional | Unidirectional (server → client) |
| Protocol | ws:// (custom) | Standard HTTP |
| Load Balancing | Sticky sessions required | Standard HTTP LB works |
| Reconnection | Manual implementation | Built into protocol |
| Infrastructure | Special WebSocket support | Any HTTP server |
| Debugging | Requires WS tools | Browser DevTools work |
| Compression | Manual | HTTP gzip works |

**Our use case is unidirectional** - the server pushes events to clients. Clients don't need to send arbitrary messages back. Therefore, SSE is the better fit.

### SSE Protocol Overview

SSE uses standard HTTP with `text/event-stream` content type:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

event: workflow:progress
id: evt_001
data: {"workflowId": "wf_123", "progress": 50}

: this is a comment (heartbeat)

event: queue:updated
id: evt_002
data: {"action": "added"}
```

### Key SSE Features

1. **Event Types** - `event:` field allows filtering on client
2. **Event IDs** - `id:` field enables reconnection with `Last-Event-ID`
3. **Comments** - Lines starting with `:` are ignored (used for keep-alive)
4. **Retry** - `retry:` field tells client reconnection interval

### Browser EventSource API

```javascript
const source = new EventSource('/events', {
  withCredentials: true
});

source.addEventListener('workflow:progress', (e) => {
  const data = JSON.parse(e.data);
  console.log('Progress:', data.progress);
});

// Automatic reconnection built-in
source.onerror = (e) => {
  // Browser will auto-reconnect
};
```

## Implementation Patterns

### Fastify SSE Pattern

Fastify doesn't require a plugin for SSE. Use `reply.raw` directly:

```typescript
import type { FastifyReply, FastifyRequest } from 'fastify';

async function sseHandler(request: FastifyRequest, reply: FastifyReply) {
  // Set headers
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Keep connection alive
  const heartbeat = setInterval(() => {
    reply.raw.write(': heartbeat\n\n');
  }, 30000);

  // Handle client disconnect
  request.raw.on('close', () => {
    clearInterval(heartbeat);
    // Cleanup subscriptions
  });

  // Send events
  reply.raw.write(`event: connected\ndata: {}\n\n`);
}
```

### Event Formatting

```typescript
function formatSSEEvent(
  event: string,
  data: unknown,
  id?: string
): string {
  const lines: string[] = [];

  if (event) lines.push(`event: ${event}`);
  if (id) lines.push(`id: ${id}`);

  const jsonData = JSON.stringify(data);
  lines.push(`data: ${jsonData}`);

  return lines.join('\n') + '\n\n';
}
```

### Event ID Generation

For `Last-Event-ID` support:

```typescript
// Option 1: Timestamp + counter
let counter = 0;
function generateEventId(): string {
  return `${Date.now()}_${++counter}`;
}

// Option 2: UUID
import { randomUUID } from 'crypto';
function generateEventId(): string {
  return randomUUID();
}

// Option 3: Monotonic ID with connection prefix
function createIdGenerator(connectionId: string) {
  let seq = 0;
  return () => `${connectionId}_${++seq}`;
}
```

### Authentication Patterns

**Option A: Authorization Header (Recommended)**
```http
GET /events HTTP/1.1
Authorization: Bearer eyJhbGc...
Accept: text/event-stream
```

Works with any HTTP client. Standard approach.

**Option B: Query Parameter**
```http
GET /events?token=eyJhbGc... HTTP/1.1
Accept: text/event-stream
```

Required for browser EventSource (doesn't support custom headers).

**Option C: Cookie**
```http
GET /events HTTP/1.1
Cookie: session=abc123
Accept: text/event-stream
```

Works with browser EventSource + `withCredentials: true`.

### Reconnection Handling

Client sends `Last-Event-ID` header on reconnect:

```typescript
async function sseHandler(request: FastifyRequest, reply: FastifyReply) {
  const lastEventId = request.headers['last-event-id'];

  if (lastEventId) {
    // Resume from last event
    const missedEvents = await getEventsSince(lastEventId);
    for (const event of missedEvents) {
      reply.raw.write(formatSSEEvent(event.type, event.data, event.id));
    }
  }

  // Continue with live events
}
```

## Subscription Management

### Adapted SubscriptionManager

```typescript
import type { ServerResponse } from 'http';

type Channel = 'workflows' | 'queue' | 'agents';

interface SSEClient {
  response: ServerResponse;
  channels: Set<Channel>;
  filters: { workflowId?: string };
  lastEventId?: string;
}

class SSESubscriptionManager {
  private clients: Map<string, SSEClient> = new Map();

  addClient(clientId: string, response: ServerResponse, options: ClientOptions) {
    // Track client
  }

  removeClient(clientId: string) {
    // Cleanup
  }

  broadcast(channel: Channel, event: string, data: unknown) {
    for (const [id, client] of this.clients) {
      if (client.channels.has(channel)) {
        const formatted = formatSSEEvent(event, data, generateEventId());
        client.response.write(formatted);
      }
    }
  }
}
```

## Error Handling

### Error Event Type

```typescript
interface SSEErrorEvent {
  type: 'error';
  title: string;
  status: number;
  detail?: string;
  traceId?: string;
}

function sendError(response: ServerResponse, error: SSEErrorEvent) {
  response.write(formatSSEEvent('error', error));
}
```

### Connection-Level Errors

- **401 Unauthorized**: Return HTTP 401 before starting stream
- **403 Forbidden**: Return HTTP 403 before starting stream
- **500 Internal Error**: Send error event, then close connection

## Heartbeat / Keep-Alive

Proxies and load balancers may close idle connections. Send periodic comments:

```typescript
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

function startHeartbeat(response: ServerResponse): NodeJS.Timeout {
  return setInterval(() => {
    if (!response.writableEnded) {
      response.write(': heartbeat\n\n');
    }
  }, HEARTBEAT_INTERVAL);
}
```

## Connection Limits

Prevent resource exhaustion:

```typescript
const MAX_CONNECTIONS_PER_CLIENT = 3;
const connectionCounts = new Map<string, number>();

function canConnect(clientId: string): boolean {
  const count = connectionCounts.get(clientId) || 0;
  return count < MAX_CONNECTIONS_PER_CLIENT;
}
```

## Testing Considerations

### Unit Tests
- Event formatting
- Subscription management
- ID generation

### Integration Tests
- Endpoint responses
- Authentication
- Event delivery

### Manual Testing

```bash
# Using curl
curl -N -H "Authorization: Bearer TOKEN" http://localhost:3000/events

# Using httpie
http --stream GET http://localhost:3000/events Authorization:"Bearer TOKEN"
```

## Migration Notes

### Breaking Changes
- `/ws` endpoint removed
- Clients must update to use SSE endpoints
- Message format changes (SSE vs JSON WebSocket)

### Backward Compatibility (If Needed)
- Run both WS and SSE endpoints temporarily
- Use feature flag to control which is active
- Deprecation period before removing WS

## References

- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [HTML Spec: Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [Fastify Raw Response](https://fastify.dev/docs/latest/Reference/Reply/#raw)

---

*Generated by speckit*
