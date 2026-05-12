# Data Model: EventMessage Wire Format

**Feature**: #600 — Fix swapped field names in relay event IPC handler

## Wire Format (Cloud-Expected)

The cloud relay message handler expects event messages in this shape:

```typescript
{
  type: 'event';       // discriminator
  event: string;       // channel name, e.g. 'cluster.vscode-tunnel'
  data: unknown;       // payload object
  timestamp: string;   // ISO 8601 datetime
}
```

## Local TypeScript Interface (Current — NOT matching wire)

```typescript
// packages/cluster-relay/src/messages.ts:23-27
interface EventMessage {
  type: 'event';
  channel: string;   // should be "event" on wire
  event: unknown;    // should be "data" on wire
  // missing: timestamp
}
```

**Note**: Updating this interface is out of scope (#572). The handler uses `as unknown as RelayMessage` to bridge the gap.

## IPC Request Schema

```typescript
// packages/orchestrator/src/routes/internal-relay-events.ts
const RelayEventRequestSchema = z.object({
  channel: z.enum([
    'cluster.vscode-tunnel',
    'cluster.audit',
    'cluster.credentials',
    'cluster.bootstrap',
  ]),
  payload: z.unknown(),
});
```

This schema is correct and unchanged. The bug is only in the transformation from this request body to the outgoing WebSocket message.

## Transformation (Fixed)

```
IPC Request Body          →  WebSocket Message (wire)
─────────────────────────    ──────────────────────────
{ channel, payload }      →  { type: 'event',
                               event: channel,
                               data: payload,
                               timestamp: new Date().toISOString() }
```
