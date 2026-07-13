# Contract: `event-bus-registry` (internal API)

**Issue**: [#924](https://github.com/generacy-ai/generacy/issues/924)

Not a public API. Contract documented so behavior can be verified against `event-bus-registry.test.ts`.

## Public exports

```ts
export async function acquireEpicBus(options: AcquireOptions): Promise<Acquired>;

export function _resetRegistryForTests(): void;

export interface AcquireOptions {
  epicRef: string;
  runner?: CommandRunner;
  gh?: GhWrapper;
  intervalMs?: number;
  logger?: { warn: (msg: string) => void };
  noPoll?: boolean;
  now?: () => number;               // NEW — clock injection for tests
  idleTtlMs?: number;               // NEW — override for tests
  maxBuses?: number;                // NEW — override for tests
}

export interface Acquired {
  bus: EpicEventBus;
  release: () => void;
}
```

## Lifecycle contract

### On `acquireEpicBus(options)` — existing bus in registry

1. Look up subscription by `expandedRef`.
2. If `sub.idleTimer != null`: `clearTimeout(sub.idleTimer); sub.idleTimer = null`.
3. `sub.refCount += 1; sub.lastActiveAt = now()`.
4. Reinsert at tail: `registry.delete(key); registry.set(key, sub)` — for LRU ordering.
5. If poller was paused (refcount had been 0): `await sub.catchUpPoll()` synchronously.
6. Return `{ bus: sub.bus, release: () => releaseKey(expandedRef) }`.

### On `acquireEpicBus(options)` — new bus

1. Look up: not found.
2. If `registry.size >= maxBuses`:
   - Evict LRU (first insertion-order entry): `sub.stop(); registry.delete(evictedKey)`.
3. Create `EpicEventBus`, start poller, wire pause/resume/catch-up handles.
4. `sub = { bus, refCount: 1, stop, pausePoller, resumePoller, catchUpPoll, idleTimer: null, lastActiveAt: now() }`.
5. `registry.set(expandedRef, sub)`.
6. Return.

### On `release()` (returned from acquire) — refcount → 0

1. `sub.refCount -= 1`. If still > 0, return.
2. `sub.pausePoller()`.
3. `sub.idleTimer = setTimeout(() => { sub.stop(); registry.delete(key); }, idleTtlMs)`.
4. Do **NOT** delete `sub` from the registry. Do **NOT** clear buffer, snapshot, or nonce.

### Idle-TTL firing

1. Timer callback runs. Callback is guarded: if `sub.refCount > 0` at fire time, no-op (defensive).
2. `sub.stop()` aborts the poll loop's `AbortController`.
3. `registry.delete(key)`.
4. The bus object is now garbage-collected once all `Acquired` handles are released.

### Poller pause / resume / catch-up

`pausePoller()`:
- Sets an internal `paused: true` flag on the loop closure.
- The loop's next iteration observes the flag and skips the `runOnePoll` + `sleep`.
- Retains `prev: SnapshotMap` and `aggState: AggregateState` on the closure.

`resumePoller()`:
- Unsets `paused`. The next iteration is naturally at the top of the loop after `sleep` — resumes at full cadence.
- Only called after `catchUpPoll()` has already reconciled the diff.

`catchUpPoll()`:
- Runs `resolveEpic` + `runOnePoll` + `computeAggregateEvents` once with the retained `prev` and `aggState`, mutating them as the running loop would.
- Emits any produced events to `bus`.
- Idempotent-ish: two consecutive calls with no upstream changes produce no events (`runOnePoll`'s diff returns empty). Safe under recovery.

## Invariants

- **R-I1**: `sub.refCount > 0 XOR sub.idleTimer != null` at any observation point outside the `acquire` / `release` critical section.
- **R-I2**: For any `sub` in the registry, `sub.bus.epic === expandedRef`. Registry key mirrors bus identity.
- **R-I3**: `registry.size <= maxBuses` at any point after `acquireEpicBus` returns.
- **R-I4**: LRU eviction respects `lastActiveAt`. The evicted subscription's `lastActiveAt` is the oldest among all currently-live subscriptions.
- **R-I5**: A subscription evicted (TTL or LRU) is never resurrected. Any future `acquire` for the same epic creates a new subscription with a new `busNonce`.

## Test-only surface

`_resetRegistryForTests()`:
- Iterates every entry, calls `sub.stop()`, clears any `idleTimer`, then `registry.clear()`.
- Used in `afterEach` to make the registry deterministic across tests.

## Error handling

- `catchUpPoll()` failures (GH API errors, etc.) are caught and logged via `options.logger.warn`. The catch-up is best-effort; the acquire still returns successfully.
- Timer callback errors (unexpected `sub.stop` throw) are caught and logged. The registry stays consistent (`registry.delete(key)` runs first).
- Env var parse failures fall back to defaults with a one-time `logger.warn` at boot.
