# Data Model: SSE Migration

## Core Types

### SSE Event Types

```typescript
// Reuse existing workflow event types from websocket.ts
type WorkflowEventType =
  | 'workflow:started'
  | 'workflow:completed'
  | 'workflow:failed'
  | 'workflow:paused'
  | 'workflow:resumed'
  | 'workflow:cancelled'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'decision:requested'
  | 'decision:resolved';

// SSE-specific event types
type SSEEventType =
  | WorkflowEventType
  | 'queue:updated'
  | 'queue:item:added'
  | 'queue:item:removed'
  | 'agent:connected'
  | 'agent:disconnected'
  | 'agent:status'
  | 'error'
  | 'connected'; // Initial connection confirmation
```

### SSE Event Interface

```typescript
/**
 * Base SSE event structure
 */
interface SSEEvent {
  /** Event type (maps to SSE 'event:' field) */
  event: SSEEventType;
  /** Unique event ID (maps to SSE 'id:' field) */
  id: string;
  /** Event payload (serialized to SSE 'data:' field) */
  data: unknown;
  /** Event timestamp */
  timestamp: string;
}

/**
 * Workflow-specific event
 */
interface WorkflowSSEEvent extends SSEEvent {
  event: WorkflowEventType;
  data: {
    workflowId: string;
    stepId?: string;
    progress?: number;
    status?: string;
    error?: {
      type: string;
      message: string;
    };
    metadata?: Record<string, unknown>;
  };
}

/**
 * Queue update event
 */
interface QueueSSEEvent extends SSEEvent {
  event: 'queue:updated' | 'queue:item:added' | 'queue:item:removed';
  data: {
    action: 'added' | 'removed' | 'updated';
    item?: DecisionQueueItem;
    items?: DecisionQueueItem[];
    queueSize: number;
  };
}

/**
 * Agent status event
 */
interface AgentSSEEvent extends SSEEvent {
  event: 'agent:connected' | 'agent:disconnected' | 'agent:status';
  data: {
    agentId: string;
    status: 'connected' | 'disconnected' | 'busy' | 'idle';
    capabilities?: string[];
    metadata?: Record<string, unknown>;
  };
}

/**
 * Error event
 */
interface ErrorSSEEvent extends SSEEvent {
  event: 'error';
  data: {
    type: string;
    title: string;
    status: number;
    detail?: string;
    traceId?: string;
  };
}
```

### Subscription Types

```typescript
/**
 * Available SSE channels
 */
type SSEChannel = 'workflows' | 'queue' | 'agents';

/**
 * Subscription filter options
 */
interface SSEFilters {
  /** Filter to specific workflow */
  workflowId?: string;
  /** Filter by tags */
  tags?: string[];
}

/**
 * SSE client subscription
 */
interface SSESubscription {
  /** Subscribed channels */
  channels: Set<SSEChannel>;
  /** Active filters */
  filters: SSEFilters;
  /** Last event ID received (for reconnection) */
  lastEventId?: string;
}
```

### Client Connection

```typescript
import type { ServerResponse, IncomingMessage } from 'http';

/**
 * Active SSE connection
 */
interface SSEConnection {
  /** Unique connection identifier */
  id: string;
  /** Node.js response stream */
  response: ServerResponse;
  /** Original request (for correlation ID) */
  request: IncomingMessage;
  /** Client's user ID (from auth) */
  userId: string;
  /** Subscription configuration */
  subscription: SSESubscription;
  /** Connection established timestamp */
  connectedAt: Date;
  /** Heartbeat timer reference */
  heartbeatTimer: NodeJS.Timeout;
  /** Event ID generator for this connection */
  generateEventId: () => string;
}

/**
 * SSE connection options
 */
interface SSEConnectionOptions {
  /** Channels to subscribe to */
  channels?: SSEChannel[];
  /** Filter options */
  filters?: SSEFilters;
  /** Resume from last event ID */
  lastEventId?: string;
}
```

### SSE Stream Configuration

```typescript
/**
 * SSE stream configuration
 */
interface SSEStreamConfig {
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatInterval: number;
  /** Maximum connections per client (default: 3) */
  maxConnectionsPerClient: number;
  /** Buffer size for missed events (default: 100) */
  eventBufferSize: number;
  /** Event retention duration in ms (default: 60000) */
  eventRetentionMs: number;
}

/**
 * Default configuration
 */
const DEFAULT_SSE_CONFIG: SSEStreamConfig = {
  heartbeatInterval: 30000,
  maxConnectionsPerClient: 3,
  eventBufferSize: 100,
  eventRetentionMs: 60000,
};
```

## Type Relationships

```
SSEConnection
    ├── SSESubscription
    │       ├── channels: Set<SSEChannel>
    │       └── filters: SSEFilters
    └── response: ServerResponse

SSEEvent (union)
    ├── WorkflowSSEEvent
    ├── QueueSSEEvent
    ├── AgentSSEEvent
    └── ErrorSSEEvent
```

## Validation Schemas

```typescript
import { z } from 'zod';

/**
 * SSE channel validation
 */
export const SSEChannelSchema = z.enum(['workflows', 'queue', 'agents']);

/**
 * SSE filters validation
 */
export const SSEFiltersSchema = z.object({
  workflowId: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
}).optional();

/**
 * Query parameters for SSE endpoints
 */
export const SSEQuerySchema = z.object({
  channels: z.string().optional(), // comma-separated
  workflowId: z.string().uuid().optional(),
});

/**
 * Parse channels from query string
 */
export function parseChannels(channelsParam?: string): SSEChannel[] {
  if (!channelsParam) {
    return ['workflows', 'queue', 'agents']; // default: all
  }
  const channels = channelsParam.split(',').map(c => c.trim());
  return channels.filter(c =>
    SSEChannelSchema.safeParse(c).success
  ) as SSEChannel[];
}
```

## Event ID Format

```typescript
/**
 * Event ID structure
 * Format: {timestamp}_{connectionId}_{sequence}
 * Example: 1706123456789_conn_abc123_42
 */
interface EventIdComponents {
  timestamp: number;
  connectionId: string;
  sequence: number;
}

/**
 * Parse event ID components
 */
function parseEventId(id: string): EventIdComponents | null {
  const parts = id.split('_');
  if (parts.length < 3) return null;

  const timestamp = parseInt(parts[0], 10);
  const connectionId = parts.slice(1, -1).join('_');
  const sequence = parseInt(parts[parts.length - 1], 10);

  if (isNaN(timestamp) || isNaN(sequence)) return null;

  return { timestamp, connectionId, sequence };
}
```

## Migration Mapping

### WebSocket → SSE Type Mapping

| WebSocket Type | SSE Event Type |
|----------------|----------------|
| `WorkflowEventMessage` | `workflow:*` events |
| `QueueUpdateMessage` | `queue:updated` |
| `AgentStatusMessage` | `agent:status` |
| `PongMessage` | `: heartbeat` (comment) |
| `ErrorMessage` | `error` event |

### Message Format Comparison

**WebSocket (JSON)**:
```json
{
  "type": "workflow_event",
  "payload": {
    "event": "workflow:started",
    "workflowId": "wf_123",
    "timestamp": "2024-01-24T10:00:00Z"
  }
}
```

**SSE (text/event-stream)**:
```
event: workflow:started
id: 1706097600000_conn_abc_1
data: {"workflowId":"wf_123","timestamp":"2024-01-24T10:00:00Z"}

```

---

*Generated by speckit*
