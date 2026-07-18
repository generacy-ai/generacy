# Clarifications — #997

Generated: 2026-07-18

## Batch 1 — 2026-07-18

### Q1: Silence-demotion heuristic (FR-002)
**Context**: FR-002 offers two shapes for the `demoteAfterMsWithoutSuccess` behavior — remove entirely, or refresh liveness on inbound bytes. The choice determines whether `observeElapsed`, the `elapsedTicker`, and `lastSuccessfulConnectAt` survive at all in `source-selector.ts`. Root cause 1 in the issue is that `lastSuccessfulConnectAt` is refreshed only on (re)connect, never on a healthy but quiet stream.
**Question**: Should `demoteAfterMsWithoutSuccess` be removed entirely, or retained with its liveness signal refreshed on inbound SSE bytes?
**Options**:
- A: Remove the heuristic entirely — delete `observeElapsed`, the `elapsedTicker`, and `lastSuccessfulConnectAt`. Silence never triggers a demotion.
- B: Retain the heuristic, refresh `lastSuccessfulConnectAt` on any inbound SSE bytes (events + `:` keepalives), and raise the default beyond any realistic step duration.
- C: Retain the heuristic, refresh only on real event payloads (not SSE keepalives), and raise the default.

**Answer**: *Pending*

### Q2: Runtime demotion path (FR-004)
**Context**: FR-004 permits either removing runtime demotion entirely, or keeping it as a live bridge that continuously retries smee re-promotion. This decides whether the `onModeChange('poll-fallback')` branch at `doorbell.ts:483-497` and the `rePromoteTimer` machinery in `source-selector.ts:150-195` remain in the codebase. `SmeeDoorbellSource.runLoop` already reconnects forever on its own, so runtime demotion may no longer be load-bearing.
**Question**: When runtime demotion to `poll-fallback` is triggered from any cause (failures, timeouts), what should happen?
**Options**:
- A: Remove runtime demotion entirely. Once startup selected smee, the process stays on smee for the run and `SmeeDoorbellSource.runLoop` handles all reconnects. No `poll-fallback` state during a run.
- B: Retain runtime demotion as a live bridge — stdout stays open producing poll snapshots while smee reconnection continues in the background; on smee re-promotion, switch back to smee. Never terminal, never a process exit.

**Answer**: *Pending*

### Q3: Failure-count guard fate (FR-003)
**Context**: `DEFAULT_DEMOTE_AFTER_FAILURES = 5` currently demotes from `smee-active` after 5 consecutive reconnect failures (`source-selector.ts:93-95`). FR-003 says this must not terminate the sensor but does not prescribe whether the guard itself should stay, disappear, or be repurposed. Depends partly on Q2.
**Question**: What should happen to `DEFAULT_DEMOTE_AFTER_FAILURES` and its `onReconnectAttempt` guard?
**Options**:
- A: Remove the constant and its guard entirely — no failure count triggers a demotion.
- B: Keep the guard but make the transition non-terminal (aligns with Q2=B "live bridge" — demote to poll-fallback while smee keeps reconnecting).
- C: Keep the constant, remove the demotion, replace with a one-time stderr warning line (no source-mode transition, purely observability).

**Answer**: *Pending*

### Q4: Startup smee-attempt failure (FR-005)
**Context**: In `doorbell.ts:522-548`, when the initial `startSmeeMode` returns `transient-fail`, the code falls through to poll-mode. FR-005 says "startup source selection is unchanged," but a smee-attempt whose first connection never succeeds sits ambiguously between "startup" and "runtime." The distinction matters for whether US2's "reconnects indefinitely" contract applies from before the first success or only after.
**Question**: If the initial `startSmeeMode` attempt returns `transient-fail` (discovery non-null, but first connect never succeeds), what should happen?
**Options**:
- A: Preserve current behavior — fall through to poll-mode at startup as today. Only *runtime* smee loss (after at least one success) is covered by US2.
- B: Keep retrying smee indefinitely from startup too (never fall through to poll-mode when discovery is non-null). Mirrors runtime behavior.

**Answer**: *Pending*

### Q5: Regression test time strategy (FR-007)
**Context**: FR-007 (a) requires a regression test for a ≥60-minute quiet `smee-active` connection producing no demotion and no exit. A one-hour real-time test is impractical in CI; the test needs a deterministic time strategy. The `SourceSelector` already exposes a `now` option and uses `setInterval` for the elapsed ticker.
**Question**: How should the ≥60-minute-quiet regression test simulate time?
**Options**:
- A: Inject a fake `now()` (via the `now` option) and advance it past 60 min inside a synchronous test — no real timers involved.
- B: Use fake timers (`vi.useFakeTimers`) to drive both `Date.now()` and the `elapsedTicker` interval together.
- C: Set `demoteAfterMsWithoutSuccess` to a small value (e.g., 100 ms) and assert no demotion fires — inversely tests the FR-002 chosen behavior at compressed scale.
- D: N/A if Q1=A (heuristic removed) — replace with an audit that no `smee-runtime-lost` code path exists.

**Answer**: *Pending*
