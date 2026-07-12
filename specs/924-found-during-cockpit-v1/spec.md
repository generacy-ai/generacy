# Feature Specification: cockpit_await_events — bus survives between calls; cursors typed by lifetime

**Branch**: `924-found-during-cockpit-v1` | **Date**: 2026-07-12 | **Status**: Draft

## Summary

`cockpit_await_events` currently destroys its per-epic bus at the end of every call (refcount-0 teardown in `finally`), so any cursor returned by call N is classified as `never-issued` by call N+1 and the whole session degrades to a startup-sweep per batch. This spec fixes the two structural bugs behind that: (1) decouple bus lifetime from call lifetime with an idle TTL so the poller keeps running between sequential calls, and (2) instance-tag cursors so that server-restart and TTL-eviction produce a `discarded`/reset signal rather than `never-issued`. Together these restore the FR-008 contract ("passing the same cursor returns the same tail") and the SC-003 dispatch-round win the tool exists to deliver.

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #58 — first MCP-path run (snappoll-1). Companion agency finding covers the playbook-side circuit breaker.

## Observed (snappoll-1, run 8)

Every `cockpit_await_events` call after the first fails cursor reuse: the session passes the cursor returned by batch N and gets

```
{"status":"error","class":"invalid-cursor","detail":"cursor position was never issued for epic christrudelpw/snappoll-1#1","hint":"start with cursor=undefined for a fresh subscription"}
```

— violating FR-008's core contract ("passing the same cursor returns the same tail"). The session recovers per its playbook (startup sweep + re-arm cursor-less), so the run degrades to a **sweep per batch**: functionally safe (sweeps are idempotent) but it erases the SC-003 dispatch-round win the tool exists to deliver.

## Root cause (verified in source)

`cockpit_await_events.ts` acquires the per-epic bus and **releases it in a `finally` after every call**; `event-bus-registry.ts:releaseKey` tears the subscription down at refcount 0 (`sub.stop(); registry.delete(key)`). The refcounted acquire/release pattern was designed for *concurrent* callers sharing one poller — but the dominant real pattern is one auto session calling *sequentially*, so between calls the refcount is 0 and the bus (monotonic cursor counter, LRU buffer, poller, snapshot state) is destroyed. The next call builds a fresh bus whose `nextCursor` restarts, and `parseCursor` classifies any prior cursor as `never-issued` (`decoded.position >= this.nextCursor`).

Two consequences, the second subtler:

1. **Every cross-call cursor is invalid** — the primary contract violation.
2. **The poller only exists while a call is in flight.** Events occurring between calls (during the session's dispatch/thinking time) are never observed by any bus; the fresh subscription's first poll establishes a new baseline snapshot. Today this is masked because the recovery sweep re-reads live state every batch — precisely the degraded mode.

## Fix

1. **Decouple bus lifetime from call lifetime.** The bus, once acquired, persists for the server-process lifetime with an idle TTL (e.g. tear down after ~10 min with no waiter and no drain, to bound resources for abandoned epics — the LRU buffer already bounds memory). `release()` may still gate concurrent bookkeeping but must never destroy the bus between sequential calls. A cursor held across the TTL eviction then classifies as the **expired/discarded** class (reset-to-head + `resetFrom` signal) — the Q3-D taxonomy already models eviction; it must not surface as `never-issued`.
2. **Instance-tag cursors.** The registry is in-memory, so a server *restart* also invalidates validly-held cursors — and today that too would classify as `never-issued`, muddying the class the playbook treats as a caller bug. Embed a per-process instance nonce in the cursor token: same instance + out-of-range → `never-issued` (genuine caller bug); different instance → `discarded` (reset + `resetFrom` signal). After this, `never-issued` is trustworthy again and the playbook's strict fail-loud posture for it becomes tenable (companion agency finding).

## Regression tests

- Two sequential `cockpit_await_events` calls: cursor from call 1 is accepted by call 2 and returns only newer events.
- Event emitted between two calls (no waiter in flight) is delivered by the second call.
- Idle-TTL eviction: a post-eviction cursor yields the reset/`resetFrom` path, not `invalid-cursor`.
- Cross-instance cursor (nonce mismatch) yields `discarded`/reset, not `never-issued`; same-instance out-of-range still yields `never-issued`.
- Registry: refcount 0 with TTL unexpired keeps the poller running (event observed while no call is in flight appears in the next batch).


## User Stories

### US1: Cursor survives across sequential await calls (P1)

**As an** auto-mode cockpit session (single sequential caller via MCP),
**I want** the cursor I received from call N to be accepted by call N+1 and return only newer events,
**So that** I get the incremental dispatch-round semantics `cockpit_await_events` was designed for — not a per-batch full-state sweep.

**Acceptance Criteria**:
- [ ] Two back-to-back `cockpit_await_events` calls with the second passing the cursor returned by the first succeed with `status !== 'error'`.
- [ ] The second call returns only events that occurred *after* the first call returned (no re-delivery of previously seen events).
- [ ] An event emitted between the two calls (while no waiter is in flight) appears in the second call's batch.

### US2: TTL eviction and process restart produce a typed reset, not a caller-bug error (P1)

**As an** auto-mode session whose held cursor is no longer valid because the bus was idle-evicted or the server restarted,
**I want** the response to say `discarded` (or the equivalent reset-to-head class, with `resetFrom` populated),
**So that** my playbook's strict fail-loud posture on `never-issued` stays trustworthy — a `never-issued` reply again means "genuine caller bug", not "server did routine housekeeping".

**Acceptance Criteria**:
- [ ] Cursor issued before an idle-TTL eviction yields the reset/`resetFrom` class, not `invalid-cursor`/`never-issued`.
- [ ] Cursor issued by a prior server instance (nonce mismatch) yields the reset/`resetFrom` class, not `never-issued`.
- [ ] Cursor with same instance nonce but position `>= nextCursor` (impossible position for this instance) still yields `never-issued`.

### US3: Idle epics don't leak resources (P2)

**As** the server process hosting many transient epics,
**I want** the bus for an epic with no waiter and no drain activity to be torn down after an idle TTL,
**So that** abandoned epics don't accumulate pollers and LRU buffers indefinitely.

**Acceptance Criteria**:
- [ ] Bus with refcount 0 and no waiter/drain activity is torn down after the configured idle TTL.
- [ ] Bus with refcount 0 but still within TTL keeps its poller running (event emitted while no call is in flight is delivered by the next call).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Bus lifetime is decoupled from call lifetime: `release()` at refcount 0 MUST NOT immediately tear down subscription, cursor counter, LRU buffer, or poller. | P1 | Root fix for cross-call cursor validity. |
| FR-002 | An acquired bus persists until an idle TTL expires (no waiter and no drain activity for the configured window). | P1 | Default TTL: ~10 min (tunable). |
| FR-003 | While the bus is alive, its monotonic cursor counter, LRU event buffer, poller, and snapshot state are preserved across calls. | P1 | Required for FR-008 "same cursor returns the same tail" contract. |
| FR-004 | Cursor tokens embed a per-process instance nonce generated once at server start. | P1 | Enables the cross-instance discrimination in FR-005/FR-006. |
| FR-005 | Cursors presented with a matching instance nonce and position >= `nextCursor` classify as `never-issued`. | P1 | Preserves the caller-bug signal the playbook relies on. |
| FR-006 | Cursors presented with a non-matching instance nonce classify as `discarded` (or equivalent reset class), with the response carrying a reset-to-head signal (`resetFrom` or equivalent). | P1 | Covers server-restart case. |
| FR-007 | Cursors presented after their bus was idle-TTL-evicted classify as `discarded`/reset with `resetFrom`, not as `never-issued`. | P1 | Covers TTL-eviction case. Reuses the existing Q3-D eviction taxonomy. |
| FR-008 | Two sequential `cockpit_await_events` calls, where the second reuses the first's returned cursor, MUST return only events newer than the first call's tail. | P1 | Contract restoration — this is FR-008 from the original tool spec being made to hold again. |
| FR-009 | Concurrent-caller acquire/release bookkeeping continues to work correctly (multiple concurrent callers still share one bus/poller). | P2 | Regression guard — the original design goal for the refcount pattern still holds. |
| FR-010 | The idle-TTL window and the instance-nonce format are internal implementation details, not part of the public MCP tool contract. | P3 | Callers only observe the class discrimination via response `class`/`resetFrom`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cross-call cursor acceptance rate in a single auto session | 100% of same-instance, in-window cursors accepted (no `invalid-cursor` for the sequential-caller pattern) | Run auto session against a snappoll-style epic; count `invalid-cursor` responses across N sequential `cockpit_await_events` calls; expect 0. |
| SC-002 | Dispatch-round win restored | Second and subsequent calls deliver only newer events (no per-batch startup-sweep degradation) | Compare batch payloads across calls; assert absence of re-delivered events; assert absence of the "recovery sweep every batch" pattern in session logs. |
| SC-003 | Between-call event delivery | 100% of events emitted while no waiter is in flight are delivered by the next call | Regression test: emit event between calls, assert it appears in the next batch. |
| SC-004 | `never-issued` becomes a trustworthy caller-bug signal | 0 false-positive `never-issued` responses caused by TTL eviction or server restart | Regression tests for TTL eviction and cross-instance cursors both yield `discarded`/reset, not `never-issued`. |
| SC-005 | Idle-epic resource bound | Bus resources released within one idle-TTL window after last waiter/drain | Regression test: after last call + idle TTL, `registry.has(key) === false` and poller stopped. |

## Assumptions

- The dominant real-world caller pattern is a single auto-mode session calling `cockpit_await_events` sequentially, not multiple concurrent callers. The refcounted acquire/release pattern was correct for the latter; the fix must not break it while making the former work.
- The existing `parseCursor` classification taxonomy already models an "expired/discarded" (reset-to-head + `resetFrom`) class distinct from `never-issued` (Q3-D taxonomy noted in the source). Instance-nonce and TTL-eviction paths route into that existing class rather than a new class.
- LRU buffer bounds already exist and bound memory per bus, so an idle-TTL of ~10 min is a resource-safety upper bound, not a correctness requirement.
- The MCP server's process lifetime is the natural upper bound on cursor validity; process restart is expected to reset held cursors (via the `discarded` class, not `never-issued`).
- The companion playbook-side circuit breaker (agency finding) will land alongside so that `never-issued` becomes fail-loud again once this fix makes the class trustworthy.

## Out of Scope

- Persisting bus state or cursors across server restarts (restart is a `discarded` event by design).
- Cross-process/cross-instance cursor portability.
- Changing the MCP tool's public request/response schema beyond what's necessary to preserve the existing class/`resetFrom` discrimination.
- Playbook-side changes to how `cockpit_await_events` failures are handled (companion agency finding).
- Tuning-UI for the idle TTL (internal constant / env-var only for v1).
- Instrumentation/observability for bus lifetime beyond structured logs sufficient for the regression tests.

---

*Generated by speckit*
