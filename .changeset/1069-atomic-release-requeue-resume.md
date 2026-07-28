---
"@generacy-ai/orchestrator": patch
---

Atomic `RedisQueueAdapter.release()` and `.requeueForResume()` re-pend
(#1069).

Both methods previously performed the read-and-mutate as two Redis
round trips (`HGET` claim → client-side `MULTI: HDEL + DEL + ZADD`),
leaving a few-millisecond window in which `RECLAIM_ORPHAN_SCRIPT`
could interleave, `HDEL` the claim, and `ZADD` its own re-pend
payload. The subsequent client `MULTI` then fired with a no-op `HDEL`
but its `ZADD` still added a **second distinct pending member** (Redis
ZSETs key on the full member string), producing two concurrent worker
claims — the exact failure sequence #1060/PR #1065 closed for
`enqueue()`, arriving via `release()` / `requeueForResume()` instead.

Fix folds both into single Lua scripts (`REQUEUE_FOR_RESUME_SCRIPT`
and `RELEASE_SCRIPT`), mirroring `RECLAIM_ORPHAN_SCRIPT`'s pattern.
`release()`'s dead-letter branch is folded into the same script so
SC-004's "exactly 1 round trip" invariant holds on both retry and
dead-letter paths. `attemptCount` is read + mutated inside Lua via
`cjson.decode`/`encode` so passing it as ARGV cannot reintroduce the
TOCTOU hazard. Scripts return `{code, attemptCount}` tuples so the
existing `logger.info` "attempt N of maxRetries" diagnostic is
preserved. Public `QueueManager` interface unchanged (both methods
retain `Promise<void>` return contract — SC-008 / FR-008).
