# Feature Specification: Found during the cockpit v1

**Branch**: `924-found-during-cockpit-v1` | **Date**: 2026-07-12 | **Status**: Draft

## Summary

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

### US1: Sequential auto-session cursor reuse

**As a** cockpit auto-mode session driving one epic through `cockpit_await_events`,
**I want** the cursor returned by batch N to be accepted by batch N+1,
**So that** each subsequent call returns only newer events and the SC-003 dispatch-round win the tool exists to deliver is not erased by a per-batch recovery sweep.

**Acceptance Criteria**:
- [ ] Two sequential `cockpit_await_events` calls: cursor from call 1 is accepted by call 2 and returns only newer events (no `invalid-cursor`).
- [ ] An event emitted between two calls (no waiter in flight) is delivered by the second call.

### US2: Correct cursor-lifetime classification across TTL eviction and process restart

**As a** downstream caller (playbook, agency circuit breaker) that treats `never-issued` as a fail-loud caller bug,
**I want** cursors invalidated by TTL eviction OR by server restart to classify as `discarded` (with `resetFrom`) rather than `never-issued`,
**So that** routine lifecycle events do not trip strict fail-loud paths and `never-issued` remains a trustworthy caller-bug signal.

**Acceptance Criteria**:
- [ ] Idle-TTL eviction: a post-eviction cursor yields the reset/`resetFrom` path, not `invalid-cursor`.
- [ ] Cross-instance cursor (nonce mismatch) yields `discarded`/reset, not `never-issued`.
- [ ] Same-instance out-of-range cursor still yields `never-issued` (genuine caller bug preserved).
- [ ] Legacy (no-nonce) cursor tokens classify as `discarded`/reset with `resetFrom` on the first post-deploy call.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The per-epic event bus MUST persist for the server-process lifetime once acquired, decoupled from individual `cockpit_await_events` call lifetimes. `release()` at refcount 0 MUST NOT destroy the bus, its monotonic cursor counter, LRU buffer, or snapshot state. | P1 | Root cause of the observed bug. |
| FR-002 | The bus registry MUST evict a bus after a configurable idle-TTL window with no callers. Default: 600_000 ms (10 min), configurable via env var `COCKPIT_MCP_BUS_IDLE_TTL_MS`. Matches the existing `COCKPIT_MCP_EVENT_RETENTION_*` pattern. | P1 | Clarified Q1-A. |
| FR-003 | The idle-TTL clock MUST arm at `release()`-to-refcount-0 and disarm on `acquire()`. Poller `emit()` and internal `waitFor` invocations MUST NOT reset the clock. Invariant: a bus is alive iff refcount > 0 or its armed clock is younger than the TTL. | P1 | Clarified Q2-D. Prevents busy-but-abandoned-epic leaks. |
| FR-004 | The per-epic poller MUST pause when the bus is at refcount 0. On the next `acquire()`, the bus MUST perform a one-shot catch-up poll that diffs against the last-known snapshot, capturing every change that occurred while no caller was listening. Full-rate polling resumes whenever a waiter is in flight. | P1 | Clarified Q4-D. The bus retains its snapshot map across the gap. |
| FR-005 | Cursor tokens MUST embed a per-process instance nonce. Cursor classification MUST become: (a) same-instance + in-range → valid; (b) same-instance + out-of-range → `never-issued` (genuine caller bug); (c) different-instance → `discarded` with `resetFrom` (server restart or TTL eviction). | P1 | Restores `never-issued` as a trustworthy caller-bug class. |
| FR-006 | Legacy cursor tokens (issued before the nonce change, no `nonce` field on decode) MUST classify as `discarded` with `resetFrom`, not as `never-issued` or `malformed`. Callers experience a one-time silent reset on their first post-deploy call. | P1 | Clarified Q3-A. Prevents upgrade artifacts from tripping agency#408 circuit breaker. |
| FR-007 | The bus registry MUST enforce a soft cap on concurrent live buses. Default: 100, configurable via env var (e.g. `COCKPIT_MCP_BUS_MAX`). On new `acquire()` at cap, the least-recently-active bus MUST be evicted. Evicted-bus cursors MUST classify as `discarded` (same taxonomy as TTL eviction), so eviction is non-silent by construction. | P2 | Clarified Q5-B. Bounded-by-default; no hard fail on new epic. |
| FR-008 | `cockpit_await_events` MUST honor the contract "passing the same cursor returns the same tail" across sequential calls within the same server-process instance and within the idle-TTL window. | P1 | Restored core contract. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Sequential-cursor acceptance rate in auto-mode runs | 100% (no `invalid-cursor` for cursor from prior call within same instance + TTL) | Integration test: two sequential `cockpit_await_events` calls, cursor N accepted by call N+1. |
| SC-002 | Between-call event delivery (no in-flight waiter) | 100% (event emitted between calls appears in next batch) | Regression test asserts event delivery through the catch-up poll path. |
| SC-003 | Dispatch-round efficiency in auto sessions | Sweeps no longer required per batch (revert of the "sweep per batch" degradation observed in snappoll-1 run 8) | Auto-session smoke test: batch count of recovery sweeps drops to at most one per session (startup only). |
| SC-004 | Cursor classification correctness | 0 misclassifications of TTL-evicted / cross-instance / legacy cursors as `never-issued` | Regression test matrix covers all three cases; agency#408 circuit breaker does not trip on routine lifecycle events. |

## Assumptions

- The MCP server is a single in-memory process; no cross-process cursor sharing is required. Cursor nonces are per-process instance identifiers, not global.
- The existing LRU event buffer bounds memory per bus; the idle-TTL and soft cap bound the number of live buses.
- The 30 s poller cadence and `COCKPIT_MCP_EVENT_RETENTION_*` env-var idiom are the correct references for new tunables.

## Out of Scope

- Persistent (on-disk) cursors surviving across server restarts. Cross-instance cursors remain `discarded`; durable subscription is not in this bugfix.
- Playbook / agency-side circuit-breaker changes. Companion agency finding covers that side; this spec restores the classification the playbook relies on.
- Changes to the `cockpit_await_events` public wire shape beyond the added nonce field in the cursor token payload.

---

*Generated by speckit*
