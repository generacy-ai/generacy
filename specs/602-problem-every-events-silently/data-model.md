# Data Model: Canonical Relay Event Schema

## Before / After Comparison

### EventMessage (cluster-relay)

**Before** (`packages/cluster-relay/src/messages.ts:23-27`):
```typescript
export interface EventMessage {
  type: 'event';
  channel: string;     // event name
  event: unknown;      // payload
}

const EventMessageSchema = z.object({
  type: z.literal('event'),
  channel: z.string().min(1),
  event: z.unknown(),
});
```

**After**:
```typescript
export interface EventMessage {
  type: 'event';
  event: string;       // event name (e.g. 'cluster.audit')
  data: unknown;       // payload object
  timestamp: string;   // ISO 8601 timestamp
}

export const EventMessageSchema = z.object({
  type: z.literal('event'),
  event: z.string().min(1),
  data: z.unknown(),
  timestamp: z.string().datetime(),
});
```

### RelayMessage Union (cluster-relay)

**Before**: `EventMessage` included with `{channel, event}` shape. `RelayMessageSchema` not exported.

**After**: `EventMessage` included with `{event, data, timestamp}` shape. Both `EventMessageSchema` and `RelayMessageSchema` exported as named exports.

### Orchestrator Relay Types

**Before** (`packages/orchestrator/src/types/relay.ts`):
```typescript
// Two types with same discriminant — TS can't narrow
export interface RelayEvent {
  type: 'event';
  channel: string;
  event: unknown;
}

export interface RelayJobEvent {
  type: 'event';
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export type RelayMessage = RelayEvent | RelayJobEvent | /* ...other types */;
```

**After**:
```typescript
import { EventMessage } from '@generacy-ai/cluster-relay';

// Single EventMessage — no dual-discriminant trap
export type RelayMessage = EventMessage | /* ...other types (unchanged) */;
// RelayEvent and RelayJobEvent deleted
```

### PushEventFn (control-plane)

**Before** (`packages/control-plane/src/relay-events.ts`):
```typescript
export type PushEventFn = (channel: string, payload: unknown) => void;
```

**After**:
```typescript
export type PushEventFn = (event: string, data: unknown) => void;
```

### IPC HTTP Body (control-plane → orchestrator)

**Before** (`packages/control-plane/bin/control-plane.ts`):
```typescript
body: JSON.stringify({ channel, payload })
```

**After**:
```typescript
body: JSON.stringify({ event, data, timestamp: new Date().toISOString() })
```

### IPC Zod Schema (orchestrator handler)

**Before** (`packages/orchestrator/src/routes/internal-relay-events.ts`):
```typescript
z.object({
  channel: z.enum(ALLOWED_CHANNELS),
  payload: z.unknown(),
})
```

**After**:
```typescript
z.object({
  event: z.enum(ALLOWED_CHANNELS),
  data: z.unknown(),
  timestamp: z.string().datetime(),
})
```

## Wire Format

### Event message on WebSocket (JSON)

```json
{
  "type": "event",
  "event": "cluster.audit",
  "data": { "entries": [...] },
  "timestamp": "2026-05-12T18:00:00.000Z"
}
```

### IPC message (HTTP POST body)

```json
{
  "event": "cluster.audit",
  "data": { "entries": [...] },
  "timestamp": "2026-05-12T18:00:00.000Z"
}
```

## Field Mapping Reference

| Concept | Old cluster-relay | Old cloud | Canonical (new) |
|---------|------------------|-----------|-----------------|
| Message type | `type: 'event'` | `type: 'event'` | `type: 'event'` |
| Event name | `channel` | `event` | `event` |
| Payload | `event` | `data` | `data` |
| Timestamp | (absent) | (varies) | `timestamp` (required) |

## Validation Rules

- `event`: non-empty string, typically `cluster.<domain>` format
- `data`: any JSON-serializable value (validated by downstream consumers, not the schema)
- `timestamp`: ISO 8601 datetime string (`z.string().datetime()`)
- `type`: literal `'event'` (discriminant for union narrowing)
