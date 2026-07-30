# Data Model: `frameId` mint + consume

**Feature**: #1077
**Status**: Complete

Pinpoints every type and shape that changes or gets added by this feature. All
files are under `packages/`; process-scoped in-memory state only.

## Entities

### E-1. `PendingFrame` (new — `packages/cluster-relay/src/relay.ts`)

Per-frame correlation entry held on the `ClusterRelay` instance's pending map.

```ts
interface PendingFrame {
  /** Cloud sub-event discriminator emitted alongside `frameId` at register time.
   *  'gate-open' | 'gate-outcome'. */
  frameType: string;
  /** 24-hex gateId of the outbound frame — pinned so the settle log carries
   *  the natural gate identity alongside the per-emit frameId. */
  gateId: string;
  /** epoch-ms at which registerPendingFrame() was called. Feeds ageMs in log
   *  lines and the TTL cutoff. */
  registeredAt: number;
  /** Handle from setTimeout(..., 30_000). Cleared on settle and on
   *  disconnect()/shutdown so a dropped connection does not leak timers. */
  ttlHandle: ReturnType<typeof setTimeout>;
}
```

**Storage**: `private readonly pendingFrames: Map<string, PendingFrame>` on
`ClusterRelay`. Not exported. Not serialised. Not persisted.

**Lifecycle**:
- **Register**: created by `registerPendingFrame(frameId, meta)` — the only
  public entry point. Always adds an entry (D5). If an entry already exists
  for the same `frameId` (impossible under the generator, but defensive):
  clear the old timer, replace the entry. No throw.
- **Settle**: on `cluster.cockpit.reply`, if `pendingFrames.has(frameId)`,
  `clearTimeout(entry.ttlHandle)`, delete the entry, log at `info` with
  `{ frameId, frameType, gateId, accepted, reason?, priorStatus?, ageMs }`.
- **Quiet-drop**: on `cluster.cockpit.reply`, if
  `!pendingFrames.has(frameId)`, log at `info` with
  `{ frameId, frameType, gateId, accepted, reason?, priorStatus? }` under a
  distinct message ("cluster.cockpit.reply had no matching pending frame").
  No mutation, no throw.
- **TTL expiry**: timer fires → delete entry → log at `debug` with
  `{ frameId, ageMs }`.
- **Disconnect / shutdown**: iterate map, `clearTimeout(entry.ttlHandle)` for
  each, `map.clear()`. Called from `disconnect()` and from the WebSocket
  `on('close')` handler at `packages/cluster-relay/src/relay.ts:365-374`.

**Validation rules**:
- `frameId` (map key) must be a non-empty string. Any caller that passes an
  empty/undefined value gets a no-op registration + a `debug` line — the
  route defends at the mint site so this is defense-in-depth, not primary.

### E-2. `ClusterRelayClient` interface — new method (contract change)

Both `packages/cluster-relay/src/relay.ts` and
`packages/orchestrator/src/types/relay.ts` grow one method on the interface:

```ts
export interface ClusterRelayClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: RelayMessage): void;
  on(event: 'message', handler: (msg: RelayMessage) => void): void;
  on(event: 'connected', handler: () => void): void;
  on(event: 'disconnected', handler: (reason: string) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  readonly isConnected: boolean;

  /**
   * Register a pending correlation entry for an outbound cockpit frame (#1077).
   * Called by the orchestrator's `POST /cockpit/gates` and
   * `POST /cockpit/gates/:id/ack` handlers immediately after mint, before
   * `send()` / retain. Idempotent for the same `frameId` (later call wins);
   * evicts on matching `cluster.cockpit.reply` or after 30s TTL.
   */
  registerPendingFrame(frameId: string, meta: PendingFrameMeta): void;
}

export interface PendingFrameMeta {
  frameType: 'gate-open' | 'gate-outcome';
  gateId: string;
}
```

**Public surface impact**: minor — additive method. Existing mock clients in
tests (`makeMockClient` at `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts:19-29` and elsewhere) grow a
`registerPendingFrame: vi.fn()` field.

### E-3. Route mint helper — internal to `cockpit-gates.ts`

Pure function, not exported:

```ts
import { randomBytes } from 'node:crypto';

function mintFrameId(): string {
  return `frm_${randomBytes(12).toString('hex')}`;
}
```

**Placement**: top of `packages/orchestrator/src/routes/cockpit-gates.ts`,
alongside the existing `collapseCloudStatus` helpers. No export.

### E-4. Wire schemas — optional `frameId` field on the tool self-check

`packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` — two
existing Zod objects grow one optional field each:

```ts
export const GateOpenWireSchema = z.object({
  // ...existing fields...
  askedAt: z.string().datetime(),
  frameId: z.string().min(1).optional(),   // #1077
});

export const GateOutcomeWireSchema = z.object({
  // ...existing fields...
  at: z.string().datetime(),
  frameId: z.string().min(1).optional(),   // #1077
});
```

**Rationale**: matches the shape already on `GateOpenSchema` / `GateOutcomeSchema`
in `packages/cockpit/src/gates/schema.ts:77-84 / :98-105`. Without it, the tool's
own `safeParse` self-check would reject a caller-supplied `frameId` on the way
out — the exact case D-5 (research.md) opens.

**Type impact**: `GateOpenWire` / `GateOutcomeWire` gain optional `frameId?: string`.

## Route mutation shape

For both handlers in `packages/orchestrator/src/routes/cockpit-gates.ts`:

```ts
const parsed = GateOpenSchema.parse(request.body);        // or GateOutcomeSchema
const frameId = parsed.frameId ?? mintFrameId();
const emitData = { ...parsed, frameId };

// registerPendingFrame BEFORE tryEmitOrRetain so an immediate reply
// (impossible today but not future-proofed by ordering the other way)
// finds an entry to settle.
options.getRelayClient()?.registerPendingFrame(frameId, {
  frameType: parsed.type,   // 'gate-open' | 'gate-outcome'
  gateId: parsed.gateId,
});

const timestamp = new Date().toISOString();
const approxBytes = JSON.stringify(emitData).length;
const outcome = tryEmitOrRetain({
  data: emitData,
  timestamp,
  approxBytes,
  gateId: emitData.gateId,
  type: emitData.type,
}, options);
```

**Notes on ordering**:
- `registerPendingFrame` runs **before** `tryEmitOrRetain`. If the relay is
  disconnected, the retainer holds the frame; when it drains post-reconnect,
  the pending entry is already registered — and the entry outlives disconnect
  because it lives on the `ClusterRelay` instance, not on the retainer (SC-005).
  If TTL expires during a long disconnect, the eviction log fires; when the
  frame finally drains and the cloud replies, the reply hits the quiet-drop
  branch — which is precisely what FR-005 covers.
- `getRelayClient()?.registerPendingFrame(...)` — the null-guard mirrors the
  same guard inside `tryEmitOrRetain` at `cockpit-gates.ts:177` (route runs
  during boot before the relay client is attached). No-op is fine: the retain
  path still queues the frame; a later drain will send it; the cloud reply for
  that frame will hit the quiet-drop branch. Same failure mode as an actual
  TTL expiry.

## Response body shape

Both handlers respond with:

```ts
// retained === false
{ accepted: true, retained: false, frameId }

// retained === true
{ accepted: true, retained: true, frameId, retainQueue: { count, bytes } }
```

`frameId` is always present on the 202 for a successful mint (regardless of
caller-override vs route-mint). Existing 400 shapes on validation error are
unchanged.

## State transitions — `PendingFrame` lifecycle

```
              register(frameId, meta)
                       │
                       ▼
                   [PENDING]
                       │
     ┌─────────────────┼─────────────────┐
     │                 │                 │
     ▼                 ▼                 ▼
  match reply     TTL expires       shutdown /
  (settle,        (evict,           disconnect
   info log)      debug log)        (evict silent)
     │                 │                 │
     ▼                 ▼                 ▼
   (removed)       (removed)         (removed)
```

- No revisits (settled entries are never re-registered under the same
  `frameId` — each mint is a fresh id).
- No promotion / demotion between states.
- Simultaneous shutdown + reply is safe: the WS close handler clears timers
  and `map.clear()` before any late message can dispatch, because `ws.on('message', ...)` at `relay.ts:281-359` and `ws.on('close', ...)` at `:365`
  are serialised by the WS lib.

## Relationships

- **`PendingFrame` ← 1:1 → outbound `cluster.cockpit` event** (open OR
  outcome). Keyed by `frameId`.
- **`PendingFrame` ← 1:1 → incoming `cluster.cockpit.reply`** (when one
  arrives before TTL).
- **`ClusterRelay` ← 1:N → `PendingFrame`** (map ownership).
- **Retainer FIFO ← 0:N → `PendingFrame`** (loose coupling: enqueue's
  reference to the data object is byte-for-byte-equal to what was registered
  by the route, but the retainer does not know about the pending map).

## Not modeled here (deliberate)

- `runId`, `sessionId`, other gate identity fields — unchanged, belong to
  #1053 / #1024 / #1066 respectively.
- Cloud-side reply producer state — Out of Scope (`generacy-cloud#890`).
- Cross-process durability of the pending map — Out of Scope (spec Assumption).
- Metrics exports — Out of Scope (a `metrics()` accessor on `ClusterRelay`
  would be premature; if operators need one, follow-up).
