# Clarifications

## Batch 1 — 2026-07-28

### Q1: `enqueue()` return-shape contract
**Context**: FR-002 explicitly defers the return shape to clarifications ("see clarifications Q1"). Today `QueueManager.enqueue(item): Promise<void>` and the sibling `enqueueIfAbsent(item): Promise<boolean>` (true = enqueued, false = dropped) live side-by-side on the interface in `packages/orchestrator/src/types/monitor.ts:230,314`. The `InMemoryQueueAdapter.enqueue()` at `in-memory-queue-adapter.ts:64-102` silently returns void on dedupe today. FR-003 requires the two callers (`LabelMonitorService`, `WorkerDispatcher.handleLeaseExpired`) to *observe* whether a drop occurred so they can emit the FR-005 log — that observation is impossible with `Promise<void>`. The chosen shape locks in the `QueueManager` public contract and cross-adapter parity assertions in FR-006/FR-007.
**Question**: What return shape should `enqueue()` use to distinguish "enqueued" from "already-in-flight"?
**Options**:
- A: `Promise<boolean>` — mirrors `enqueueIfAbsent` exactly (true = enqueued, false = dropped-in-flight). Simplest parity; callers add a single `if (!result) log(...)` branch. The two verbs' signatures become identical, reinforcing FR-002's framing that they now differ only in caller *intent*, not observable behaviour.
- B: `Promise<'enqueued' | 'already-in-flight'>` — string enum. More self-documenting than a bare boolean; explicit at the call site. Diverges from `enqueueIfAbsent`'s existing boolean shape unless that is also migrated (out of scope for this spec).
- C: `Promise<{ status: 'enqueued' | 'already-in-flight'; itemKey: string }>` — discriminated union with the resolved `itemKey` echoed back. Room to grow (add `reason` fields, ages, existing entry pointer) without another signature change. Heaviest of the three at the call site.

**Answer**: *Pending*

### Q2: `WorkerDispatcher.handleLeaseExpired()` behaviour when `enqueue()` returns `already-in-flight`
**Context**: `handleLeaseExpired` at `worker-dispatcher.ts:255-278` clears in-memory worker state and then calls `queue.enqueue({...worker.item, queueReason: 'resume', ...})` **without calling `release()` first**. Today that works because `enqueue()` doesn't check the in-flight SET. After FR-001, when a worker's lease expires the itemKey is still in the in-flight SET (never SREM'd — CLAIM_SCRIPT preserves it) AND still in the claimed hash (`orchestrator:queue:claimed:<workerId>` — no release fired). FR-002's dedupe will therefore drop the re-enqueue, and the item stays orphan-claimed with no live worker. FR-003 says on drop the caller should "log and treat as success" — but for this specific caller that outcome silently strands the item. FR-004 forbids modifying `release()` or claim-side logic; PR #1056's `RECLAIM_ORPHAN_SCRIPT` is described as the orphan-recovery mechanism.
**Question**: How should `handleLeaseExpired` recover the wedged item once FR-002's dedupe blocks its `enqueue()` call?
**Options**:
- A: `handleLeaseExpired` first calls `release()` (which HDELs the claimed hash entry and SREMs the in-flight SET on the retry branch), then re-enqueues. Keeps the current shape; adds one Lua call per lease expiry. Note: `release()`'s retry branch preserves in-flight membership per the CLAIM_SCRIPT comment at `redis-queue-adapter.ts:87-90` — verify at implement time this composes correctly with FR-001.
- B: `handleLeaseExpired` delegates orphan recovery entirely to PR #1056's `RECLAIM_ORPHAN_SCRIPT` — the direct `enqueue()` call is removed. Requires PR #1056 to have landed before this spec, or a synthetic reclaim in the meantime. Simplest correctness story (one path for orphan recovery), largest cross-spec coupling.
- C: `handleLeaseExpired`'s `enqueue()` call is treated as fire-and-forget: on `already-in-flight` it logs at `info` and moves on. The reaper loop (via `reapOrphanClaims`) is the sole guaranteed recovery path. Simplest change; relies on the reaper being scheduled reliably.
- D: Add a distinct `reclaim()` verb to the `QueueManager` interface that atomically removes a specific worker's claim and re-pends. Cleanest semantically; largest interface change; overlaps with #1056.

**Answer**: *Pending*

### Q3: Priority / `queueReason` upgrade semantics on drop
**Context**: Redis ZSET members are opaque JSON strings, so two enqueues for the same itemKey with different `priority` or `queueReason` produce two distinct pending members today (spec §Problem point 4). After FR-002, the second call is dropped silently — but that call may have come from a monitor with a *higher-priority* intent (`queueReason: 'resume'` at priority 0, vs. an existing pending entry at `queueReason: 'process'` priority 5). The higher-priority intent is lost. `WorkerDispatcher.handleLeaseExpired` in particular uses `priority: 0, queueReason: 'resume'` (`worker-dispatcher.ts:270-272`), so this collision is not hypothetical.
**Question**: When `enqueue()` drops a duplicate that would have carried a *higher* priority than the existing in-flight entry, what should happen?
**Options**:
- A: Silent drop — the existing member wins regardless of priority. Matches `enqueueIfAbsent` semantics exactly; simplest Lua body; documented as "in-flight is in-flight, priority-upgrade requires release-then-enqueue". Priority inversion is possible but bounded (worker picks the pending entry when it dispatches next).
- B: Priority upgrade — if the existing entry is in *pending* (not claimed) and the new call's `priority` is numerically lower, `ZADD XX` to update the score. If in claimed, drop silently (a claimed item's dispatch already happened). Adds branching to the Lua body. Preserves resume-priority intent.
- C: Drop with a distinguishable return code (`'already-in-flight-lower-priority'`) so the caller can decide. Pushes the decision to caller; two live callers today, both would need `if` branches.

**Answer**: *Pending*

### Q4: Log-site duplication between adapter and caller
**Context**: FR-002 describes the Lua-script-side drop returning a code; FR-003 requires callers to log on drop. FR-005 also mentions "the FR-002 drop log line and the FR-003 caller-side drop lines default to `info`" — implying two log lines per drop. The four existing monitor drop sites (`pr-feedback-monitor-service.ts:428`, `merge-conflict-monitor-service.ts:186`, `clarification-answer-monitor-service.ts:240`, `label-monitor-service.ts:361`) already emit a single log line at the caller. `emitDropLog` in `drop-log-helper.ts` is called from within the adapter's `enqueueIfAbsent` per `in-memory-queue-adapter.ts:119-124`, so the *adapter* is the current log site for `enqueueIfAbsent`.
**Question**: Where should the FR-002 drop log fire for `enqueue()`?
**Options**:
- A: Adapter-only, via `emitDropLog` — matches the current `enqueueIfAbsent` pattern in both adapters. FR-003 callers observe the return code but do *not* emit a second log line. FR-005's "and the FR-003 caller-side drop lines" wording is amended to "the callers *observe the drop* without re-logging". Single log line per drop; consistent shape across `enqueue` and `enqueueIfAbsent`.
- B: Caller-only — the adapter returns silently; each of the two `enqueue()` callers logs at their site with caller-specific context (e.g., `source: 'label-monitor'`, `source: 'lease-expiry'`). Diverges from `enqueueIfAbsent`'s adapter-side log pattern.
- C: Both — adapter emits the low-level drop signal (`source: 'enqueue'`), caller emits a higher-level context signal (`source: 'label-monitor'`, `context: 'process-label'`). Two lines per drop; alerting keys off both.

**Answer**: *Pending*

### Q5: `_dedup:<itemKey>` hash lifecycle in the new `ENQUEUE_SCRIPT`
**Context**: `RedisQueueAdapter.enqueue()` currently populates `_dedup:<itemKey>` on the success path for cross-adapter observability (used by `getDedupKey()`). Spec §Ruled out and Assumption §128 say `_dedup` is preserved as observability, not a dedupe-gate participant. FR-002's drop path says the script "does not mutate `pending`, `in-flight-items`, or `_dedup:*`". The FR-001 success path is not explicit about whether the new atomic Lua body writes `_dedup:*` inside the same script or leaves that to a second round-trip after the script returns.
**Question**: Should the new `ENQUEUE_SCRIPT`'s success path write `_dedup:<itemKey>` inside the Lua body, or leave it as a separate post-script round-trip?
**Options**:
- A: Inside the Lua body — one round-trip total, atomic with `SADD` + `ZADD`. Matches FR-001's atomicity intent; observability data can never diverge from queue state. Slightly larger script.
- B: Separate round-trip after script returns `enqueued` — matches today's ordering (`_dedup` written by adapter code, not Lua). No atomicity guarantee between queue-state and `_dedup` (a crash between the two leaves `_dedup` stale) but `_dedup` is observability-only so the divergence is diagnostic, not correctness-affecting.
- C: Drop `_dedup:*` from `enqueue()` entirely — it is observability-only, no live consumer described in the spec. Simplest change; may surface as a missing field in unrelated tooling. Verify at implement time.

**Answer**: *Pending*
