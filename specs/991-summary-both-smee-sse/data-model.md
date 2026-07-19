# Data Model: smee SSE reconnect cap + jitter

**Issue**: [#991](https://github.com/generacy-ai/generacy/issues/991)
**Branch**: `991-summary-both-smee-sse`

## Overview

This feature adds a single pure function to a new leaf package. There are no persisted entities, no wire messages, no DB tables — the "data model" is the helper's public type surface.

## Public types (in `@generacy-ai/smee-backoff`)

### `BackoffOptions`

```ts
export interface BackoffOptions {
  /**
   * Base pre-jitter delay in ms. The first attempt's un-capped value is
   * exactly `base`; each subsequent attempt doubles. Consumers pass their
   * own default (both smee consumers use 5_000).
   */
  base: number;

  /**
   * Upper bound on the pre-jitter delay in ms. After the equal-jitter
   * transform, the output is bounded to [cap/2, cap] — the cap is a hard
   * ceiling on the observed delay.
   */
  cap: number;

  /**
   * Optional RNG. Defaults to `Math.random`. Callers do not pass this in
   * production — the seam exists for tests that need to pin the jitter
   * band (SC-004: variance assertions across repeated calls).
   */
  random?: () => number;
}
```

**Validation rules** (enforced at call time, not via zod — this is a hot-path leaf helper):
- `base > 0` — a zero/negative base collapses the ladder. Guarded via an `if` + thrown `RangeError` with a short message.
- `cap >= base` — a cap below the base has no useful behaviour. Guarded the same way.
- `attempt >= 0` and finite — negative or NaN attempts produce nonsense. Guarded via `Number.isFinite(attempt) && attempt >= 0`.
- `random`, if provided, must return a value in `[0, 1)`. Not enforced — trusted internal seam.

### `calculateBackoffDelay(attempt, opts)`

```ts
export function calculateBackoffDelay(
  attempt: number,
  opts: BackoffOptions,
): number;
```

**Semantics**:

1. Compute `raw = base * 2 ** attempt`.
2. Compute `capped = Math.min(raw, cap)`.
3. Compute `jitter = (opts.random ?? Math.random)() * (capped / 2)`.
4. Return `capped / 2 + jitter`.

**Output invariant**: return value ∈ `[capped/2, capped)`. The upper bound is exclusive because `Math.random()` returns `[0, 1)`; for the injected-RNG test with `random: () => 0.9999...`, the output approaches `capped` but does not reach it. This matches the acceptance criteria's "≤ MAX_BACKOFF_MS" wording (SC-001).

**Guarantees**:
- Never exceeds `cap`.
- Never below `capped/2` (so, in the worst case where `raw < cap`, never below `raw/2` — still ≥ `base/2` at attempt 0).
- Deterministic given a deterministic `random` — needed for SC-004 tests.

## Consumer-side changes

Both `SmeeWebhookReceiver` and `SmeeDoorbellSource` remove their local `MAX_BACKOFF_MS` constant and local `calculateBackoffDelay` method. Neither's public API changes — the `baseReconnectDelayMs?` option stays on both, the `onConnected` / `onEvent` / etc. callbacks stay on both, and `reconnectAttempt` remains a private field that resets to 0 on successful connect (FR-008 preserved).

No new fields, no new options, no new events.

## Non-persistence

- No config surface (no env var, no `cluster.yaml` field, no `.agency/` file). Both `base` and `cap` are compile-time constants at the call site.
- No observable state on the helper (it's a pure function; no module-level counters).

## Type-level relationships

```
@generacy-ai/smee-backoff
├── BackoffOptions           # exported interface
└── calculateBackoffDelay    # exported function
        │
        ├── consumed by ──── @generacy-ai/orchestrator
        │                    └── SmeeWebhookReceiver.reconnectDelayMs
        │
        └── consumed by ──── @generacy-ai/generacy
                             └── SmeeDoorbellSource.<runLoop reconnect sleep>
```

No cycles. No `generacy → orchestrator` edge introduced (per Q3 → A).
