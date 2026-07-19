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

**Answer**: *Pending*

### Q2: Shared vs. independent constants
**Context**: FR-001 and FR-002 say the two horizons "must move together" ("in lockstep"). Today they live as two distinct constants (`DEFAULT_IDLE_TTL_MS` in `event-bus-registry.ts:43`, `retentionMs` in `event-bus.ts:132`), each 600_000. Keeping them as two independent constants is easy to accidentally desync in the future.
**Question**: Should the two horizons be expressed as a single shared constant, or remain two independent constants set to the same value?
**Options**:
- A: One shared exported constant referenced from both call sites (structurally enforces lockstep)
- B: Keep as two independent constants both set to the same numeric value (minimal diff; ordering enforced only by convention)
- C: Keep independent, with `retentionMs` set slightly larger than `DEFAULT_IDLE_TTL_MS` (defense in depth — bus survives, buffer trim never fires first)

**Answer**: *Pending*

### Q3: Runtime configurability
**Context**: The spec picks static numeric horizons. Ops may want to tune this without a code change (e.g. investigating a specific epic), and tests will need short horizons to exercise the code paths in reasonable wall time (see Q5).
**Question**: Should the new horizon values be runtime-configurable, or hard-coded?
**Options**:
- A: Hard-coded constants only (simplest; tune via redeploy; tests must use fake timers)
- B: Env-var overrides with hard-coded defaults (e.g. `COCKPIT_BUS_IDLE_TTL_MS`, `COCKPIT_BUS_RETENTION_MS`); ops-tunable at process start
- C: Constructor/options injection only (test-friendly; no ops surface)
- D: Both env vars AND constructor injection

**Answer**: *Pending*

### Q4: retentionCount cap under longer time horizon
**Context**: FR-003 pins `retentionCount = 10_000` as the memory bound. Under a 60–120 min time window, a chatty epic could exceed 10K events before the time trim fires, dropping the oldest entries. A cursor pointing at a dropped position currently classifies `expired` (`event-bus.ts:170-171`) — same reset path this spec is trying to eliminate.
**Question**: How should the fix handle the case where the `retentionCount` cap trims events out from under a live cursor within the new time horizon?
**Options**:
- A: Accept it — classify as `expired`, tool resets to head (current behavior; SC-001 excludes this from the target because it's count-driven, not time-driven)
- B: Also raise `retentionCount` (name a new bound — e.g. 50_000 or 100_000) so time is the effective bound in practice
- C: Explicitly out of scope; document as a known residual and file a follow-up

**Answer**: *Pending*

### Q5: Regression test time strategy
**Context**: FR-006(a) requires a test that keeps a bus quiet for **longer than the old 10-minute TTL** but within the new horizon (>10 min, <60–120 min). Real-time waits of that length are infeasible in CI.
**Question**: How should the regression tests simulate the long quiet gaps required by FR-006?
**Options**:
- A: Fake timers only (e.g. Vitest `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`)
- B: Injectable horizons only (test constructs the bus/registry with sub-second horizons; wall-time waits stay small)
- C: Fake timers, with real (default) horizon constants — tightest coupling to production values
- D: Injectable horizons on top of fake timers (both mechanisms available; tests choose per case)

**Answer**: *Pending*
