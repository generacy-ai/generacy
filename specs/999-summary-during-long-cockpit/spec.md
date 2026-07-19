# Feature Specification: cockpit_await_events cursor invalidated mid-run — bus idle-TTL + buffer retention too short

**Branch**: `999-summary-during-long-cockpit` | **Date**: 2026-07-19 | **Status**: Draft

## Summary

During a long `/cockpit:auto` run, the operator's `cockpit_await_events` cursor is invalidated mid-run — the tool returns `resetFrom: "discarded"` and the auto skill responds with a full startup-sweep cursor-recovery. On the snappoll epic #1 run (2026-07-18, ~3h, preview `0.0.0-preview-20260718173256-7f9abdf`) this happened **3 times** (ledger: `cursor-recovery discarded: 3`). Each recovery re-runs the whole startup sweep (extra `gh`/GraphQL + re-classification). It never lost correctness — the sweep is idempotent and the run completed `epic-complete` — but it's wasted work on every long-quiet phase, and it will recur on every epic with implementation phases longer than the retention horizon.

## Root cause — event-bus lifetime is shorter than the auto loop's quiet phases

`cockpit_await_events` acquires the per-epic `EpicEventBus` from the registry per **call** and releases it when the call returns (`event-bus-registry.ts` `acquireEpicBus`/`releaseKey`). The cursor is `{epic, position, pnonce, bnonce}` where `bnonce` is a per-`EpicEventBus`-instance nonce (`event-bus.ts:134`). Classification (`event-bus.ts:150-174`):

- `bnonce !== this.busNonce` → `{ kind: 'discarded', reason: 'evicted' }`
- `pnonce !== INSTANCE_NONCE` → `cross-instance` (process restart — not this case; the MCP server ran the whole time)

Two horizons, both **600 s**, gate bus/buffer survival:

1. **Idle-TTL teardown.** When the last concurrent `cockpit_await_events` returns, `releaseKey` (`event-bus-registry.ts:287-304`) drops refCount to 0 and arms `DEFAULT_IDLE_TTL_MS = 600_000` (`:43`). If no drain re-acquires within 10 min, `current.stop()` + `registry.delete(key)` destroys the bus. The next drain builds `new EpicEventBus({ epic })` (`:175`) with a **fresh `busNonce`** → the operator's still-live cursor now mismatches → `discarded/evicted` → `resetFrom:"discarded"`.
2. **Buffer retention.** Even if the bus survived, `retentionMs = 600_000` (`event-bus.ts:132`) trims buffer entries older than 10 min (`trim()`), so after a >10 min quiet gap the buffer is empty and a valid-nonce cursor classifies `expired` (`:170-171`) → the tool resets to head the same way (`cockpit_await_events.ts:113`).

The auto loop calls `cockpit_await_events` **between** other work (subagent hops, `gh`, merges, and the 300 s heartbeat gaps). During P4 implementation — which the operator itself noted can run 30–60 min per issue, occasionally near an hour — the gap between drains routinely exceeds 10 min. So the bus is idle-evicted (or its buffer trimmed) and the cursor is invalidated **as a matter of course** on every long phase.

## Evidence (snappoll #1, session `430e07ba`)

- Three `resetFrom:"discarded"` tool results, each returning a fresh head cursor (`position:0`, new `bnonce`), each followed by a `christrudelpw/snappoll#1 · cursor-recovery · discarded · N` ledger line.
- Final ledger totals: `cursor-recovery discarded: 3`, `total ledger lines: 65`.
- The MCP server process did not restart (same `pnonce` throughout) → reason is `evicted`, i.e. idle-TTL teardown / buffer trim, **not** `cross-instance`.
- The gaps line up with long P4 implementation phases and heartbeat-only stretches (e.g. cursor recoveries around the 19:4x plan→implement churn and again at the 21:0x #11 re-validate).

## Requested behaviour

1. **Keep the active epic's bus + buffer warm for the whole run.** Raise both `DEFAULT_IDLE_TTL_MS` and the bus `retentionMs` to comfortably exceed the longest realistic quiet phase (≥ 60–90 min), and/or make them derive from an "active run" signal. While the bus lives, its own 30 s poll loop keeps events flowing and the buffer warm, so cursors stay `valid` across quiet phases. Keep `retentionCount = 10_000` as the memory bound.
2. **Idle/LRU teardown must still reclaim buses for epics that are genuinely no longer watched** — no leak of stale per-epic buses.
3. **A cursor issued before a long quiet gap must classify `valid`** on the next drain (not `discarded` and not `expired`), provided the quiet gap is within the new horizon.

## User Stories

### US1: Long, event-quiet phase keeps the cursor valid

**As an** operator running `/cockpit:auto` against a long epic,
**I want** my `cockpit_await_events` cursor to remain `valid` across 30–60+ min quiet phases,
**So that** the auto skill does not have to re-run a full startup-sweep cursor recovery on every long implementation phase.

**Acceptance Criteria**:
- [ ] A cursor issued before a ≥60-minute quiet gap, drained after the gap, classifies `valid` (no `discarded`, no `expired`).
- [ ] The active per-epic `EpicEventBus` and its buffer survive the quiet gap.
- [ ] The operator loop does not log any `cursor-recovery discarded` or `cursor-recovery expired` ledger line attributable to idle-TTL teardown or buffer trim of the actively-watched epic.

### US2: Idle epics still get reclaimed

**As a** long-running MCP server hosting many epics over time,
**I want** buses for epics that are no longer being watched to be torn down after their idle horizon,
**So that** we do not accumulate per-epic state indefinitely.

**Acceptance Criteria**:
- [ ] After the new idle-TTL elapses with no `acquireEpicBus` and no drain, the bus is stopped and removed from the registry.
- [ ] Memory usage stays bounded by `retentionCount` per active bus and by the reclaim of idle buses.

### US3: Regression coverage

**As a** maintainer,
**I want** a regression test that catches any future reduction of the horizon below realistic quiet-phase durations,
**So that** this class of bug does not recur.

**Acceptance Criteria**:
- [ ] A test drives a bus quiet for longer than the *old* 10-min TTL but within the *new* horizon and asserts a cursor issued before the quiet gap still classifies `valid`.
- [ ] A test asserts that after the new horizon elapses with no watchers, the bus IS torn down (no-leak counterpart).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `DEFAULT_IDLE_TTL_MS` in `event-bus-registry.ts` MUST be raised so that a per-epic bus survives quiet gaps typical of long implementation phases (target: ≥ 60–90 min). | P0 | Core fix — removes the idle-TTL teardown branch of the cursor-invalidation cause. |
| FR-002 | `retentionMs` in `event-bus.ts` MUST be raised in lockstep with FR-001 so that a valid-nonce cursor issued before a quiet gap does not classify `expired` on the next drain. | P0 | Both horizons must move together — raising only one still triggers cursor reset via the other branch. |
| FR-003 | The `retentionCount` upper bound (currently `10_000`) MUST be retained as the memory bound so that a longer time-window does not translate to unbounded memory growth on chatty epics. | P0 | Preserves the memory-safety guarantee while relaxing the time horizon. |
| FR-004 | Idle/LRU teardown MUST still fire for epics that receive no `acquireEpicBus` and no drain within the new horizon — no leak of stale buses. | P0 | Ensures the fix does not trade a bug for a leak. |
| FR-005 | The `bnonce` / `pnonce` classification protocol in `event-bus.ts:150-174` MUST remain unchanged. This spec changes horizons only, not the cursor protocol. | P0 | Cross-instance detection (process restart) must still work. |
| FR-006 | Regression test MUST cover: (a) a bus quiet for longer than the *old* 10-min TTL but within the *new* horizon → a cursor issued before the quiet gap classifies `valid` (no discard/expired reset); (b) a bus quiet for longer than the *new* horizon with no watchers → the bus IS torn down (idle reclaim still works). | P0 | Prevents regression in both directions — the fix and the no-leak counterpart. |
| FR-007 | A changeset MUST be included in the PR (patch bump under `workflow:speckit-bugfix`). | P0 | Per CI gate documented in CLAUDE.md. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `resetFrom:"discarded"` / `resetFrom:"expired"` cursor recoveries during a multi-hour auto run with 30–60 min quiet phases, attributable to idle-TTL teardown or buffer trim of the actively-watched epic | 0 | Manual `/cockpit:auto` run against a long epic; inspect ledger totals. |
| SC-002 | Per-epic `EpicEventBus` survival across the run's longest quiet phase | 100% | Regression test FR-006(a) passes in CI. |
| SC-003 | Bus reclaim for genuinely-unwatched epics after the new horizon | Bus stopped and removed from registry | Regression test FR-006(b) passes in CI. |
| SC-004 | Memory bound on chatty epics under the longer time horizon | Buffer size ≤ `retentionCount` | Existing `retentionCount` cap unchanged; unit test on `trim()` behavior. |

## Assumptions

- The MCP server process lifetime is expected to comfortably exceed a single epic's `/cockpit:auto` run duration (multiple hours). If the process restarts, `pnonce` mismatch → `cross-instance` classification — that path is out of scope for this spec.
- The active epic's bus has its own 30 s poll loop that keeps events flowing while the bus lives, so a longer `retentionMs` does not require any additional refresh mechanism to keep the buffer warm.
- The auto skill's cursor-recovery path remains correct as a safety net for any residual reset (e.g., cross-instance) — this spec reduces frequency of the reset, not its handler.

## Out of Scope

- Pinning the bus for the run's duration via a long-lived subscription / keepalive acquire (option 2 in the issue). Complementary but not required once horizons are extended; can be added later if we find edge cases the horizon extension does not cover.
- Cheaper cursor-recovery from the doorbell/smee stream instead of a full startup-sweep (option 3 in the issue). Partly skill-side (auto.md); worth coordinating separately but not required to close this issue.
- Changes to the `bnonce` / `pnonce` cursor protocol.
- Changes to the auto skill's `cursor-recovery` handler in `auto.md`.

---

*Generated by speckit*
