# Data Model: cockpit_await_events lifecycle fix

**Issue**: [#924](https://github.com/generacy-ai/generacy/issues/924)
**Branch**: `924-found-during-cockpit-v1`

## Cursor token (wire shape)

Base64-encoded JSON. Same envelope as today; the JSON payload gains two optional fields.

```ts
interface CursorPayload {
  epic: string;      // "owner/repo#number", unchanged
  position: number;  // monotonic per-bus counter, unchanged, ≥ 0
  pnonce?: string;   // NEW — process-instance nonce, 16 hex chars
  bnonce?: string;   // NEW — bus-instance nonce, 16 hex chars
}
```

**Legacy tokens** (issued before the fix) omit both nonce fields; they classify as `discarded` on first post-deploy call (FR-006).

**Encoding**:
```ts
function encodeCursor(epic: string, position: number, pnonce: string, bnonce: string): string {
  return Buffer.from(JSON.stringify({ epic, position, pnonce, bnonce }), 'utf-8')
    .toString('base64');
}
```

**Decoding**:
```ts
function decodeCursor(str: string):
  | { epic: string; position: number; pnonce?: string; bnonce?: string }
  | null;
```

Malformed base64 or non-object JSON → `null` → `parseCursor` returns `{ kind: 'malformed' }`.

## Cursor classification

Updated `CursorParseResult` discriminated union:

```ts
export type CursorParseResult =
  | { kind: 'valid'; position: number }
  | { kind: 'expired'; requestedPosition: number }
  | { kind: 'discarded'; reason: 'legacy' | 'cross-instance' | 'evicted' }  // NEW
  | { kind: 'malformed' }
  | { kind: 'never-issued' }
  | { kind: 'wrong-epic'; requestedEpic: string; boundEpic: string };
```

The `discarded` branch carries a `reason` field for logging / debugging; the tool output collapses all three to `resetFrom: 'discarded'` (spec FR-005/006).

Classification order in `parseCursor`:

1. `str == null` → `{ kind: 'valid', position: 0 }`.
2. `decodeCursor(str) == null` → `{ kind: 'malformed' }`.
3. `decoded.pnonce == null || decoded.bnonce == null` → `{ kind: 'discarded', reason: 'legacy' }`.
4. `decoded.epic !== this.epic` → `{ kind: 'wrong-epic', ... }`.
5. `decoded.pnonce !== INSTANCE_NONCE` → `{ kind: 'discarded', reason: 'cross-instance' }`.
6. `decoded.bnonce !== this.busNonce` → `{ kind: 'discarded', reason: 'evicted' }`.
7. `decoded.position === 0` → `{ kind: 'valid', position: 0 }`.
8. `decoded.position >= this.nextCursor` → `{ kind: 'never-issued' }`. **← genuine caller bug only**.
9. `decoded.position < lowWatermark - 1` → `{ kind: 'expired', requestedPosition: decoded.position }`.
10. Otherwise → `{ kind: 'valid', position: decoded.position }`.

## `EpicEventBus` internal state additions

```ts
class EpicEventBus {
  readonly epic: string;
  readonly busNonce: string;  // NEW — 16 hex chars, generated in constructor
  // ... existing fields
}
```

Constructor accepts `nonce?: string` as a test-only injection point:

```ts
interface EpicEventBusOptions {
  epic: string;
  retentionCount?: number;
  retentionMs?: number;
  now?: () => number;
  nonce?: string;  // NEW test seam; defaults to random
}
```

Module-scoped constant:

```ts
const INSTANCE_NONCE: string = crypto.randomBytes(8).toString('hex');
```

Tests requiring cross-instance behavior mock the `nonce` option.

## Registry data model

```ts
interface Subscription {
  bus: EpicEventBus;
  refCount: number;
  stop: () => void;
  pausePoller: () => void;      // NEW — flips the polls flag; retains snapshot state
  resumePoller: () => void;     // NEW — reactivates the sleep loop
  catchUpPoll: () => Promise<void>;  // NEW — one-shot resolveEpic + runOnePoll + emit
  idleTimer: NodeJS.Timeout | null;  // NEW — armed at refcount→0, cleared at acquire
  lastActiveAt: number;         // NEW — wall-clock ms, updated on every acquire, drives LRU
}
```

Registry itself remains `Map<string, Subscription>` but relies on ES2020+ insertion-order iteration for LRU semantics:

- **On `acquire` (existing bus)**: `registry.delete(key); registry.set(key, sub); sub.lastActiveAt = Date.now(); sub.refCount++;` if `sub.idleTimer != null` clear + null. If poller is paused, `await sub.catchUpPoll()` synchronously before returning.
- **On `acquire` (new bus)**: if `registry.size >= COCKPIT_MCP_BUS_MAX`, evict first key (`registry.keys().next().value`) with `sub.stop(); registry.delete(evictedKey)`.
- **On `release` (refcount → 0)**: arm `sub.idleTimer = setTimeout(() => { sub.stop(); registry.delete(key); }, COCKPIT_MCP_BUS_IDLE_TTL_MS)`. Call `sub.pausePoller()`.

## Environment variable schema

| Var | Type | Default | Notes |
|-----|------|---------|-------|
| `COCKPIT_MCP_BUS_IDLE_TTL_MS` | positive integer | `600_000` | Q1-A |
| `COCKPIT_MCP_BUS_MAX` | positive integer | `100` | Q5-B |
| `COCKPIT_MCP_EVENT_RETENTION_COUNT` | positive integer | `10_000` | unchanged |
| `COCKPIT_MCP_EVENT_RETENTION_MS` | positive integer | `600_000` | unchanged |

Parsing: `Number.parseInt(process.env.X ?? '', 10)` with fallback to default when `NaN` or ≤ 0. Follows the existing pattern in `event-bus.ts`.

## Tool output shape

`CockpitAwaitEventsData`:

```ts
export interface CockpitAwaitEventsData {
  events: CockpitStreamEvent[];
  cursor: string;
  resetFrom?: 'expired' | 'discarded';  // Union WIDENED — was 'expired' only
}
```

Cursor value: `encodeCursor(bus.epic, position, INSTANCE_NONCE, bus.busNonce)`. When no events and no `resetFrom`, `cursor` echoes the input if `sinceCursor === decoded.position` (existing behavior preserved for `undefined` inputs).

## Validation rules

- `pnonce` / `bnonce` on decode: string, length 16, `/^[0-9a-f]{16}$/`. Anything else → treat the field as absent (classify as `discarded` reason `legacy`). Rationale: any garbled nonce classifies the same as no nonce; both are "server no longer recognizes this token."
- `INSTANCE_NONCE`: generated exactly once per process at module load; not writable via public API.
- `bus.busNonce`: generated exactly once per `EpicEventBus` instance; not writable via public API.
- Idle-TTL timer: armed exactly once per refcount-0 transition; cleared exactly once per next acquire. Not resettable by any other event (FR-003 / Q2-D).

## Test doubles

- `crypto.randomBytes` NOT mocked globally — tests that need deterministic nonces pass `nonce` via `EpicEventBusOptions`.
- `Date.now` clock injected via `options.now` on `EpicEventBus` and via a `now: () => number` field on `AcquireOptions` (new) so idle-TTL tests use a fake clock.
- Timer functions (`setTimeout`) not mocked; tests use `vi.useFakeTimers()` where TTL firing is asserted.
