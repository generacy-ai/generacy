---
"@generacy-ai/orchestrator": patch
---

workflow:speckit-bugfix

Reclaim orphaned queue claims when the owning worker dies without unwinding;
escalate wedged-in-flight drop logs to `warn` on the transition edge (#1054).

`RedisQueueAdapter` gains `reapOrphanClaims()` — a Lua-atomic sweep over
`orchestrator:queue:claimed:*` that reclaims claims whose owning worker's
heartbeat key is absent (SIGKILL / OOM / dispatcher-replica-replace).
Reclaimed items are re-queued with `queueReason: 'resume'`, `attemptCount++`,
and a per-reclaim `warn` line carrying both pre- and post-increment counters
so infra-caused increments stay distinguishable from execution-failure
increments in log queries. The reclaim is race-safe via a server-side
`EXISTS heartbeat` re-check inside the script (US2) and grace-window guard
(FR-005). `WorkerDispatcher.reaperLoop` invokes it sequentially after the
existing in-memory `reapStaleWorkers` on the same cadence.

A new shared `drop-log-helper.ts` (pure function) escalates the four
"Dropping ... enqueue (item already in flight)" sites plus the two
`enqueueIfAbsent` adapter sites from silent `info` to a single `warn` on the
transition edge when a wedged in-flight entry's age crosses the new
`DispatchConfig.maxRunDurationMs` threshold (default 30 min). No repeat
`warn`s between edges — a wedge produces exactly one `warn` line on entry
plus one from the reap sweep, then subsequent drops for the same wedged
itemKey fall back to `info`.

Reproduces the exact wedge from `generacy-ai/generacy#1051` (worker died
mid-claim → item stranded 84 minutes with 17 identical `info`-level drop
lines) as a regression test.
