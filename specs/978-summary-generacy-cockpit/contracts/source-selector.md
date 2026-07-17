# Contract: `SourceSelector`

Owns runtime demotion / re-promotion state and emits the FR-006 `source=…`
stderr line on every transition. Q3=D policy.

## Signature

```ts
export class SourceSelector {
  constructor(options: SourceSelectorOptions);
  readonly currentSource: SourceMode;
  onReconnectAttempt(failedAttempts: number): void;
  onReconnectSuccess(): void;
  observeElapsed(): void;
  onModeChange(cb: (next: SourceMode, reason: SourceReason) => void): void;
  stop(): void;
}
```

Where:
```ts
type SourceMode = 'smee-attempt' | 'smee-active' | 'poll-fallback';
type SourceReason =
  | 'startup-no-channel'
  | 'startup-smee-selected'
  | 'smee-runtime-lost'
  | 'smee-re-promoted';
```

## State machine

```
initial: smee-attempt      ── connect ok ──►  smee-active
                                                    │
                                                    │ 5 consecutive fails OR
                                                    │ 5 min without success
                                                    ▼
                              poll-fallback ◄────── smee-active
                                    │  ▲
     5-min re-promote timer ────────┘  │ connect ok during re-promote
                                       │
                                       ▼
                                 smee-attempt (transient; ok → smee-active)

initial: poll-fallback     (permanent unless a channel URL appears — this plan
                            does NOT re-attempt discovery mid-run because the
                            channel file is written once at orchestrator boot)
```

## Transition rules

| current | trigger | condition | next | `source=…` reason | line emitted? |
|---|---|---|---|---|---|
| — | construction, `initial: smee-attempt` | — | `smee-attempt` | `startup-smee-selected` | yes |
| — | construction, `initial: poll-fallback` | — | `poll-fallback` | `startup-no-channel` | yes |
| `smee-attempt` | `onReconnectSuccess()` | first success | `smee-active` | — | no |
| `smee-active` | `onReconnectAttempt(n)` | `n >= 5` | `poll-fallback` | `smee-runtime-lost` | yes |
| `smee-active` | `observeElapsed()` | `now() - lastSuccessfulConnectAt > 300_000` | `poll-fallback` | `smee-runtime-lost` | yes |
| `poll-fallback` | 5-min re-promote timer fires | initial was `smee-attempt` | `smee-attempt` | (deferred; emitted only if connect succeeds) | pending |
| `smee-attempt` (post re-promote) | `onReconnectSuccess()` | first success post re-promote | `smee-active` | `smee-re-promoted` | yes |
| `smee-attempt` (post re-promote) | 5 fails again | | `poll-fallback` | `smee-runtime-lost` | yes |

**No emitted line** is silent by design:
- `smee-attempt → smee-active`: happy path; the startup line already covered
  it.
- `poll-fallback → smee-attempt` before connect success: the operator sees
  the re-promotion succeed or fail via the eventual line, not by every
  timer tick.

## Line format (FR-006)

Single line to stderr per transition:
```
cockpit doorbell: source=<smee|poll-fallback> reason=<reason>
```

Examples:
```
cockpit doorbell: source=smee reason=startup-smee-selected
cockpit doorbell: source=poll-fallback reason=startup-no-channel
cockpit doorbell: source=poll-fallback reason=smee-runtime-lost
cockpit doorbell: source=smee reason=smee-re-promoted
```

Written via `options.stderr.write(...)` — injected for tests.

## Timers

- `elapsedTicker`: `setInterval` at 1 s cadence, calls `observeElapsed`
  internally. Cleared on `stop()`.
- `rePromoteTimer`: armed on entry to `poll-fallback` when initial mode was
  `smee-attempt` (i.e., the operator has a smee channel; the fallback is
  runtime-driven, not startup-driven). Cadence: 5 min. Cleared on
  transition to `smee-attempt` or `stop()`.

## Callbacks

`onModeChange(cb)` — called after `currentSource` mutates, before the
`source=…` line is written. Doorbell's outer `runDoorbell` uses this to
tear down the SSE loop and start the poll block (or vice versa).

Multiple callbacks are supported (in insertion order).

## Failure behavior

Never throws. `stderr.write` failures are swallowed.

## Test cases

- Construction with `initial: 'smee-attempt'` → `currentSource ===
  'smee-attempt'`; one stderr line `source=smee reason=startup-smee-selected`.
- Construction with `initial: 'poll-fallback'` → one stderr line
  `source=poll-fallback reason=startup-no-channel`; no timers armed.
- After first `onReconnectSuccess()` → `currentSource === 'smee-active'`;
  no additional stderr line.
- 4 `onReconnectAttempt(n)` with `n = 1..4` → no transition.
- 5th `onReconnectAttempt(5)` → transition to `poll-fallback`; one stderr
  line; `rePromoteTimer` armed.
- With `lastSuccessfulConnectAt = t0`, `observeElapsed()` at `t0 + 5min + 1ms`
  → transition to `poll-fallback`; one stderr line.
- After transition to `poll-fallback`, `rePromoteTimer` fires 5 min later
  → transition to `smee-attempt`; NO stderr line yet.
- After re-promote, `onReconnectSuccess()` → transition to `smee-active`;
  one stderr line `source=smee reason=smee-re-promoted`.
- After `stop()` → timers cleared; further calls no-op.
