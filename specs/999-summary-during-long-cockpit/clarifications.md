# Clarifications

## Batch 1 — 2026-07-19

### Q1: Horizon target value
**Context**: FR-001 and FR-002 specify a range ("≥ 60–90 min") but not a single value. Implementation needs one concrete number for `DEFAULT_IDLE_TTL_MS` and `retentionMs`.
**Question**: What exact horizon value should be used?
**Options**:
- A: 60 minutes (3,600,000 ms) — lower bound, covers longest observed quiet phase (~1h)
- B: 90 minutes (5,400,000 ms) — upper bound, adds ~50% safety margin over observed max
- C: 120 minutes (7,200,000 ms) — 2× observed max, wide comfort margin
- D: Other value

**Answer**: C — 120 minutes (7,200,000 ms). The longest observed quiet phase was ~1h, so 60 min (A) leaves zero headroom and the next slightly-longer epic re-triggers the exact bug this fixes; tails only get longer. The cost of a wider window is near-zero here: per-bus memory stays bounded by `retentionCount` (not the time window — see Q4), and an idle/released bus does NOT poll (`releaseKey` calls `pausePoller`), so a lingering idle bus just retains its buffer a bit longer, bounded by the `maxBuses=100` LRU. Pick 120 min for genuine comfort margin. (90 min / B is acceptable if you want to stay conservative.)

### Q2: Shared vs. independent constants
**Context**: FR-001 and FR-002 say the two horizons "must move together" ("in lockstep"). Today they live as two distinct constants (`DEFAULT_IDLE_TTL_MS` in `event-bus-registry.ts:43`, `retentionMs` in `event-bus.ts:132`), each 600_000. Keeping them as two independent constants is easy to accidentally desync in the future.
**Question**: Should the two horizons be expressed as a single shared constant, or remain two independent constants set to the same value?
**Options**:
- A: One shared exported constant referenced from both call sites (structurally enforces lockstep)
- B: Keep as two independent constants both set to the same numeric value (minimal diff; ordering enforced only by convention)
- C: Keep independent, with `retentionMs` set slightly larger than `DEFAULT_IDLE_TTL_MS` (defense in depth — bus survives, buffer trim never fires first)

**Answer**: A — one shared exported constant referenced from both call sites (`event-bus-registry.ts:43` and `event-bus.ts:132`). The FR's "must move together in lockstep" is best enforced structurally rather than by convention; two independent constants (B) are exactly what silently desync later. Prefer A over C (`retentionMs` slightly larger than idle-TTL): the effective horizon is always `min(idle-TTL, retentionMs)`, so a single equal value is simpler and there's no benefit to making `retentionMs` larger than a bus that's already been idle-torn-down.

### Q3: Runtime configurability
**Context**: The spec picks static numeric horizons. Ops may want to tune this without a code change (e.g. investigating a specific epic), and tests will need short horizons to exercise the code paths in reasonable wall time (see Q5).
**Question**: Should the new horizon values be runtime-configurable, or hard-coded?
**Options**:
- A: Hard-coded constants only (simplest; tune via redeploy; tests must use fake timers)
- B: Env-var overrides with hard-coded defaults (e.g. `COCKPIT_BUS_IDLE_TTL_MS`, `COCKPIT_BUS_RETENTION_MS`); ops-tunable at process start
- C: Constructor/options injection only (test-friendly; no ops surface)
- D: Both env vars AND constructor injection

**Answer**: D — both env-var overrides AND constructor/options injection, but **REUSE the override surfaces that already exist rather than adding new ones**. The registry already reads `process.env.COCKPIT_MCP_BUS_IDLE_TTL_MS` (+ `COCKPIT_MCP_BUS_MAX`) via `parsePositiveIntEnv` and accepts `options.idleTtlMs`; the bus already honors `COCKPIT_MCP_EVENT_RETENTION_MS` / `COCKPIT_MCP_EVENT_RETENTION_COUNT` and `options.retentionMs` / `retentionCount`. So this change should ONLY move the DEFAULT constants (per Q1/Q2) — do **not** introduce the differently-named `COCKPIT_BUS_IDLE_TTL_MS` / `COCKPIT_BUS_RETENTION_MS` from the question draft; keep the existing `COCKPIT_MCP_*` names so ops tuning and the test injection seams stay consistent.

### Q4: retentionCount cap under longer time horizon
**Context**: FR-003 pins `retentionCount = 10_000` as the memory bound. Under a 60–120 min time window, a chatty epic could exceed 10K events before the time trim fires, dropping the oldest entries. A cursor pointing at a dropped position currently classifies `expired` (`event-bus.ts:170-171`) — same reset path this spec is trying to eliminate.
**Question**: How should the fix handle the case where the `retentionCount` cap trims events out from under a live cursor within the new time horizon?
**Options**:
- A: Accept it — classify as `expired`, tool resets to head (current behavior; SC-001 excludes this from the target because it's count-driven, not time-driven)
- B: Also raise `retentionCount` (name a new bound — e.g. 50_000 or 100_000) so time is the effective bound in practice
- C: Explicitly out of scope; document as a known residual and file a follow-up

**Answer**: A — accept it: classify as `expired` and reset to head (current behavior). This is count-driven, not time-driven, and SC-001 already scopes it out of the target. At cockpit's per-epic transition granularity (issue/PR/check state changes for ~one epic's children), 10k events inside a 2h window would require ~83 events/min sustained — implausible. Raising `retentionCount` (B) carries a real memory cost multiplied by the `maxBuses=100` LRU cap (e.g. 50k events × ~1KB × 100 buses), which A avoids for a scenario that won't occur in practice. Keep `retentionCount=10_000` as the hard memory bound; the time horizon is the binding constraint in every realistic run.

### Q5: Regression test time strategy
**Context**: FR-006(a) requires a test that keeps a bus quiet for **longer than the old 10-minute TTL** but within the new horizon (>10 min, <60–120 min). Real-time waits of that length are infeasible in CI.
**Question**: How should the regression tests simulate the long quiet gaps required by FR-006?
**Options**:
- A: Fake timers only (e.g. Vitest `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`)
- B: Injectable horizons only (test constructs the bus/registry with sub-second horizons; wall-time waits stay small)
- C: Fake timers, with real (default) horizon constants — tightest coupling to production values
- D: Injectable horizons on top of fake timers (both mechanisms available; tests choose per case)

**Answer**: D — injectable horizons on top of fake timers (both mechanisms available, chosen per case). The code is already built for injection (`EpicEventBusOptions.now` / `retentionMs` / `nonce`; `acquireEpicBus` `options.now` / `idleTtlMs` / `maxBuses`), so most tests can construct sub-second horizons for speed. But the idle-TTL teardown uses a real `setTimeout` in `releaseKey` (`event-bus-registry.ts:293`), so asserting the bus is actually torn-down/recreated after the TTL is deterministic only under fake timers (`vi.useFakeTimers` + `advanceTimersByTimeAsync`) — the same approach the #997 source-selector tests used. FR-006(a)'s ">10min quiet, cursor still valid" case: inject a long horizon, advance fake time past 10 min, assert the pre-gap cursor still classifies `valid` (no `discarded`/`expired` reset).
