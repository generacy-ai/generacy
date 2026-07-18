# Contract: `doorbell.ts` bridge-mode wiring

**Issue**: [#997](https://github.com/generacy-ai/generacy/issues/997)
**File**: `packages/generacy/src/cli/commands/cockpit/doorbell.ts`

## Scope

Defines the observable behaviour of `runDoorbell()` under bridge mode (runtime demotion, runtime recovery, startup transient-fail). Existing arg parsing, form classification, and channel discovery flows are unchanged.

## Handle state machine

Two handles are relevant at runtime:

- `pollHandle: RunPollModeHandle | null` — the poll-mode subscriber (bus + subscribeAndEmit).
- `smeeHandle: RunSmeeModeHandle | null` — the `SmeeDoorbellSource` instance.

Valid combinations post-#997:

| State | `smeeHandle` | `pollHandle` | Selector `_current` | Description |
|---|---|---|---|---|
| Startup: smee happy path | ≠ null | null | `smee-active` | Discovery non-null, `startSmeeMode` succeeded, first `onReconnectSuccess` promoted. |
| Startup: no channel | null | ≠ null | `poll-fallback` | Discovery null. `initialWasSmee === false`, no `rePromoteTimer`. |
| Startup: transient-fail (NEW) | null | ≠ null | `poll-fallback` | Discovery non-null, `startSmeeMode` failed. `initialWasSmee === true`, `rePromoteTimer` armed by `markStartupSmeeFailed()`. |
| Runtime bridge open (NEW) | ≠ null (still reconnecting) | ≠ null | `poll-fallback` | Runtime demote from failure count or silence. Smee source alive, poll bridge alongside. |
| Startup rePromote reattempt | ≠ null (new instance from `startSmeeMode`) | may be ≠ null briefly | `smee-attempt` → `smee-active` | `rePromoteTimer` fired → `onModeChange('smee-attempt')` recreates smee source; `onReconnectSuccess` promotes to `smee-active` and the callback for `smee-active` releases the poll handle. |

## `onModeChange` handler behaviour

The single `selector.onModeChange((next: SourceMode) => ...)` registration handles three cases:

### `next === 'poll-fallback'`

**Origin (post-#997)**: runtime demotion (`onReconnectAttempt` failures OR `observeElapsed` silence), or startup fall-through via `markStartupSmeeFailed()`.

**Actions**:

1. Do NOT stop `smeeHandle` (unless it is already `null` — startup case).
2. Fire-and-forget async: call `startPollMode()`.
3. On `outcome === 'permanent-exit'`: set `permanentExit = true`, call `stop()`.
4. On `outcome === 'transient-fail'`: call `stop()` (poll couldn't even start — genuine dead end).
5. On `outcome === 'ok'`: `pollHandle` is now set; leave `smeeHandle` alone.

**Change from pre-#997**: previous code called `await s.source.stop()` before `startPollMode()`. That call is removed. This is the core bug fix.

### `next === 'smee-active'` (NEW)

**Origin**: bridge exit from `poll-fallback` via `onReconnectSuccess()` while the smee source was reconnecting in the background.

**Actions**:

1. If `pollHandle != null`: release it (call `p.release()`, set `pollHandle = null`).
2. Leave `smeeHandle` alone.

No async work; the smee source is already streaming to `onEvent`, so stdout stays hot.

### `next === 'smee-attempt' && discovery != null`

**Origin (unchanged)**: `rePromoteTimer` tick from `poll-fallback` (either startup or runtime).

**Actions (unchanged shape)**:

1. Release `pollHandle` if set.
2. Fire-and-forget async: call `startSmeeMode(discovery.url)`.
3. On `permanent-exit` / `transient-fail`: same handling as today. On `transient-fail`, re-enter poll-mode (nested retry).

**Note**: in practice, this branch only fires in the startup-transient-fail case where the original `smeeHandle` is `null`. In the runtime-demote-then-recover case, the bridge exits via `onReconnectSuccess() → smee-active` before `rePromoteTimer` gets a chance to tick, so `smee-attempt` is never observed.

## Startup fall-through path

**Location**: `runDoorbell()`, after `startSmeeMode(discovery.url)` returns `transient-fail` (~line 533).

**New wire**:

```ts
if (outcome === 'transient-fail') {
  selector.markStartupSmeeFailed();  // NEW
  const pollOutcome = await startPollMode();
  // ... existing outcome handling unchanged
}
```

**Effect**: the selector transitions `smee-attempt → poll-fallback` with reason `startup-smee-failed`, emits the stderr line, arms the `rePromoteTimer`. `startPollMode()` then opens the poll subscriber. From here the state is identical to a "startup, no channel" but with re-promote armed.

## `runSmeeMode` wiring change

`sourceOptions` (used to construct `SmeeDoorbellSource`) gains one field:

```ts
onSseBytes: () => input.selector.onSseBytes(),
```

Placed alongside `onReconnectAttempt` and `onReconnectSuccess`.

## `stopPromise` / `stop()` interaction

Unchanged. `stop()` is still the sole path to `stopPromise` resolution. The only paths that call `stop()` in the `onModeChange` handler are:

- `poll-fallback` branch, when `startPollMode()` returns `permanent-exit` or `transient-fail`.
- `smee-attempt` branch, when the nested `startPollMode()` returns `permanent-exit` or `transient-fail`.
- The `smee-active` branch **never calls `stop()`** — bridge exit is a success signal.

Notably, the previous code called `stop()` implicitly by ending the stdout stream once `stopPromise` resolved. Removing the `s.source.stop()` call in the `poll-fallback` branch severs that path — the smee source keeps producing events, so stdout stays writable.

## Teardown (unchanged shape)

`tearDownActiveSource()` still stops both handles at process shutdown. No change.

## SIGINT / SIGTERM (unchanged)

External signals still resolve `stopPromise` → teardown → `exit(0)`. Bridge-mode's non-terminal behaviour applies to internal signals only (failure counts, silence, transient-fail startup). Explicit shutdown always wins.

## Testable observations

For FR-007 regression tests, the following are observable via test seams:

- `stdout.write` calls with the payload sequence — should never terminate mid-run in bridge scenarios.
- `stderr.write` calls — should show exactly the expected transitions (`smee` → `poll-fallback` → `smee` for bridge; `smee` → `poll-fallback` for `startup-smee-failed`).
- The injected `smeeSourceFactory` receives an `onSseBytes` callback that can be invoked from test code to drive the selector's byte-liveness path deterministically.
- The injected `sourceSelectorFactory` allows overriding `demoteAfterMsWithoutSuccess` and `rePromoteIntervalMs` to compressed values for CI speed (or leaving them at defaults and driving `vi.useFakeTimers()`).

The FR-007 test file (`doorbell-bridge.test.ts`) uses factory injection for both.
