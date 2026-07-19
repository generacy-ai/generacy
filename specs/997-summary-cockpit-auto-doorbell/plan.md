# Implementation Plan: Doorbell survives smee loss + quiet windows

**Feature**: Stop the `/cockpit:auto` doorbell from exiting when the smee.io SSE connection drops or goes event-quiet. Runtime demotion becomes a strictly non-terminal LIVE BRIDGE (poll snapshots while `SmeeDoorbellSource.runLoop` keeps reconnecting smee in the background). The 5-min silence heuristic is retained but refreshed on ANY inbound SSE bytes (keepalives + payloads) and its threshold shrunk to a small multiple of the smee.io keepalive interval.
**Branch**: `997-summary-cockpit-auto-doorbell`
**Status**: Complete

## Summary

The doorbell dies mid-run because a runtime demotion to `poll-fallback` ends up terminating the process — the `onModeChange('poll-fallback')` branch at `packages/generacy/src/cli/commands/cockpit/doorbell.ts:483-497` `await`s `s.source.stop()` (killing smee), then starts poll-mode, and then `stopPromise` eventually resolves and the sensor's stdout stream ends. Two upstream triggers make that demotion fire too eagerly:

1. **Trigger-happy silence heuristic** — `SourceSelector.observeElapsed()` demotes after 5 minutes without `lastSuccessfulConnectAt` moving, but `lastSuccessfulConnectAt` refreshes ONLY on (re)connect — never while a healthy-but-quiet SSE stream is open. A 30–60-min planning step wrongly counts as "smee lost."
2. **Trigger-happy failure count** — 5 consecutive reconnect failures (~95 s under #991's 5→30 s ladder) demote a transient smee.io blip.

The fix per the clarifications:

1. **Bridge mode, never terminal (FR-004 / Q2 → B).** On runtime demotion the smee source stays running in the background (its `runLoop` already reconnects forever), and poll snapshots stream in parallel. When smee reconnects, `SourceSelector` transitions `poll-fallback → smee-active` (skipping `smee-attempt`) with reason `smee-re-promoted`, and the doorbell tears down the poll bridge. Stdout stream never ends from a smee loss.
2. **Byte-liveness in the connection owner (FR-002 / Q1 → B).** `SmeeDoorbellSource` invokes a new `onSseBytes()` callback on every `reader.read()` that returns bytes (both smee.io `:` keepalive comments and event payloads). `SourceSelector.onSseBytes()` refreshes `lastSuccessfulConnectAt`. The threshold shrinks from `300_000` ms to `90_000` ms (3× smee.io's ~30 s keepalive interval) — a genuinely dead half-open stream is still detected, and its firing action is the bridge (not exit).
3. **Failure-count guard stays, transition is non-terminal (FR-003 / Q3 → B).** `DEFAULT_DEMOTE_AFTER_FAILURES = 5` is retained; only the terminal behaviour changes.
4. **Startup transient-fail also bridges (FR-006 / Q4 → A req).** When the initial `startSmeeMode` returns `transient-fail` (discovery non-null, first connect never succeeds), we transition the selector to `poll-fallback` explicitly via a new `markStartupSmeeFailed()` method so the existing `rePromoteTimer` machinery arms and the doorbell can recover to smee later. Same non-terminal live-bridge shape as runtime demotion. FR-005's user-observable "fall through to poll" behaviour is unchanged.
5. **Regression tests with fake timers (FR-007 / Q5 → B).** `vi.useFakeTimers()` drives both `Date.now()` and the `elapsedTicker` interval together. Three scenarios: (a) ≥60-min quiet-but-alive stream (periodic keepalive bytes) — no demotion, no exit; (b) keepalives stop → liveness fires → demote to bridge → smee keeps reconnecting, no exit; (c) N reconnect failures during a smee.io drop → live bridge opens, smee eventually reconnects → re-promotion, no exit.

Changeset (`patch`, `workflow:speckit-bugfix`, `@generacy-ai/generacy`) is required per the CI gate.

## Technical Context

- **Language**: TypeScript (ESM, `NodeNext`). Node >=22 (the CLI package's floor).
- **Package**: `@generacy-ai/generacy`. No new packages, no new deps.
- **Test runner**: `vitest`. Fake timers via `vi.useFakeTimers()` — the same pattern used in the existing `source-selector.test.ts` re-promote-timer cases (`__tests__/source-selector.test.ts:91-127`).
- **Blast radius**: three files — `source-selector.ts`, `smee-source.ts`, `doorbell.ts`. Plus one new regression test file. The `SmeeDoorbellSource.runLoop` reconnect ladder (owned by #991) is untouched. `channel-discovery.ts`, `webhook-target-resolver.ts`, `sse-parser.ts`, and the `subscribe`/`aggregate` machinery are untouched.
- **Non-goals**: no changes to reconnect backoff (owned by #991); no changes to startup source selection semantics beyond FR-006; no skill-side re-arming policy (agency#431's passive no-re-spawn is defense-in-depth, not required to close this issue).
- **CI gate**: this diff touches `packages/generacy/src/` non-test files → a `.changeset/*.md` file must be **added** in this PR. Bump level `patch` (defect fix, no public API change).

### Files that will change

| File | Change |
|------|--------|
| `packages/generacy/src/cli/commands/cockpit/doorbell/source-selector.ts` | MODIFIED. `DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS`: `300_000 → 90_000`. New public method `onSseBytes()` refreshes `lastSuccessfulConnectAt` when in `smee-active`. `onReconnectSuccess()` extended: when `_current === 'poll-fallback'`, transitions directly to `smee-active` with reason `smee-re-promoted` (bridge exit — runtime demotion recovery). New public method `markStartupSmeeFailed()` transitions `smee-attempt → poll-fallback` with reason `startup-smee-failed`, starts `rePromoteTimer` (FR-006). `SourceReason` union gains `'startup-smee-failed'`. Existing state-machine invariants preserved. |
| `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` | MODIFIED. `SmeeDoorbellSourceOptions` gains optional `onSseBytes?: () => void`. `connect()`'s reader loop invokes `onSseBytes()` after each successful `reader.read()` returning bytes (guarded try/catch, same pattern as `onReconnectAttempt`/`onReconnectSuccess`). No other behavioural change. |
| `packages/generacy/src/cli/commands/cockpit/doorbell.ts` | MODIFIED. `runSmeeMode` wires `onSseBytes: () => selector.onSseBytes()` into `sourceOptions`. `selector.onModeChange` branch for `next === 'poll-fallback'`: **STOP calling `s.source.stop()`** — the smee source keeps reconnecting in the background; only `startPollMode()` runs (adds the bridge). New branch for `next === 'smee-active'`: tears down the poll bridge (`p.release()`), leaves `smeeHandle` alive (bridge exit — runtime recovery). Startup `transient-fail` fallthrough (line 533) calls `selector.markStartupSmeeFailed()` before `startPollMode()` so the `rePromoteTimer` arms (FR-006). |
| `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/source-selector.test.ts` | MODIFIED. Update the "5th reconnect attempt demotes" test to assert the transition target is still `poll-fallback` but the poll-fallback state does NOT terminate anything (this test only asserts selector state, which is unchanged). Update the "observeElapsed past 5-min window demotes" test to use the new `90_000` ms threshold. Add cases: (a) `onSseBytes()` refreshes liveness so a ≥60-min quiet-but-alive stream never demotes; (b) stopping the byte stream past `90_000` ms + `elapsedTicker` demotes; (c) `onReconnectSuccess()` while `_current === 'poll-fallback'` transitions directly to `smee-active` with `smee-re-promoted`; (d) `markStartupSmeeFailed()` from `smee-attempt` transitions to `poll-fallback`, starts `rePromoteTimer`, emits the new `startup-smee-failed` line. |
| `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/doorbell-bridge.test.ts` | NEW. Fake-timer regression tests for FR-007(a) / (b) / (c). Drives `runDoorbell()` with an injected `sourceSelectorFactory` + `smeeSourceFactory` so the fetch mock can be scripted through: quiet stream with keepalive bytes (no demotion, no exit); byte stream stops (liveness fires → bridge opens → still no exit); reconnect failures reach the guard threshold (bridge opens → smee reconnects on next attempt → re-promote → poll bridge released → still no exit). Asserts stdout stream stays open across all scenarios (SC-004 audit). |
| `.changeset/997-doorbell-bridge-mode.md` | NEW. `patch` bump for `@generacy-ai/generacy`. `workflow:speckit-bugfix`. |

### File structure (unchanged)

```
packages/generacy/src/cli/commands/cockpit/
├── doorbell.ts                                    # MODIFIED — bridge-mode onModeChange
└── doorbell/
    ├── source-selector.ts                         # MODIFIED — onSseBytes, bridge-exit, markStartupSmeeFailed
    ├── smee-source.ts                             # MODIFIED — onSseBytes callback wire
    └── __tests__/
        ├── source-selector.test.ts                # MODIFIED — new cases (a)-(d)
        └── doorbell-bridge.test.ts                # NEW — FR-007 regression triple
```

## Architectural Decisions

- **Byte-liveness lives in `SmeeDoorbellSource`, not the selector (FR-002 note / Q1 → B).** The connection owner is the only place that sees bytes on the wire; forcing the selector to peek at the byte stream would leak SSE-parser concerns into the state machine. The callback shape mirrors the existing `onReconnectAttempt` / `onReconnectSuccess` pattern.
- **`onReconnectSuccess()` doing the runtime bridge-exit (`poll-fallback → smee-active` directly, skipping `smee-attempt`) is preferred over letting the `rePromoteTimer` fire.** The smee source is already reconnecting on its own in bridge mode — no periodic timer is needed for recovery; the very next successful reconnect IS the recovery signal. The `rePromoteTimer` is retained purely for the FR-006 startup-transient-fail path where the smee source is stopped/discarded and a periodic re-attempt is the only way back.
- **A new `SourceReason` `'startup-smee-failed'`** over reusing `'smee-runtime-lost'`. The current selector already emits `startup-smee-selected` at construction; a different reason on the follow-up transition makes the two events distinguishable in logs and preserves the semantic gap between "runtime went bad" and "never got off the ground." Zero external consumers grep for these reason strings today, so cost is nil.
- **Threshold value 90_000 ms (3× smee.io's ~30 s keepalive).** Small enough to catch a genuinely dead half-open stream within one demote-and-reconnect cycle. Large enough to tolerate one missed keepalive without a false positive. Assumption documented in the spec: smee.io emits periodic `:` comments on healthy connections. If that assumption breaks, the worst case is a spurious bridge open, not a dead sensor (FR-004 makes it non-terminal).
- **No change to `DEFAULT_DEMOTE_AFTER_FAILURES = 5`.** Per Q3 → B, "not critical once the transition is non-terminal." Leaving it at 5 avoids re-tuning the retry-cliff heuristic in a bug-fix PR.
- **New regression test file** (`doorbell-bridge.test.ts`) instead of extending `doorbell.test.ts`. FR-007 requires ≥60-min fake-timer runs plus fetch-mock scripting for reconnect scenarios — enough setup that a dedicated file keeps the existing test file focused on its own coverage.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Followed the CLAUDE.md-encoded rules:

- **Changeset gate**: diff touches `packages/generacy/src/` non-test files → new `.changeset/997-doorbell-bridge-mode.md` (`patch`, `workflow:speckit-bugfix`).
- **No premature abstraction**: no new package, no new interface bundle, no builder/factory. The two new selector methods (`onSseBytes`, `markStartupSmeeFailed`) are direct additions to the existing state-machine surface.
- **No backwards-compat shims**: the FR-002 threshold change is a straight constant edit — no dual code path, no feature flag. Consumers of the selector's public API (only `doorbell.ts`) update in the same PR.
- **Comment discipline**: source-selector's existing JSDoc header updated to mention the bridge-mode contract. New methods get one-line JSDoc (why the callback exists / what the transition does). No inline running commentary. The regression test file gets one short header explaining the three FR-007 scenarios; individual `it()` names carry the specifics.

## Risks & Mitigations

- **R1: smee.io stops sending keepalives on healthy connections.** Byte-liveness (FR-002) would false-positive: a healthy stream trips the 90 s heuristic. Mitigation: FR-004 makes the firing action a bridge open (not exit), so the worst case is temporary poll snapshots + retry, not a dead sensor. Spec Assumptions section captures this trade-off.
- **R2: The bridge-exit path (`poll-fallback → smee-active` on `onReconnectSuccess`) fires while `pollHandle` is mid-`release()`.** Mitigation: the `pollHandle.release()` in the new `smee-active` branch is guarded by the same `pollHandle != null` idempotency check as the existing `smee-attempt` branch (line 499-503). Concurrent transitions are serialized through the callback list; the fire-and-forget `void (async ...)` block already handles it for `poll-fallback`.
- **R3: The 90 s threshold trips during a legitimate long GC pause / event-loop stall inside the doorbell process.** Mitigation: `lastSuccessfulConnectAt` refreshes on ANY inbound bytes, and the `elapsedTicker` is a `setInterval` — a paused event loop delays BOTH the ticker and the byte read equally, so a 30-second GC pause doesn't manufacture a fake elapsed. This is a real-time-elapsed compare, not a byte-arrival compare.
- **R4: Fake-timer FR-007(a) test flakes because `SmeeDoorbellSource.connect()` uses a real `fetch` reader.** Mitigation: inject a `smeeSourceFactory` that returns a stub source with a scripted `onSseBytes`/`onReconnectSuccess` sequence — the doorbell only sees the callback surface. The real reader/decoder loop is covered by `smee-source-reconnect.test.ts` (untouched by this PR).
- **R5: Startup `transient-fail` fallthrough races with the `rePromoteTimer` firing on the SAME tick.** Mitigation: `markStartupSmeeFailed()` is a synchronous call that sets `_current = 'poll-fallback'`, initialises `demotedAt`, and starts the timer — no `await`. The subsequent `await startPollMode()` runs after the state is coherent. First `tickRePromote()` fires after `rePromoteIntervalMs` (default 5 min), well after startup completes.

## Next Step

`/speckit:tasks` to generate the task list from this plan.
