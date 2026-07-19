# Data Model: Doorbell survives smee loss + quiet windows

**Issue**: [#997](https://github.com/generacy-ai/generacy/issues/997)
**Branch**: `997-summary-cockpit-auto-doorbell`

## Overview

No persisted entities, no wire messages, no on-disk state. The "data model" is the runtime type surface of three existing classes plus the state machine invariants they preserve. This document lists every type-level change; call-site prose lives in `research.md` and `plan.md`.

## Public types

### `SourceReason` (widened)

```ts
export type SourceReason =
  | 'startup-no-channel'
  | 'startup-smee-selected'
  | 'startup-smee-failed'      // NEW — startup smee connect never succeeded
  | 'smee-runtime-lost'
  | 'smee-re-promoted';
```

**Semantics of new value**:

- `startup-smee-failed` is emitted exactly once, only from `markStartupSmeeFailed()` (which is only callable from `smee-attempt`). Fires the `source=poll-fallback reason=startup-smee-failed\n` stderr line and starts the `rePromoteTimer`.
- Distinct from `smee-runtime-lost` (which fires on runtime demotion — the smee source successfully connected at least once, then bridge opens due to failure count or silence heuristic).
- Distinct from `startup-no-channel` (which fires at construction when no smee channel was discovered at all).

### `SourceSelectorOptions` (unchanged)

No fields added. `demoteAfterMsWithoutSuccess` still accepted as an override; only the default value changes.

### `SourceSelector` public method surface (widened)

```ts
class SourceSelector {
  // Existing
  get currentSource(): SourceMode;
  onModeChange(cb: ModeChangeCallback): void;
  onReconnectAttempt(failedAttempts: number): void;
  onReconnectSuccess(): void;
  observeElapsed(): void;
  stop(): void;

  // NEW
  onSseBytes(): void;
  markStartupSmeeFailed(): void;
}
```

**Method semantics**:

- **`onSseBytes()`**: no-op if `stopped` or `_current !== 'smee-active'`. Otherwise refreshes `lastSuccessfulConnectAt = now()`. Never emits a stderr line, never invokes mode-change callbacks. Idempotent under rapid repeat calls (same-tick calls collapse to one refresh).
- **`markStartupSmeeFailed()`**: no-op if `stopped` or `_current !== 'smee-attempt'`. Otherwise transitions to `poll-fallback` with reason `startup-smee-failed`. Emits one stderr line. Fires mode-change callbacks. Starts `rePromoteTimer` (side effect of the standard `transition()` path).

**Extended `onReconnectSuccess()` semantics** (existing method, new branch):

- If `_current === 'smee-attempt'`: existing behaviour (silent → `smee-active`, or emit `smee-re-promoted` when `pendingRePromoteEmit`).
- If `_current === 'poll-fallback'`: **NEW** — clears `rePromoteTimer`, transitions to `smee-active` with reason `smee-re-promoted` (runtime bridge exit).
- If `_current === 'smee-active'`: no state change; only counter reset + liveness refresh.

### Constant change

```ts
export const DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS = 90_000; // was 300_000
```

Public export retained for override use in tests and downstream call sites.

### `SmeeDoorbellSourceOptions` (widened)

```ts
export interface SmeeDoorbellSourceOptions {
  channelUrl: string;
  epicRef: string;
  gh: GhWrapper;
  runner?: CommandRunner;
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  onEvent: (event: CockpitStreamEvent) => Promise<void>;
  onReconnectAttempt: (failedAttempts: number) => void;
  onReconnectSuccess: () => void;
  onSseBytes?: () => void;                       // NEW
  onRefSetRefreshFailure?: (err: unknown) => void;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  refreshDebounceMs?: number;
  safetyNetIntervalMs?: number;
  baseReconnectDelayMs?: number;
}
```

**`onSseBytes` semantics**:

- Optional. If unset, `SmeeDoorbellSource` behaves exactly as today.
- Fired synchronously inside the `connect()` reader loop after every successful `reader.read()` returning bytes (`value != null && value.length > 0`).
- Invoked once per read cycle regardless of whether the buffered bytes form a complete SSE event or a partial line.
- Errors thrown from the callback are swallowed (same pattern as `onReconnectAttempt` / `onReconnectSuccess`).

## Validation rules

The selector's state machine invariants are preserved:

- `_current` transitions are always through `transition()` (the sole mutation point), which:
  - Emits exactly one stderr line per transition.
  - Fires each registered mode-change callback exactly once with the new mode + reason.
  - Manages the `rePromoteTimer` lifecycle (start on entry to `poll-fallback` when `initialWasSmee`; clear on exit).
- No self-loop transitions (guarded by `if (this._current === next) return;`).
- `stop()` is idempotent.
- Under `stopped === true`, all public methods (including new ones) short-circuit before mutating state.

## Non-persistence

- No config surface: no env var, no `cluster.yaml` field, no `.agency/` file. Threshold constants are edits in TypeScript source only.
- No observable module-level state. All state lives in `SourceSelector` instance fields.
- No new file-system reads/writes.

## Type-level relationships

```
SmeeDoorbellSource
├── options.onSseBytes ─── invoked on ─→ SourceSelector.onSseBytes()
├── options.onReconnectAttempt ─── (existing)
└── options.onReconnectSuccess ─── (existing)
        │
        └── extended to handle _current === 'poll-fallback' (bridge exit)

SourceSelector
├── onSseBytes()             ── refreshes lastSuccessfulConnectAt in smee-active
├── markStartupSmeeFailed()  ── smee-attempt → poll-fallback with 'startup-smee-failed'
├── (rePromoteTimer)         ── unchanged wiring; now also armed by markStartupSmeeFailed
└── (elapsedTicker)          ── unchanged; now sees fresher lastSuccessfulConnectAt from bytes

doorbell.ts (runDoorbell)
├── runSmeeMode wires onSseBytes callback into SmeeDoorbellSource construction
├── onModeChange('poll-fallback')  ── does NOT stop smee source anymore (bridge open)
├── onModeChange('smee-active')    ── NEW — releases pollHandle (bridge exit)
└── startup transient-fail path    ── calls selector.markStartupSmeeFailed() before startPollMode()
```

No cycles introduced. `SmeeDoorbellSource` still has zero knowledge of `SourceSelector` — it only knows about the callback signature.
