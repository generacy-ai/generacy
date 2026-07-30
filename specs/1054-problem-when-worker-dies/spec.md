# Feature Specification: Orphaned queue claims must be reclaimed after a worker dies without unwinding

**Branch**: `1054-problem-when-worker-dies` | **Date**: 2026-07-27 | **Status**: Draft | **Issue**: [#1054](https://github.com/generacy-ai/generacy/issues/1054)

## Summary

`WorkerDispatcher.reapStaleWorkers` (`packages/orchestrator/src/services/worker-dispatcher.ts:578`) iterates the in-memory `activeWorkers: Map<workerId, WorkerInfo>` and per-entry checks whether the worker's Redis heartbeat still exists. When a *worker process* dies mid-claim (SIGKILL, container OOM, node crash) — or the dispatcher process itself dies and is replaced by a fresh replica — the `activeWorkers` Map on the surviving dispatcher never contained that entry. The heartbeat expires (`heartbeatTtlMs` default 30s) and vanishes silently, but the Redis claim hash (`orchestrator:queue:claimed:<workerId>`) has `ttl = -1` and the item stays in `orchestrator:queue:in-flight-items` forever. Every subsequent `enqueueIfAbsent` for the same `<owner>/<repo>#<issue>` returns `false` at the `SISMEMBER` gate in `ENQUEUE_IF_ABSENT_SCRIPT` (`redis-queue-adapter.ts:22`), and the item is permanently wedged. Observed live: `generacy-ai/generacy#1051` sat blocked for 84 minutes with the PR-feedback monitor firing every ~5 minutes and every enqueue dropped. The fix must (a) reclaim claims whose owning worker's heartbeat is *absent* (not merely stale), (b) make the drop observable when it happens, and (c) not introduce a race that reclaims a claim held by a live worker whose heartbeat happens to blip between the check and the reclaim write.

## Problem

Three architectural facts combine to produce a permanent liveness hole:

1. **Reap is driven by in-memory state, not Redis state.** `reapStaleWorkers` at `worker-dispatcher.ts:578-614` iterates `this.activeWorkers` (an in-memory `Map` on the dispatcher instance). If the worker process died, or if the *dispatcher* died and a fresh dispatcher replica took over, `activeWorkers` on the surviving/new dispatcher never had the dead worker's entry. There is nothing to iterate, so no `isHeartbeatAlive` check ever fires against the orphaned claim.

2. **The claim hash has no TTL.** `CLAIM_SCRIPT` in `redis-queue-adapter.ts:41-52` runs `HSET claimed <itemKey> <member>` — no `EXPIRE`. `redis-cli TTL orchestrator:queue:claimed:<workerId>` returns `-1`. The heartbeat key expires after 30s; the claim hash lives forever. There is no Redis-native mechanism that will ever remove it.

3. **The in-flight SET is only cleaned on `complete()` or dead-letter.** `SREM IN_FLIGHT_KEY itemKey` happens in three places (`redis-queue-adapter.ts:262, 307`) — all inside `release()`'s dead-letter branch or `complete()`. Both require a live worker calling into the adapter on shutdown. A killed process never reaches either.

4. **Every drop looks identical.** `RedisQueueAdapter.enqueueIfAbsent` (`redis-queue-adapter.ts:141-144`) and the four monitor sites (`pr-feedback-monitor-service.ts:428`, `merge-conflict-monitor-service.ts:186`, `clarification-answer-monitor-service.ts:240`, `label-monitor-service.ts:361`) all log `'Dropping enqueue (item already in flight)'` at `info`. The steady-state healthy dedup case (a live worker is processing the item; a second monitor tick correctly declines to double-enqueue) is indistinguishable from the wedge case (no worker has touched this item in 84 minutes). An operator scanning logs sees the same line either way.

Trigger sequence from the observed incident (`generacy-ai/generacy#1051`, 2026-07-27, tetrad-development cluster):

- 18:53 — PR-feedback fixer runs against #1051, hits the 20-minute CLI timeout (`exit 143`), pushes partial work, sets `blocked:stuck-feedback-loop`.
- 19:17:18 — A follow-up item is claimed by worker `177e2263-5ea7-4e84-83a5-eec6b46a7c12` (workflow re-entered on unblock).
- Between 19:17:18 and ~19:18 — Something kills worker `177e2263` before it can `release()` or `complete()`. The dispatcher's `stop()` unwind (`worker-dispatcher.ts:152-165`) which would have called `release()` did not run — evidence: the claim hash still exists at investigation time. Root cause of the kill is not in scope (out-of-memory, container replacement, dispatcher process replacement — all produce the same wedge shape).
- 19:17:48 (~30s after claim) — Heartbeat key `orchestrator:worker:177e2263:heartbeat` TTL reaches zero, key is evicted.
- 19:17 → 20:41 — Every ~5 min, PR-feedback monitor detects unresolved threads on PR #1052, calls `enqueueIfAbsent`, `SISMEMBER orchestrator:queue:in-flight-items generacy-ai/generacy#1051` returns 1, drop. Same log line each cycle at `info`.
- 20:41 — Manual `DEL orchestrator:queue:claimed:177e2263...` + `SREM orchestrator:queue:in-flight-items generacy-ai/generacy#1051` released the wedge; the next monitor tick enqueued successfully.

Total silent stall: 84 minutes. No `warn`. No `error`. No SSE event. No cloud alert.

## Evidence

Redis state at investigation time (from issue body):

```
orchestrator:queue:in-flight-items  →  { "generacy-ai/generacy#1051" }

orchestrator:queue:claimed:177e2263-5ea7-4e84-83a5-eec6b46a7c12   (hash, ttl = -1)
  generacy-ai/generacy#1051
  { "command": "address-pr-feedback",
    "queueReason": "resume",
    "enqueuedAt": "2026-07-27T19:17:18.772Z",
    "attemptCount": 0,
    "metadata": { "prNumber": 1052, "reviewThreadIds": [3660221572, 3660221578] } }

$ redis-cli EXISTS orchestrator:worker:177e2263-5ea7-4e84-83a5-eec6b46a7c12:heartbeat
0
```

Live-worker control set (same cluster, same instant):

```
orchestrator:worker:2c0edd5d-...:heartbeat  ttl=48
orchestrator:worker:f2b0271b-...:heartbeat  ttl=36
orchestrator:worker:302716c1-...:heartbeat  ttl=31
```

All three currently-running items had healthy heartbeats, so the reap path *does* work for the subset it can see — it just can't see this one because `activeWorkers` doesn't contain worker `177e2263`.

Repeating log signature (every ~5 min for 84 min):

```
Processing PR review event from poll        prNumber=1052
Linked PR #1052 to issue #1051 via pr-body
Found 2 unresolved review thread(s)
Dropping enqueue (item already in flight)   itemKey=generacy-ai/generacy#1051  reason=in-flight
Dropping PR-feedback enqueue (item already in flight)
```

Ruled out (verified against source):

- **Not a race with `handleLeaseExpired`** (`worker-dispatcher.ts:234-278`) — it also keys off in-memory `workerLeases` + `activeWorkers` and has the same blind spot.
- **Not a race with dispatcher `stop()`** (`worker-dispatcher.ts:152-165`) — its release loop iterates `activeWorkers` too.
- **Not a `blocked:*` interaction** — the `blocked:stuck-feedback-loop` label from the prior timeout doesn't affect `enqueueIfAbsent`; the drop is at the Redis SET check.
- **Not a duplicate enqueue race** — `enqueueIfAbsent` is atomic Lua; the drop is correct code behaviour given the corrupt state, not a bug in the adapter.

## User Stories

### US1: Killed-worker orphans are auto-reclaimed within one reaper cycle

**As** an operator running the orchestrator cluster,
**I want** claims whose owning worker no longer has a live heartbeat to be reclaimed and re-enqueued automatically,
**So that** an item is never permanently locked out of the queue by a worker that died without unwinding.

**Acceptance Criteria**:
- [ ] A claim key `orchestrator:queue:claimed:<workerId>` whose corresponding heartbeat key `orchestrator:worker:<workerId>:heartbeat` does not exist (`EXISTS = 0`) is reclaimed by the next reaper cycle: the claim hash is deleted, the itemKey is removed from `orchestrator:queue:in-flight-items`, and the item is re-enqueued with `queueReason: 'resume'` (priority 0) so the next dispatch picks it up ahead of new work.
- [ ] Reclaim works when the heartbeat key is **fully evicted** (not just stale) — the reaper does not require the heartbeat key to exist to detect the orphan.
- [ ] Reclaim works when the *dispatcher* that originally issued the claim is gone — the surviving/replacement dispatcher's reaper still finds the orphan by iterating Redis, not its own in-memory `activeWorkers` Map.
- [ ] Existing in-memory reap for workers *this* dispatcher owns continues to work unchanged (backward compatibility with `reapStaleWorkers`).

### US2: Live-worker claims are never reclaimed by mistake

**As** the reaper,
**I want** to only reclaim claims whose worker is definitively dead,
**So that** a healthy worker whose heartbeat happened to blip (Redis restart, brief network partition, GC pause exceeding the check window) is not stripped of its claim mid-run — which would cause double-execution.

**Acceptance Criteria**:
- [ ] A claim whose heartbeat key exists at the moment of the reclaim decision (`EXISTS = 1`) is NOT reclaimed, regardless of TTL remaining.
- [ ] The check-then-reclaim sequence is race-safe against a worker whose heartbeat is refreshed *between* the check and the reclaim write — the reclaim write must not blindly delete a claim whose heartbeat has re-appeared.
- [ ] Reclaim does not fire on a claim newly issued in the current second — a grace window prevents a race where the claim hash lands before the heartbeat SET completes (both are atomic within `CLAIM_SCRIPT` today, but robust to future changes).
- [ ] Under no scenario does the reaper produce a state where the same itemKey is simultaneously in `orchestrator:queue:in-flight-items` AND being processed by no worker AND not in `orchestrator:queue:pending`.

### US3: Wedge cases are visible before they compound

**As** an operator diagnosing "the fixer stopped working",
**I want** a wedged in-flight item to escalate its log level so I can see the stall without reading Redis by hand,
**So that** an 84-minute silent stall becomes a `warn` line I can see in log queries and alerting.

**Acceptance Criteria**:
- [ ] When `enqueueIfAbsent` drops an item because it is already in-flight, the log line's severity is conditional on the age of the in-flight entry: at `info` when the entry is younger than `maxRunDurationMs` (default 30 min, see FR-012), and at `warn` when it has exceeded it. The "age" is derived from the claim hash's `enqueuedAt` field (which is present on every `SerializedQueueItem`).
- [ ] The `warn` line fires on the **transition edge** only — the first cycle after the entry crosses the threshold, and the first cycle after the entry clears (drops back below or is reclaimed). Between transitions the line stays at `info`; a stuck wedge does not emit repeated identical `warn`s per monitor cycle. Reuses the `isTransition`/`lastUnresolvedThreadCount` shape from `pr-feedback-monitor-service.ts`.
- [ ] The escalated `warn` line names the itemKey and the age in a machine-parseable field (e.g. `{ itemKey, ageMs }`).
- [ ] The escalation fires *even if* the reaper has not yet run — the two mechanisms are independent; the log is the observer, the reaper is the fixer. An operator gets a `warn` on the first monitor cycle after the threshold, not only after a subsequent reap sweep completes.
- [ ] The four monitor-side "Dropping ... enqueue (item already in flight)" sites (PR-feedback, merge-conflict, clarification-answer, label-resume) inherit the same escalation via a shared helper. Divergence between the adapter-level drop and the monitor-side context line — either in severity or in transition edge — is a regression.
- [ ] The in-memory adapter's drop log applies the identical transition-edge escalation via the same shared helper (see FR-011). The reclaim sweep itself is a Redis-only concern.

### US4: The regression test that would have caught this ships with the fix

**As** a future engineer touching the queue adapter or dispatcher,
**I want** a test that reproduces the exact wedge shape,
**So that** any refactor that reintroduces the liveness hole fails CI, not production.

**Acceptance Criteria**:
- [ ] A regression test claims an item under a synthetic `workerId`, deletes the heartbeat key directly (simulating a killed worker), runs the reaper sweep once, and asserts: (a) the claim hash is gone, (b) the itemKey is removed from `orchestrator:queue:in-flight-items`, (c) the item is back in `orchestrator:queue:pending` with `queueReason: 'resume'`, (d) a subsequent `enqueueIfAbsent` for the same itemKey succeeds.
- [ ] A second test asserts the negative: a claim whose heartbeat exists (any TTL > 0) survives the sweep unchanged.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The reaper must sweep from the claims side of Redis, not from the dispatcher's in-memory `activeWorkers` Map. It must iterate `orchestrator:queue:claimed:*` (via `SCAN`, not `KEYS`), and for each `<workerId>` check whether `orchestrator:worker:<workerId>:heartbeat` exists. Absent heartbeat → reclaim. | P1 | Direct inversion of the current dependency, per the issue's proposed fix #1. Fixes the fundamental liveness hole — a wedge that survives even a full dispatcher restart. |
| FR-002 | On reclaim, the reaper must (a) `SREM orchestrator:queue:in-flight-items <itemKey>`, (b) re-enqueue the item to `orchestrator:queue:pending` with `queueReason: 'resume'` and its original `enqueuedAt` and `metadata` preserved from the claim hash payload — but with `attemptCount` **incremented by one** (see clarifications Q3=C); the reaper does NOT gate on `attemptCount >= maxAttempts` and never dead-letters — dead-lettering remains solely a `release()`-path behaviour, (c) `HDEL orchestrator:queue:claimed:<workerId> <itemKey>` and `DEL orchestrator:queue:claimed:<workerId>` if the hash is now empty. Steps (a) + (b) + the HDEL/DEL must be co-atomic in a single Lua script invocation (see FR-004) so a concurrent live-worker `complete()` cannot race the reclaim into a double-enqueue. | P1 | Preserves resume-priority semantics used by `handleLeaseExpired` (`worker-dispatcher.ts:267-273`). Atomicity is load-bearing — the reclaim must not be observable as "not-in-flight AND not-in-pending" for any window. The increment-without-gate pattern keeps a pathological OOM-triggering item diagnosable via the counter without letting routine cluster restarts steadily dead-letter blameless items (the observed incident was a cluster restart mid-claim, not an item defect). |
| FR-003 | The reap-from-claims sweep must run on a bounded cadence — either as an extension of the existing `reaperLoop` (`worker-dispatcher.ts:564`, cadence `heartbeatCheckIntervalMs` default 15s) or as a sibling loop with the same cadence. It must run on every dispatcher replica, not only on a designated leader (the issue observes that even a single dispatcher can wedge itself if a *worker* dies without unwinding). | P1 | Reusing `heartbeatCheckIntervalMs` keeps the tuning knob single-sourced. Sibling-loop vs. extension is an implementation detail deferred to `/plan`. |
| FR-004 | The reclaim must be implemented as a new Lua script `RECLAIM_ORPHAN_SCRIPT` (see clarifications Q2=A) invoked via `EVAL`/`EVALSHA` alongside the existing `CLAIM_SCRIPT`/`RELEASE_SCRIPT`/`ENQUEUE_IF_ABSENT_SCRIPT` pattern. The script itself must (a) `EXISTS orchestrator:worker:<workerId>:heartbeat` — if 1, return abort code without mutating state; (b) apply the FR-005 grace-window `now`-vs-`enqueuedAt` guard — if within grace, return abort code without mutating state; (c) perform the FR-002 write sequence in a single script body. Lua execution is atomic on the Redis server, so no `WATCH`/`MULTI` is needed and no additional round-trip guard is required — the initial iteration-side `EXISTS` filter (per FR-001) plus the script-internal `EXISTS` re-check together satisfy US2 race safety. | P1 | US2 race safety via server-side atomic re-check. Matches the codebase's established Lua-script pattern rather than introducing `MULTI`/`WATCH`. |
| FR-005 | The `RECLAIM_ORPHAN_SCRIPT` (FR-004) must NOT reclaim claims whose claim-hash `enqueuedAt` timestamp is within a grace window (default: 2 × `heartbeatCheckIntervalMs`, i.e. 30s at defaults) of `now`. The check is embedded inside the Lua body via a `now`-vs-`enqueuedAt` comparison; `now` is passed in as an `ARGV` argument (Lua on Redis does not expose wall-clock time). This defends against a race where a worker has just claimed but not yet completed its initial `SET heartbeat` (impossible under `CLAIM_SCRIPT`'s current atomicity, but robust against future refactors that split the two operations). | P2 | Cheap defensive check; costs nothing at steady state. |
| FR-006 | `RedisQueueAdapter.enqueueIfAbsent`'s drop-log line (`redis-queue-adapter.ts:141-144`) must escalate to `warn` on the **transition edge** when the age of the in-flight entry first exceeds `maxRunDurationMs` (see FR-012), and again on the transition edge when the entry clears (drops back below the threshold or is reclaimed). Between transitions the line stays at `info` regardless of how many monitor cycles fire — a stuck 84-minute wedge must not emit 17 identical `warn` lines. The transition tracking pattern must reuse the `isTransition`/`lastUnresolvedThreadCount` shape already established in `pr-feedback-monitor-service.ts` (see clarifications Q4=A addition). The age must be read from the claim hash's `enqueuedAt` field (an existing field on `SerializedQueueItem`). Single-tier severity — `warn` only, no `error` tier. | P1 | US3. The log escalation is the operator-facing surface — an operator paging on `warn`s sees this bug in the first cycle past the threshold, not by re-reading Redis by hand. Transition-edge emission (not per-cycle) is what makes the signal actually visible in log queries; the observed 17-line repetition is itself the anti-pattern that hid the stall. Independent of FR-001–FR-005 (the reclaim fixes the state; this makes the intermediate window audible). |
| FR-007 | The four monitor-side "Dropping … enqueue (item already in flight)" context lines (`pr-feedback-monitor-service.ts:428`, `merge-conflict-monitor-service.ts:186`, `clarification-answer-monitor-service.ts:240`, `label-monitor-service.ts:361`) must escalate to `warn` on the same transition-edge rule as FR-006, at the same threshold. The two-log-lines-per-drop pattern is preserved — the second (monitor-side) line adds context (`prNumber`, `phase`, etc.) that the adapter doesn't have. The transition-tracking state must be shared with FR-006 (via a shared helper) so the adapter-side and monitor-side lines transition in lock-step; divergent transition edges would produce a `warn` from one and an `info` from the other for the same drop. | P1 | Preserves the pattern the codebase already established (adapter emits generic drop; monitor emits context-rich drop). Divergent severity between the two would confuse alerting. |
| FR-008 | The reclaim must emit a `warn`-level log line naming the workerId, the itemKey, the age of the claim, and the reason (`orphaned-claim-no-heartbeat`). This fires **once per orphan reclaim event** (not gated by transition-edge tracking — the reclaim itself is inherently one-shot). Single-tier severity — `warn` only, no `error` tier. This is the operator-facing evidence that the fix fired — distinct from FR-006's drop-side warn. Include the pre-increment and post-increment `attemptCount` in the log payload so infrastructure-caused increments (per FR-002) stay distinguishable from execution-failure increments. | P2 | Complements the in-memory reap's existing `worker-dispatcher.ts:583-586` warn. Makes the two paths differentiable in log queries. |
| FR-009 | A dedicated regression test (`packages/orchestrator/src/services/__tests__/redis-queue-adapter.orphan-reclaim.test.ts` or the natural sibling of `redis-queue-adapter.enqueueIfAbsent.test.ts`) must reproduce the wedge and verify the fix per US4's acceptance criteria. The test must use a real Redis (existing test infrastructure already spins one up for `redis-queue-adapter.*.test.ts`) — a mocked SET/HASH would not catch a mis-issued `SREM`/`HDEL` command shape. | P1 | Test-only change per CLAUDE.md; exempt from the changeset gate but load-bearing for the acceptance criteria. |
| FR-010 | Zero change to `CLAIM_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, `release()`, `complete()`, or the `handleLeaseExpired` path in `worker-dispatcher.ts`. The fix must add a *new* reclaim path alongside the existing ones, not modify them. | P1 | Bounds blast radius — the existing paths are load-bearing for the normal happy path, and modifying them risks new races. The new path is additive. |
| FR-011 | The fix must work with both Redis (`RedisQueueAdapter`) and in-memory (`InMemoryQueueAdapter`) queue adapters. The in-memory adapter has an equivalent shape (its own drop log at `in-memory-queue-adapter.ts:89`) — its reclaim path is a no-op (in-memory process death is total; no orphan can survive), but the FR-006/FR-007 log escalation must apply uniformly via a **shared helper** so a test written against either adapter observes the same signal (see clarifications Q5=C). No `reapOrphanClaims`-equivalent method on the in-memory adapter. | P2 | The two adapters share the `QueueManager` interface; keeping log-signal parity is testable behaviour, not an operational concern (prod runs Redis). |
| FR-012 | The age-escalation threshold used by FR-006/FR-007 is a new field `maxRunDurationMs` on `DispatchConfigSchema` with default `1_800_000` (30 min), per clarifications Q1=A. Rationale for 30 min (over 20 min, which is the CLI timeout): legitimate post-timeout work runs past the CLI timeout — partial push, label updates, disposition handling — so 20 min would produce `warn`s on healthy runs; 30 min still catches the observed 84-minute wedge almost immediately. Operators with legitimately longer runs can raise the knob without a redeploy. | P2 | The one-knob-fits-all threshold is a rough heuristic; further tuning is out of scope for this fix. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Wedged in-flight items surviving the maximum plausible run duration | 0 | Test: after `maxRunDurationMs + heartbeatCheckIntervalMs`, an item claimed by a worker whose heartbeat was deleted directly (simulating a killed worker) is no longer in `orchestrator:queue:in-flight-items`, and a subsequent `enqueueIfAbsent` for the same itemKey succeeds. Reproduces the incident on `generacy-ai/generacy#1051`. |
| SC-002 | Live workers spuriously reclaimed | 0 | Test: 100 concurrent live workers each holding a claim with an actively refreshing heartbeat run through the reaper for a full `heartbeatCheckIntervalMs` cycle; assert zero reclaims fired. |
| SC-003 | Silent (`info`-only) drops of in-flight items older than the max run duration | 0 | Test: force an in-flight item to age past the threshold, trigger a monitor tick that would enqueue, assert the drop log line is emitted at `warn` (or higher) at both the adapter and the monitor sites, and contains `itemKey` + `ageMs` fields. |
| SC-004 | Log-line severity divergence between adapter-level drop and monitor-side drop | 0 | Test: for each of the four monitor sites (PR-feedback, merge-conflict, clarification-answer, label-resume), force a drop past threshold and assert both the adapter's `Dropping enqueue …` and the monitor's `Dropping <surface> enqueue …` fire at the same severity. |
| SC-005 | Time between worker-death and item availability for re-claim | ≤ 2 × `heartbeatCheckIntervalMs` | Test: measure the interval between deleting the heartbeat key and observing the itemKey re-appear in `orchestrator:queue:pending`. At defaults this is ≤ 30s (heartbeat TTL) + ≤ 15s (reaper cycle) + reclaim latency = ~45s upper bound. |
| SC-006 | Regression re-appearance of the wedge under refactor | Fails CI | Delete the FR-001 sweep loop or FR-002 reclaim, run the FR-009 regression test → CI fails. |
| SC-007 | Change to hot-path Redis operations per healthy dispatch cycle | 0 | Measurement: `redis-cli MONITOR` during a healthy claim → complete cycle before and after the fix, assert the operation count is unchanged. The new sweep runs on a separate cadence and does not touch the claim/complete path. |

## Assumptions

- `orchestrator:worker:<workerId>:heartbeat` is the authoritative liveness signal — a live worker refreshes it every `heartbeatTtlMs / 2` (`worker-dispatcher.ts:520`), and both `stop()` and `complete()` explicitly `DEL` it. The key's presence-or-absence is a reliable proxy for "is a worker still processing this claim." Verified against `startHeartbeat` (`worker-dispatcher.ts:506-527`), `clearHeartbeat` (`:553-562`), and `complete()` (`redis-queue-adapter.ts:306`). Distinct from the currently-broken `reapStaleWorkers` path, which is fine — it just doesn't cover this class of failure.
- The claim hash payload contains `enqueuedAt` (verified — `SerializedQueueItem` at `types/monitor.ts:244-249` extends `QueueItem` which has `enqueuedAt: string` at `:26`). The reaper can read the claim's age without any schema change or migration.
- Existing test infrastructure spins up a real Redis instance for `redis-queue-adapter.*.test.ts` (verified — see `redis-queue-adapter.enqueueIfAbsent.test.ts:300-313` which asserts the exact log shape this fix modifies). The FR-009 regression test can reuse it.
- `SCAN orchestrator:queue:claimed:*` is safe against a production-sized keyset. At one dispatcher replica per cluster and one worker per replica (`worker-dispatcher.ts:302-306` doc), the claimed set is O(N-active-workers) — currently 1 per replica; a small handful even under lease-manager-enabled multi-slot mode. Well within `SCAN COUNT 100` per iteration.
- `heartbeatCheckIntervalMs` default 15s (`config/schema.ts:170`) is an appropriate cadence for the new sweep. Doubling the reaper's work (in-memory scan + Redis SCAN) at this cadence is O(N-active-workers) per side, so negligible.
- The maximum plausible run duration used to gate the log escalation (FR-006/FR-007) is significantly larger than steady-state healthy dispatch. Typical happy-path handler completes in seconds to a few minutes; the pathological case observed in this incident was 20 minutes (CLI timeout). The finalized default (see clarifications Q1=A and FR-012) is 30 minutes (`1_800_000` ms), configured via a new `maxRunDurationMs` field on `DispatchConfigSchema`. This clears the CLI timeout with headroom for post-timeout partial-push/label-update work, while still flagging the observed 84-minute wedge on the very next monitor cycle after 30 min.
- Zero interaction with `LeaseManager`'s per-user lease semantics. The lease path (`worker-dispatcher.ts:340-352`) re-enqueues on denial *before* claiming, so it never creates orphaned claims. The lease-expired path (`:234-278`) is orthogonal — its blind spot (dead dispatcher) is covered by FR-001's Redis-side sweep as a side effect.
- The reclaim's re-enqueue uses `queueReason: 'resume'` to mirror `handleLeaseExpired`'s existing behaviour (`worker-dispatcher.ts:271`). This matches operator intuition — a resurrected item should get resume priority, not go to the back of the queue.
- The bug is workload-agnostic — the wedge shape reproduces for any `command` value (`process`, `continue`, `address-pr-feedback`, `resolve-merge-conflicts`). The fix applies uniformly to all four.

## Out of Scope

- Fixing the root cause of the worker death itself. The trigger in the observed incident was a PR-feedback fixer that had already hit the 20-minute CLI timeout, but the wedge shape reproduces for any cause of process death (OOM kill, dispatcher replacement, container restart, node crash). Making the queue survive worker death is a lower layer than diagnosing why a specific worker died.
- Refactoring the in-memory `reapStaleWorkers` path (`worker-dispatcher.ts:578-614`). It works correctly for the subset it can see (workers this dispatcher spawned); the fix adds a *new* path for the subset it cannot see. Refactoring the two into one is a code-shape question, not a correctness question — deferred.
- Migrating the claim hash to per-key `SET`-with-TTL storage (issue's proposed fix #2). This is a plausible alternative architecture but a bigger blast radius — every read/write site (`claim`, `release`, `complete`, `getActiveWorkerCount`) would need to change to accommodate the key layout change, and the TTL still has to be refreshed by the heartbeat (or the claim wrongly expires under a slow but healthy run). The FR-001 sweep is a smaller, additive fix that achieves the same functional goal without touching the hot path.
- Adding a cloud-side or SSE-side alert for wedged in-flight items. FR-006–FR-008's log escalation is the observer surface; downstream alerting on `warn`-severity `Dropping enqueue …` lines is an operator/ops-config concern, not a code change.
- Adding a `/queue` admin endpoint or CLI tool for manually inspecting/clearing wedged claims. The fix should make the auto-reclaim reliable enough that manual intervention is not the day-to-day workaround. If operators still need this, it's a follow-up.
- Reworking the four monitor drop-log sites into a shared helper. FR-007's escalation can be applied in place at each site; extracting a helper is preferable but not strictly required for correctness.
- Changing the priority-score computation for resumed items (`getPriorityScore('resume')`). The FR-002 re-enqueue reuses the existing `'resume'` reason; any change to the resume priority itself is unrelated to this fix.
- Any change to the `blocked:*` label handling or the `PhaseTrackerService`. The prior fixer had set `blocked:stuck-feedback-loop`, but that label was cleared before the wedged item was claimed; the label wasn't a factor in the wedge itself.

---

*Generated by speckit*
