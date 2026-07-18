# Contract: `SourceSelector` bridge-mode extensions

**Issue**: [#997](https://github.com/generacy-ai/generacy/issues/997)
**File**: `packages/generacy/src/cli/commands/cockpit/doorbell/source-selector.ts`

## Scope

Defines the observable behaviour of the `SourceSelector` class after the #997 changes. Existing surface not covered here remains identical to `specs/978-summary-generacy-cockpit/contracts/source-selector.md` (the original contract).

## Public surface

```ts
export type SourceMode = 'smee-attempt' | 'smee-active' | 'poll-fallback';

export type SourceReason =
  | 'startup-no-channel'
  | 'startup-smee-selected'
  | 'startup-smee-failed'       // NEW
  | 'smee-runtime-lost'
  | 'smee-re-promoted';

export interface SourceSelectorOptions {
  initial: 'smee-attempt' | 'poll-fallback';
  stderr: { write(chunk: string): boolean | void };
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  demoteAfterConsecutiveFailures?: number;
  demoteAfterMsWithoutSuccess?: number;   // default now 90_000 (was 300_000)
  rePromoteIntervalMs?: number;
  now?: () => number;
}

export type ModeChangeCallback = (next: SourceMode, reason: SourceReason) => void;

export class SourceSelector {
  get currentSource(): SourceMode;
  onModeChange(cb: ModeChangeCallback): void;
  onReconnectAttempt(failedAttempts: number): void;
  onReconnectSuccess(): void;
  onSseBytes(): void;                       // NEW
  markStartupSmeeFailed(): void;            // NEW
  observeElapsed(): void;
  stop(): void;
}
```

## Semantics

### Constant

- `DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS = 90_000`. Three multiples of smee.io's ~30 s SSE keepalive cadence.

### `onSseBytes()`

**Precondition**: none (safe to call at any time from any thread — but expected on the reader loop only).

**Behaviour**:

| `_current` / `stopped` | Effect |
|---|---|
| `stopped === true` | No-op. |
| `_current === 'smee-active'` | Sets `lastSuccessfulConnectAt = now()`. No stderr, no callbacks. |
| `_current === 'smee-attempt'` | No-op. (Byte arrival before `onReconnectSuccess()` is possible in theory; the selector waits for the explicit success signal to become `smee-active`.) |
| `_current === 'poll-fallback'` | No-op. (Smee bytes may still arrive during a bridge because the background reconnect loop is running; the bridge exit is driven by `onReconnectSuccess()`, not by byte arrival.) |

**Postconditions**: `lastSuccessfulConnectAt` reflects the most recent inbound-byte timestamp (when applicable). No transition ever fires from `onSseBytes()`.

### `markStartupSmeeFailed()`

**Precondition**: startup fallthrough from `runDoorbell()` after `startSmeeMode()` returned `transient-fail`.

**Behaviour**:

| `_current` / `stopped` | Effect |
|---|---|
| `stopped === true` | No-op. |
| `_current === 'smee-attempt'` | Transitions to `poll-fallback` with reason `startup-smee-failed`. Emits `source=poll-fallback reason=startup-smee-failed\n` on stderr. Fires mode-change callbacks with `('poll-fallback', 'startup-smee-failed')`. Starts `rePromoteTimer` (via the standard `transition()` path — `initialWasSmee === true` in this state). |
| Any other `_current` | No-op. |

**Postconditions**: `_current === 'poll-fallback'`, `rePromoteTimer !== null`, one new stderr line.

### `onReconnectSuccess()` — extended

**Existing branches** unchanged. New branch:

| `_current` at call time | Effect |
|---|---|
| `smee-attempt`, `pendingRePromoteEmit === true` | (existing) Transition to `smee-active` with reason `smee-re-promoted`. |
| `smee-attempt`, `pendingRePromoteEmit === false` | (existing) Silent `smee-active` promotion (only mode-change callbacks fire, no stderr). |
| `smee-active` | (existing) Reset counters; refresh `lastSuccessfulConnectAt`. |
| `poll-fallback` | **NEW** Clear `rePromoteTimer` if set. Transition to `smee-active` with reason `smee-re-promoted`. Emits one stderr line. Fires mode-change callbacks. |
| `stopped === true` | No-op. |

**Rationale**: the `poll-fallback` → `smee-active` transition is the runtime bridge exit. It fires when the background-reconnecting `SmeeDoorbellSource` successfully reconnects mid-bridge. Distinct from the startup-transient-fail path which uses `rePromoteTimer → smee-attempt → smee-active`.

### `observeElapsed()` — threshold updated

Semantics unchanged; the only difference is the constant. On `elapsedTicker` tick (every 1 s):

- If `stopped` or `_current !== 'smee-active'` or `lastSuccessfulConnectAt == null`: no-op.
- Else if `now() - lastSuccessfulConnectAt > 90_000`: transition to `poll-fallback` with reason `smee-runtime-lost`.

With FR-002's byte-liveness refresh, `lastSuccessfulConnectAt` is now bumped by inbound SSE bytes (`onSseBytes()`), not just by `onReconnectSuccess()`. On a healthy smee.io connection this means the threshold effectively measures "time since last byte" — and given smee.io's ~30 s keepalive cadence, only a genuinely dead half-open stream can accumulate ≥90 s of silence.

### Transition table (post-#997)

Only rows whose behaviour changed are shown; unchanged rows carry #978's contract.

| From | To | Reason | Trigger |
|---|---|---|---|
| `smee-active` | `poll-fallback` | `smee-runtime-lost` | `onReconnectAttempt(n ≥ demoteAfterFailures)` OR `observeElapsed()` with `elapsed > 90_000` |
| `smee-attempt` | `poll-fallback` | `startup-smee-failed` | **NEW** `markStartupSmeeFailed()` call |
| `poll-fallback` | `smee-active` | `smee-re-promoted` | **NEW** `onReconnectSuccess()` while in bridge mode |
| `poll-fallback` | `smee-attempt` | (silent — no stderr) | (existing) `rePromoteTimer` tick |
| `smee-attempt` | `smee-active` | `smee-re-promoted` | (existing) `onReconnectSuccess()` with `pendingRePromoteEmit` |

## Stderr line inventory (unchanged shape, new reason)

Format: `cockpit doorbell: source=<label> reason=<reason>\n`
Labels: `smee` for `smee-attempt` and `smee-active`, `poll-fallback` for `poll-fallback`.

All existing lines preserved. New line:

```
cockpit doorbell: source=poll-fallback reason=startup-smee-failed
```

## Timers

- `elapsedTicker`: unchanged; 1 s `setInterval`, `unref()`ed, cleared in `stop()`.
- `rePromoteTimer`: unchanged wiring; NEW activation site is `markStartupSmeeFailed()` (via `transition()`). Cleared in `stop()` and on any successful `onReconnectSuccess()` while in `poll-fallback` (bridge exit).

## Invariants (formal)

1. **No self-loop transitions.** `transition()` guards `_current === next` at the top.
2. **Every transition emits exactly one stderr line and fires every registered mode-change callback exactly once.** (Exception: `smee-attempt → smee-active` when `pendingRePromoteEmit === false` — silent, callbacks-only. Unchanged from #978.)
3. **`onSseBytes()` never causes a transition.** It only refreshes `lastSuccessfulConnectAt`.
4. **After `stop()`, no public method mutates state.** Every method short-circuits on `stopped === true`.
5. **`rePromoteTimer` is set iff `_current === 'poll-fallback'` AND either `initialWasSmee === true` OR the entry came from `markStartupSmeeFailed()`.**
6. **The `smee-active` state, on entry via `smee-re-promoted` from `poll-fallback` (bridge exit), guarantees `rePromoteTimer === null` on exit.** (Cleared in the new `onReconnectSuccess()` branch before `transition()`.)
