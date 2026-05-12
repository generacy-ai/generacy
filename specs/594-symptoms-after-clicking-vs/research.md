# Research: Control-plane relay event IPC channel

**Feature**: #594 — Control-plane relay events silently dropped
**Date**: 2026-05-12

## Problem Analysis

### Architecture gap

The control-plane and orchestrator are separate Node.js processes in the same container. The orchestrator owns the `ClusterRelay` WebSocket client — the only path to the cloud. The control-plane has `setRelayPushEvent()`/`getRelayPushEvent()` as a module-level callback injection point, but nothing ever calls `setRelayPushEvent()` during control-plane startup.

### Why it was never caught

- `cluster.credentials` and `cluster.audit` events are informational — cloud-side flows don't block on receiving them
- `cluster.vscode-tunnel` is the first event type where the cloud frontend actively waits for data (device code)
- The `if (pushEvent)` guard silently no-ops, producing zero error logs

## Technology Decisions

### IPC mechanism: HTTP POST over localhost

**Chosen**: HTTP POST from control-plane to orchestrator's Fastify server on `127.0.0.1:3100`

**Alternatives considered**:

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| HTTP POST over localhost | Reuses existing Fastify server; familiar pattern (StatusReporter does the reverse); no new dependencies | TCP overhead vs Unix socket | **Selected** |
| Unix socket IPC | Lower latency; file-permission based auth | Requires new socket path, cleanup logic; orchestrator would need a second listener | Rejected — unnecessary complexity |
| Node.js `child_process` IPC | Built-in `process.send()`; zero network overhead | Requires orchestrator to fork control-plane (currently spawned by shell entrypoint); major refactor | Rejected — invasive |
| Shared memory / `worker_threads` | Fastest possible | Completely different process model; massive refactor | Rejected — wrong architecture |
| Named pipe (FIFO) | Simple; no network stack | One-way only; no request/response; awkward error handling | Rejected — HTTP is better |

### Authentication: Shared ephemeral UUID key

**Chosen**: UUID generated in entrypoint shell script, exported as `ORCHESTRATOR_INTERNAL_API_KEY`, read by both processes.

**Rationale**: Follows the existing `relayInternalKey` pattern in `server.ts:628-633`. The key lives only in process memory and env vars within the container. No persistence, no rotation needed — the key is ephemeral to the container lifecycle.

**Alternatives considered**:
- **No auth**: Rejected — any process in the container could inject arbitrary relay events
- **mTLS**: Rejected — massive overkill for localhost IPC
- **Unix socket permissions**: Rejected — chose HTTP over TCP, not socket

### Client library: Native `fetch()`

**Chosen**: Node.js built-in `fetch()` (available since Node 18, stable in Node 22)

**Rationale**: Zero dependencies. The control-plane already avoids external HTTP client libraries. `fetch()` is fire-and-forget friendly with `.catch()`.

**Alternative**: `node:http` (used by `StatusReporter`) — would also work but more verbose. `fetch()` is more idiomatic for modern Node.js.

## Existing Patterns Referenced

### 1. `relayInternalKey` in server.ts (lines 628-633)

```typescript
const relayInternalKey = crypto.randomUUID();
apiKeyStore.addKey(relayInternalKey, {
  name: 'relay-internal',
  scopes: ['admin'],
  createdAt: new Date().toISOString(),
});
```

Our new key follows the same pattern: `apiKeyStore.addKey(controlPlaneKey, { name: 'control-plane-internal', ... })`.

### 2. StatusReporter fire-and-forget (status-reporter.ts)

```typescript
async pushStatus(status, statusReason?) {
  const body = JSON.stringify({ status, statusReason });
  const req = http.request({ socketPath, path: '/internal/status', method: 'POST', ... });
  // fire-and-forget with timeout, errors swallowed
}
```

Our control-plane→orchestrator callback mirrors this: fire-and-forget, errors logged but not thrown.

### 3. RelayBridge.setupEventForwarding (relay-bridge.ts lines 303-325)

Shows how events are forwarded to the relay client:
```typescript
this.client.send({ type: 'event', channel, event });
```

Our endpoint does the same thing, just triggered by an HTTP POST instead of an SSE broadcast intercept.

### 4. EventMessage schema (cluster-relay/src/messages.ts)

```typescript
export interface EventMessage {
  type: 'event';
  channel: string;
  event: unknown;
}
```

The relay client accepts this shape via `client.send()`. Our endpoint constructs this from `{ channel, payload }` in the request body.

## Key Sources

- `packages/orchestrator/src/server.ts` — Fastify setup, apiKeyStore, relay initialization
- `packages/orchestrator/src/services/relay-bridge.ts` — Event forwarding pattern
- `packages/orchestrator/src/services/status-reporter.ts` — Fire-and-forget HTTP IPC pattern
- `packages/control-plane/bin/control-plane.ts` — Entry point (where callback must be wired)
- `packages/control-plane/src/relay-events.ts` — Module-level callback store
- `packages/cluster-relay/src/messages.ts` — EventMessage type
