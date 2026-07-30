# Contract: `cluster.cockpit` relay channel

Cluster → cloud event channel carrying `GateOpen` and `GateAck` payloads for the operator inbox.

## Wire shape

Emitted by the orchestrator via `ClusterRelayClient.send(...)`:

```typescript
{
  type: 'event',
  event: 'cluster.cockpit',
  data: GateOpen | GateAck,            // discriminated by `data.kind`
  timestamp: string                    // ISO8601, captured at the orchestrator when the /cockpit/gates* route was hit
}
```

Cast to `RelayMessage` per existing pattern at `packages/orchestrator/src/routes/internal-relay-events.ts:48-53` (post-#600 fix — do not use the swapped `{ channel, event }` shape).

## Allow-list

Added to `ALLOWED_CHANNELS` in `packages/orchestrator/src/routes/internal-relay-events.ts:9-15`:

```typescript
const ALLOWED_CHANNELS = [
  'cluster.vscode-tunnel',
  'cluster.audit',
  'cluster.credentials',
  'cluster.bootstrap',
  'cluster.identity-split',
  'cluster.cockpit',            // ← added
] as const;
```

Enforcement path: `/internal/relay-events` still rejects unknown channels with 400. The gate routes emit directly via the injected `getRelayClient()` and do not go through `/internal/relay-events`, but keeping the channel in the allow-list is defensive against future refactors that route emits through the internal HTTP proxy.

## Ordering guarantees

- **Within a single orchestrator run**: strict FIFO. `open(A) → open(B) → ack(A) → ack(B)` posted in order (via HTTP) arrive on the relay in that exact order — whether emitted live or replayed from the retain queue.
- **Across an orchestrator restart**: no guarantee. Retained events in memory are lost. Persisted state is only in the answers file (which the cloud writes to, not the orchestrator). Cloud must tolerate reordering after a cluster restart.
- **Across cloud disconnects**: retained-and-replayed in insertion order.

## Delivery guarantees

- **At-most-once during a single orchestrator run**: an event enqueued into the retainer is either sent successfully or dropped due to overflow / retainer clear on shutdown. No re-emission after `client.send()` returns.
- **Cloud-side upsert**: the cloud MUST upsert on `data.gateId + data.generation`. The orchestrator does not attempt cross-run dedup.

## Retention semantics

Per clarifications.md Q1 → A:

- Single ordered FIFO over all `cluster.cockpit` events emitted while `client === null || !client.isConnected`.
- Bounded by count (`COCKPIT_RETAIN_MAX_COUNT`, default 1000) **and** bytes (`COCKPIT_RETAIN_MAX_BYTES`, default 4 MiB).
- Overflow: drop **oldest** until under both caps. `warn` log with `{ dropped: n }` on each overflow event (rate-limited to once per second).
- Not persisted across restart.
- On `relay.handleConnected()`: drain the FIFO into `client.send()` head-to-tail until empty or a send throws. On throw, the remainder stays in the queue for the next `handleConnected`.

## Cloud-side consumption

Out of scope for this issue. Documented for cross-reference:

- Cloud subscribes to `event: 'cluster.cockpit'` on the relay WebSocket.
- Cloud upserts an inbox row keyed on `(clusterId, data.gateId)` with `data.generation` as monotonic tie-break.
- Cloud renders `data.payload` (for `kind: 'gate-open'`) or updates outcome (`kind: 'gate-ack'`).

Cloud contract details live in the epic doc (`docs/cockpit-remote-gates-plan.md` in tetrad-development).
