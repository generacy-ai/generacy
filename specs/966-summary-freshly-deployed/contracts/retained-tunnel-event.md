# Contract: `retained-tunnel-event.ts`

Module: `packages/orchestrator/src/routes/retained-tunnel-event.ts` (NEW)

## Exports

```ts
export type RetainedStatus =
  | 'authorization_pending'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface RetainedTunnelEvent {
  event: 'cluster.vscode-tunnel';
  data: unknown;
  timestamp: string;
  status: RetainedStatus;
}

export function getRetainedTunnelEvent(): RetainedTunnelEvent | null;
export function setRetainedTunnelEvent(event: RetainedTunnelEvent): void;
export function clearRetainedTunnelEvent(): void;
export function isRetentionEligible(
  payload: unknown,
): { eligible: true; status: RetainedStatus } | { eligible: false };
```

## Contract

### `isRetentionEligible(payload)`

Returns `{ eligible: true, status }` iff:

1. `payload` matches `{ status: RetainedStatus, error?: string, ... }` via Zod `passthrough()`.
2. If `payload.status === 'error'` and `payload.error` starts with any string in `NON_LIFECYCLE_ERROR_MARKERS` (see data-model.md), returns `{ eligible: false }`.
3. Otherwise returns `{ eligible: true, status: payload.status }`.

Returns `{ eligible: false }` on any Zod parse failure.

### `setRetainedTunnelEvent(event)`

Precondition: caller has verified `isRetentionEligible(event.data)` returned `{ eligible: true, status }` and `event.status === status`.

Behavior — precedence rule (FR-005 Q3=C):

```
existing = getRetainedTunnelEvent()
if existing == null:
    retained = event
elif existing.status == 'authorization_pending':
    retained = event                              # any incoming overwrites pending
elif event.status == 'authorization_pending':
    # existing is terminal; do NOT overwrite terminal with pending
    return
else:
    retained = event                              # terminal → terminal: latest wins
```

Postcondition: `getRetainedTunnelEvent()` returns either the incoming event or the pre-existing terminal event.

### `getRetainedTunnelEvent()`

Pure read. Multiple calls in the same tick return the same reference. Safe to call from any code path.

### `clearRetainedTunnelEvent()`

Sets the slot to `null`. Idempotent. Called by `RelayBridge.handleConnected()` after successfully forwarding the retained event to the cloud.

## Invariants

- **I1** — At most one retained event exists at any moment (single-slot).
- **I2** — Retained events always match `RetainedTunnelEvent` shape (no unvalidated data in the slot).
- **I3** — A retained `authorization_pending` never overwrites a retained terminal (FR-005).
- **I4** — Non-lifecycle `error` events (see `NON_LIFECYCLE_ERROR_MARKERS`) are never retained (FR-006).
- **I5** — The slot survives no I/O, no process restart, no cross-process boundary. Restart = fresh slot (acceptable per spec §Out of Scope).

## Error handling

- Zod parse failures on the incoming payload → `isRetentionEligible` returns `{ eligible: false }`. Caller must handle (i.e., drop the event silently, matching pre-fix behavior for malformed events).
- `setRetainedTunnelEvent` called with an ineligible-status payload → assertion failure via `RetainedStatus` type narrowing at TS level; runtime behavior is best-effort store (no thrown error) since the type system already prevents this at compile time.

## Concurrency

Single-threaded (Node event loop). All state transitions are synchronous within one microtask relative to any given caller. No locks, no promises, no async work in this module.
