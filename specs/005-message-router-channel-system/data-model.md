# Data Model: Message Router and Channel System

## Core Entities

### MessageEnvelope

The universal wrapper for all routed messages.

```typescript
interface MessageEnvelope {
  /** Unique message identifier (UUID v4) */
  id: string;

  /** Correlation ID for request/response pairing */
  correlationId?: string;

  /** Message type determining routing rule */
  type: MessageType;

  /** Optional channel for plugin-defined routing */
  channel?: string;

  /** Message origin */
  source: MessageEndpoint;

  /** Explicit destination (optional for broadcast) */
  destination?: MessageEndpoint;

  /** Message-specific payload */
  payload: unknown;

  /** Metadata */
  meta: MessageMeta;
}

type MessageType =
  | 'decision_request'    // Agency → Humancy
  | 'decision_response'   // Humancy → Agency
  | 'mode_command'        // Router → Agency
  | 'workflow_event'      // Router → Humancy
  | 'channel_message';    // Plugin-defined routing

interface MessageEndpoint {
  type: 'agency' | 'humancy' | 'router';
  id: string;
}

interface MessageMeta {
  /** Unix timestamp (ms) when message was created */
  timestamp: number;

  /** Time-to-live in milliseconds (default: 3600000) */
  ttl?: number;

  /** Delivery priority (future use) */
  priority?: number;

  /** Number of delivery attempts */
  attempts?: number;
}
```

### Connection Types

```typescript
interface AgencyConnection {
  /** Unique agency instance identifier */
  id: string;

  /** Send a message to this agency */
  send(message: MessageEnvelope): Promise<void>;

  /** Register message handler */
  onMessage(handler: MessageHandler): void;

  /** Register disconnect handler */
  onDisconnect(handler: () => void): void;

  /** Close the connection */
  close(): Promise<void>;
}

interface HumancyConnection {
  /** Unique humancy instance identifier */
  id: string;

  /** Connection type */
  type: 'vscode' | 'cloud';

  /** Send a message to this humancy */
  send(message: MessageEnvelope): Promise<void>;

  /** Register message handler */
  onMessage(handler: MessageHandler): void;

  /** Register disconnect handler */
  onDisconnect(handler: () => void): void;

  /** Close the connection */
  close(): Promise<void>;
}

type MessageHandler = (message: MessageEnvelope) => void | Promise<void>;
```

### Connection Registry

```typescript
interface ConnectionRegistry {
  /** All registered agencies */
  agencies: Map<string, RegisteredConnection<AgencyConnection>>;

  /** All registered humancy instances */
  humancyInstances: Map<string, RegisteredConnection<HumancyConnection>>;
}

interface RegisteredConnection<T> {
  connection: T;
  status: 'online' | 'offline';
  registeredAt: number;
  lastSeenAt: number;
}
```

### Channel System

```typescript
interface Channel {
  /** Channel name (unique identifier) */
  name: string;

  /** Handler for messages on this channel */
  handler: ChannelHandler;

  /** Who registered this channel */
  registeredBy: string;

  /** Registration timestamp */
  registeredAt: number;
}

type ChannelHandler = (
  message: MessageEnvelope,
  context: ChannelContext
) => void | Promise<void>;

interface ChannelContext {
  /** Send response back to source */
  reply(payload: unknown): Promise<void>;

  /** Forward to another channel */
  forward(channel: string, payload: unknown): Promise<void>;
}
```

### Dead Letter Queue

```typescript
interface DeadLetterEntry {
  /** Original message */
  message: MessageEnvelope;

  /** Why the message failed */
  error: string;

  /** Failure timestamp */
  failedAt: number;

  /** Number of delivery attempts */
  attempts: number;

  /** Last attempt timestamp */
  lastAttemptAt: number;

  /** Status */
  status: 'pending_retry' | 'max_retries_exceeded' | 'manually_resolved';
}
```

### Correlation Tracking

```typescript
interface PendingCorrelation {
  /** Original request message */
  request: MessageEnvelope;

  /** When the request was sent */
  sentAt: number;

  /** Timeout deadline */
  deadline: number;

  /** Promise resolver */
  resolve: (response: MessageEnvelope) => void;

  /** Promise rejecter */
  reject: (error: Error) => void;
}
```

## Redis Key Patterns

```
# Connection tracking
connections:agency:{id}          → JSON: RegisteredConnection
connections:humancy:{id}         → JSON: RegisteredConnection

# Message queues (per recipient)
queue:agency:{id}                → Redis Stream
queue:humancy:{id}               → Redis Stream

# Dead letter queue
dlq:messages                     → Redis Stream
dlq:entry:{messageId}            → JSON: DeadLetterEntry

# Correlation tracking
correlation:{correlationId}      → JSON: PendingCorrelation

# Channel registry
channels:{name}                  → JSON: Channel

# TTL tracking
ttl:message:{messageId}          → (TTL key, expires automatically)
```

## Validation Rules

### MessageEnvelope
- `id`: Required, valid UUID v4
- `type`: Required, must be valid MessageType
- `source`: Required, valid endpoint
- `payload`: Required, can be any JSON-serializable value
- `meta.timestamp`: Required, valid Unix timestamp
- `meta.ttl`: Optional, positive integer (default: 3600000)

### Connections
- `id`: Required, unique per type (agency/humancy)
- `type` (Humancy): Required, must be 'vscode' or 'cloud'

### Channels
- `name`: Required, 1-64 chars, alphanumeric + underscore
- No reserved names: 'system', 'internal', 'router'

## Entity Relationships

```
┌─────────────────┐     routes      ┌─────────────────┐
│ AgencyConnection│◄───────────────►│ HumancyConnection│
└────────┬────────┘                 └────────┬────────┘
         │                                   │
         │ registers                         │ registers
         ▼                                   ▼
┌─────────────────┐                 ┌─────────────────┐
│ConnectionRegistry│                │ConnectionRegistry│
└────────┬────────┘                 └────────┬────────┘
         │                                   │
         └────────────┬─────────────────────┘
                      │
                      ▼
              ┌───────────────┐
              │ MessageRouter │
              └───────┬───────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
        ▼             ▼             ▼
┌───────────┐  ┌───────────┐  ┌───────────┐
│Correlation│  │ Channel   │  │ Dead      │
│ Manager   │  │ Registry  │  │ Letter Q  │
└───────────┘  └───────────┘  └───────────┘
```
