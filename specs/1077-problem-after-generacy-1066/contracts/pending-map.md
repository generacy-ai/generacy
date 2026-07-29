# Contract: `ClusterRelay` pending-frame map (D2 + D5)

**Feature**: #1077
**Consumer**: `packages/orchestrator/src/routes/cockpit-gates.ts` (register site),
`packages/orchestrator/src/services/relay-bridge.ts` (indirect — it constructs
the client and the retainer; unchanged by this spec).
**File**: `packages/cluster-relay/src/relay.ts`
**Interface source of truth**: `packages/cluster-relay/src/relay.ts` (concrete
`ClusterRelay` class) + `packages/orchestrator/src/types/relay.ts`
(orchestrator-side `ClusterRelayClient` interface).

## Public API added

```ts
export interface PendingFrameMeta {
  frameType: 'gate-open' | 'gate-outcome';
  gateId: string;
}

registerPendingFrame(frameId: string, meta: PendingFrameMeta): void
```

Both the orchestrator-side `ClusterRelayClient` interface
(`packages/orchestrator/src/types/relay.ts:39-60`) and the concrete
`ClusterRelay` class (`packages/cluster-relay/src/relay.ts:65-...`) grow this
method. No other public API changes.

## Data

Private, on-instance:

```ts
private readonly pendingFrames = new Map<string, PendingFrame>();
```

`PendingFrame` shape: see `../data-model.md` § E-1.

## `registerPendingFrame(frameId, meta)` — behaviour

- `frameId` empty → return silently. Defensive: the route mints and this is
  never expected to fire. `logger.debug({ frameId }, 'registerPendingFrame ignored empty frameId')`.
- Existing entry for the same `frameId` → clear its `ttlHandle`, replace the
  entry. Defensive: mint collision has probability ~2^-96, so this is
  rounding to zero, but the semantics have to be defined.
- Otherwise → store a new `PendingFrame` with `registeredAt: Date.now()` and
  `ttlHandle: setTimeout(() => this.evictOnTtl(frameId), TTL_MS)`.

Sync. Never throws. No log at register time (register happens on every send
and would flood logs).

## `cluster.cockpit.reply` handler — new behaviour

Replaces `packages/cluster-relay/src/relay.ts:334-349` in its entirety.
Structural early-return preserved so registered `onMessage` handlers do not
see reply frames (FR-003 test at `packages/cluster-relay/tests/relay.test.ts:830`).

```ts
if (message.type === 'cluster.cockpit.reply') {
  const { frameId } = message;
  if (frameId !== null && this.pendingFrames.has(frameId)) {
    const entry = this.pendingFrames.get(frameId)!;
    clearTimeout(entry.ttlHandle);
    this.pendingFrames.delete(frameId);
    this.logger.info(
      {
        frameId,
        frameType: message.frameType,
        gateId: message.gateId,
        accepted: message.accepted,
        reason: message.reason,
        priorStatus: message.priorStatus,
        ageMs: Date.now() - entry.registeredAt,
      },
      'cluster.cockpit.reply settled pending frame',
    );
  } else {
    this.logger.info(
      {
        frameId,
        frameType: message.frameType,
        gateId: message.gateId,
        accepted: message.accepted,
        reason: message.reason,
        priorStatus: message.priorStatus,
      },
      'cluster.cockpit.reply had no matching pending frame',
    );
  }
  return;
}
```

**Notes**:
- `frameId` on the message is typed `string | null` (see
  `packages/cluster-relay/src/messages.ts:154`). A `null` matches nothing,
  falls into the quiet-drop branch.
- Both branches log at `info` — Q2 action item 2 pins this. No `warn`, no
  `error`.
- The settle log includes `ageMs`; the drop log does not (there is no
  registered entry to derive age from — but the frame's `timestamp` field
  could be logged if operators need it later; not in this spec).
- `return` before handler dispatch is preserved — this is FR-003. Tests at
  `relay.test.ts:830-892` pin it.

## TTL — 30 seconds

```ts
private static readonly TTL_MS = 30_000;

private evictOnTtl(frameId: string): void {
  const entry = this.pendingFrames.get(frameId);
  if (!entry) return;  // already settled
  this.pendingFrames.delete(frameId);
  this.logger.debug(
    { frameId, ageMs: Date.now() - entry.registeredAt },
    'cluster.cockpit pending frame evicted on TTL',
  );
}
```

- Log level `debug` per Q3 rationale.
- Constant, not per-call configurable — Q3 explicit rejection of option D.
- Timer callback checks `has()` before delete because a settle path could win
  the race and race-cleared the timer already; the check is belt-and-braces.

## Shutdown / disconnect

Extend `packages/cluster-relay/src/relay.ts` `ws.on('close', ...)` at `:365-374`
and `disconnect()` at whatever line owns it (search: `disconnect(): Promise`):

```ts
for (const entry of this.pendingFrames.values()) {
  clearTimeout(entry.ttlHandle);
}
this.pendingFrames.clear();
```

Silent — no per-entry log on shutdown eviction. Rationale: shutdown is a
process-level event, not a per-frame incident; the noise would obscure real
signal at reconnect time. If operators later need it, a single summary log at
`info` (`{ evictedCount }`) is the follow-up.

## Reconnect invariant (load-bearing)

The pending map lives on the `ClusterRelay` instance, which **outlives**
individual WebSocket connections (the class handles reconnect internally per
`packages/cluster-relay/src/relay.ts` docstring "auto-reconnect with
exponential backoff"). Do **not** clear the map on `ws.on('close', ...)` unless
the whole client is being torn down (`disconnect()`). Otherwise a frame sent
just before a disconnect, retained by the orchestrator's retainer, and drained
on reconnect, would find no pending entry — regressing SC-005.

The load-bearing distinction:
- **Transient disconnect** (auto-reconnect) → map preserved.
- **Deliberate `disconnect()` call** → map cleared.

Implementation cue: the current codebase already has this split — `disconnect()`
sets `running = false` and calls `abortController.abort()`, distinct from the
socket's `ws.on('close')` path that fires on every disconnect. Add the
`pendingFrames.clear()` to the `disconnect()` path only, or gate the clear on
`!this.running`.

## Test surface

`packages/cluster-relay/tests/relay.test.ts` — rewrite the `#1063 router branch`
describe and add a new `#1077 pending-frame correlation` describe:

- **Update `SC-001 accepted:true`**: expect **`info`** with the settle-line
  fields, not `debug`. Peer sends `frameId: <known-id>` after the test
  registers a matching pending entry via `relay.registerPendingFrame(...)`.
- **Update `SC-002 accepted:false`**: expect **`info`** with the unknown-drop
  fields, and `frameId` on the payload (was absent). Peer sends `frameId: null`
  or an unregistered id.
- **Preserve `FR-003 handler exclusion`**: unchanged. Register or not, the
  handler must not see the reply.
- **New `#1077 settle-then-evict`**: register 3 frames, echo replies for all
  3, assert 3 `info` settle lines and `pendingFrames.size === 0` (accessor
  added for tests — or a `getPendingFrameCount()` public accessor).
- **New `#1077 TTL eviction`**: register 1 frame, advance fake timers 30s,
  assert 1 `debug` eviction line and `size === 0`. `vi.useFakeTimers()`.
- **New `#1077 disconnect clears map`**: register 2 frames, `disconnect()`,
  assert `size === 0` and both timers were cleared (no pending timer callback
  fires after disconnect).
- **New `#1077 transient reconnect preserves map`**: register 1 frame, trigger
  a `ws.close` event (simulating transient drop; do NOT call `disconnect()`),
  wait for reconnect via `waitFor`, assert `size === 1` and TTL timer still
  live.

For the size accessor: prefer a test-only accessor
`_pendingFramesSizeForTests()` (name pattern matches other packages'
`_ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS` convention) OR expose
`get pendingFrameCount(): number` publicly. Non-test callers currently have no
reason to read the count; test-only accessor is preferred.

## What the pending map does NOT do

- Does NOT provide a `waitFor(frameId, timeoutMs)` promise — D2 explicitly
  bans building a delivery channel here.
- Does NOT emit metrics.
- Does NOT persist across process restarts.
- Does NOT include per-caller identity — the map is process-global on the
  `ClusterRelay` singleton.
- Does NOT throw for any input.
