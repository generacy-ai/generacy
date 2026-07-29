---
"@generacy-ai/orchestrator": patch
---

Periodic `RedisQueueAdapter.reconcileInFlight()` closes the residue-in-SET
gap from #1054 finding 6 (#1058).

`reapOrphanClaims` (PR #1056, `RECLAIM_ORPHAN_SCRIPT`) is candidate-set-
driven by `orchestrator:queue:claimed:*` keys — it cannot see an itemKey
that lives in `orchestrator:queue:in-flight-items` **without** a matching
claim-hash entry (Redis eviction, a future refactor that `HDEL`s without
a paired `SREM`, or out-of-band operator action). Every subsequent
`enqueueIfAbsent()` for that issue is then silently dropped by
`ENQUEUE_IF_ABSENT_SCRIPT`'s `SISMEMBER` guard and no code path
un-wedges it.

Fix adds `reconcileInFlight` as a periodic sweep on the dispatcher's
reaper cadence (immediately after `reapOrphanClaims`, plus one boot
sweep at process start). Detection is client-side: `SSCAN
IN_FLIGHT_KEY`, `ZRANGE PENDING_KEY 0 -1` + parse, `SCAN
CLAIMED_KEY_PREFIX*` + `HKEYS` per hash, in-memory set-difference.
Action is two-sweep-gated: a residue candidate must be observed as
residue in two consecutive sweeps before removal (in-memory tracker
Map). Confirmed candidates go through a minimal single-key
`RECONCILE_IN_FLIGHT_SCRIPT` (`SISMEMBER` + `SREM`, `numberOfKeys: 1`
— CROSSSLOT-safe under Redis Cluster) that atomically re-checks against
a concurrent `enqueueIfAbsent`/`enqueue` re-add. Composes with
#1054/PR #1056 (`RECLAIM_ORPHAN_SCRIPT`) and #1060/PR #1065
(`ENQUEUE_IF_ABSENT_SCRIPT` co-atomicity) — additive, no changes to
existing scripts. `QueueManager.reconcileInFlight` is an internal
contract; `InMemoryQueueAdapter` implements it as a no-op (in-memory
`pending`, `claimed`, and `inFlightSet` cannot diverge by
construction).
