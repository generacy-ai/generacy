# Data Model: Control-plane relay event IPC channel

**Feature**: #594 — Control-plane relay events silently dropped
**Date**: 2026-05-12

## Core Types

### RelayEventRequest (new — orchestrator endpoint body)

```typescript
// Zod schema for POST /internal/relay-events request body
import { z } from 'zod';

export const RelayEventRequestSchema = z.object({
  channel: z.string().min(1),
  payload: z.unknown(),
});

export type RelayEventRequest = z.infer<typeof RelayEventRequestSchema>;
```

**Validation rules**:
- `channel`: non-empty string, required
- `payload`: any JSON-serializable value (matches existing `EventMessage.event: unknown`)

**Optional hardening (P2, FR-006)**: Channel allowlist

```typescript
const ALLOWED_CHANNELS = [
  'cluster.vscode-tunnel',
  'cluster.audit',
  'cluster.credentials',
  'cluster.bootstrap',
] as const;

export const RelayEventRequestSchema = z.object({
  channel: z.enum(ALLOWED_CHANNELS),
  payload: z.unknown(),
});
```

### Existing Types (no changes)

#### PushEventFn (control-plane/src/relay-events.ts)

```typescript
export type PushEventFn = (channel: string, payload: unknown) => void;
```

Already defined. The HTTP callback injected via `setRelayPushEvent()` conforms to this signature.

#### EventMessage (cluster-relay/src/messages.ts)

```typescript
export interface EventMessage {
  type: 'event';
  channel: string;
  event: unknown;
}
```

Already defined. The orchestrator endpoint constructs this from `RelayEventRequest`:
```typescript
{ type: 'event', channel: body.channel, event: body.payload }
```

#### ApiKeyCredential (orchestrator apiKeyStore)

```typescript
interface ApiKeyCredential {
  name: string;
  scopes: string[];
  createdAt: string;
}
```

Already defined. New entry added at boot:
```typescript
apiKeyStore.addKey(controlPlaneKey, {
  name: 'control-plane-internal',
  scopes: ['relay-events'],
  createdAt: new Date().toISOString(),
});
```

## Data Flow

```
control-plane process                    orchestrator process
─────────────────────                    ────────────────────
setRelayPushEvent(callback)
        │
        ▼
getRelayPushEvent() → callback
        │
        ▼
callback(channel, payload)
        │
        ▼
fetch('http://127.0.0.1:3100            POST /internal/relay-events
       /internal/relay-events', {  ──►   { channel, payload }
  headers: { authorization:                      │
    'Bearer <INTERNAL_KEY>' },                   ▼
  body: { channel, payload }             Zod validate
})                                               │
        │                                        ▼
        ▼                                apiKeyStore.verify(token)
.catch(log error)                                │
                                                 ▼
                                         relayClient.send({
                                           type: 'event',
                                           channel,
                                           event: payload,
                                         })
                                                 │
                                                 ▼
                                         WebSocket → cloud relay
```

## Environment Variables

| Variable | Process | Required | Default | Description |
|----------|---------|----------|---------|-------------|
| `ORCHESTRATOR_INTERNAL_API_KEY` | Both | No (graceful degradation) | `undefined` | Shared ephemeral UUID for IPC auth |
| `ORCHESTRATOR_URL` | control-plane | No | `http://127.0.0.1:3100` | Orchestrator HTTP base URL |

## Relationships

```
┌─────────────────────────────────────────────────┐
│                   Container                     │
│                                                 │
│  ┌──────────────┐       ┌────────────────────┐  │
│  │ control-plane│       │   orchestrator     │  │
│  │              │       │                    │  │
│  │ relay-events │──HTTP──►  /internal/       │  │
│  │  .ts         │ POST  │  relay-events      │  │
│  │              │       │       │             │  │
│  └──────────────┘       │       ▼             │  │
│                         │  RelayClientImpl    │  │
│                         │       │             │  │
│                         └───────│─────────────┘  │
│                                 │                │
└─────────────────────────────────│────────────────┘
                                  │ WebSocket
                                  ▼
                            Cloud Relay
```
