# Implementation Plan: RedisQueueAdapter.enqueue() must maintain the in-flight-SET invariant

**Feature**: `RedisQueueAdapter.enqueue()` maintains the `in-flight = pending ∪ claimed` invariant on the `process:<workflow>` intake path
**Branch**: `1060-problem-redisqueueadapter`
**Status**: Complete
**Issue**: [#1060](https://github.com/generacy-ai/generacy/issues/1060)

## Summary

`RedisQueueAdapter.enqueue()` today runs `ZADD pending` only. It does not touch the in-flight SET, does not dedupe, and does not write `_dedup:<itemKey>`. Because the `process:<workflow>` label handler and `WorkerDispatcher.handleLeaseExpired()` are the two live callers of `enqueue()`, the intake path that carries most work into the queue silently corrupts the state that `ENQUEUE_IF_ABSENT_SCRIPT` and `CLAIM_SCRIPT` both rely on: the in-flight SET is *the* index of `pending ∪ claimed`. Once an item slips into pending without a matching SET member, any concurrent monitor using `enqueueIfAbsent()` passes the `SISMEMBER` guard and adds a second distinct pending member (member strings differ across `queueReason` / `priority` / `enqueuedAt` / `attemptCount`), producing two concurrent worker claims for the same issue. The `InMemoryQueueAdapter.enqueue()` sibling already implements the correct dedupe + `inFlightSet` add; only the Redis adapter is wrong.

This spec adds a fifth Lua script `ENQUEUE_SCRIPT` that runs `SISMEMBER` → conditional `SADD` + `ZADD` + `HSET _dedup:<itemKey>` atomically, changes `QueueManager.enqueue()` from `Promise<void>` to `Promise<boolean>` (mirroring `enqueueIfAbsent`), updates the two direct callers, and lands a parameterized regression suite that asserts the invariant across the full `enqueue → claim → release-retry → reclaim-orphan → complete` sequence on both adapters.

Zero changes to `CLAIM_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, `RELEASE_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`, `release()`, `complete()`, or `handleLeaseExpired`'s claim-side logic. The fix is additive to `enqueue()` plus a `release()`-before-`enqueue()` reorder in `handleLeaseExpired`.

## Technical Context

- **Language**: TypeScript, ESM, Node >=22
- **Runtime**: `packages/orchestrator/src/services/` in `@generacy-ai/orchestrator`
- **Redis client**: `ioredis` — existing `defineCommand` / Lua `EVAL`/`EVALSHA` pattern via four sibling scripts
- **Test runner**: `vitest`
- **Integration Redis**: existing real-Redis test infrastructure (`redis-queue-adapter.*.test.ts`) uses `ioredis` directly against a live Redis (spun up by the test harness). No mocked SET/HASH commands — a mocked adapter would not catch a mis-issued `SADD`/`SREM` command shape.
- **New dependencies**: none. Fifth Lua script is a string literal following the existing four-script pattern.
- **Public API impact**: `QueueManager.enqueue(item): Promise<void>` → `Promise<boolean>`. `QueueAdapter.enqueue(item): Promise<void>` → `Promise<boolean>`. Both adapters update.
- **Cross-adapter parity**: `InMemoryQueueAdapter.enqueue()` already dedupes + adds to `inFlightSet`; only its return type migrates.
- **Composition with #1054/PR #1056**: `RECLAIM_ORPHAN_SCRIPT` already merged (`afab7d58`); its correctness depends on the in-flight SET being populated at enqueue time — this fix makes that reliably true. `drop-log-helper.ts::emitDropLog` is the transition-edge-throttled log site both adapters already share for `enqueueIfAbsent` drops; the new drop path from `enqueue()` funnels through the same helper (FR-005 / clarifications Q4=A).
- **Priority handling**: silent drop on collision (clarifications Q3=A). The existing entry wins regardless of the new call's `priority` / `queueReason`. Priority upgrade requires `release()` then re-enqueue.
- **`handleLeaseExpired` sequencing**: `release()` first, then `enqueue()` (clarifications Q2=A). After FR-001 the itemKey is still in-flight-SET-resident after a lease expiry (`CLAIM_SCRIPT` deliberately preserves), so a direct `enqueue()` would be dropped and leave the item orphan-claimed. `release()`'s retry branch re-pends via `HDEL claimed`/`DEL heartbeat`/`ZADD pending` while preserving in-flight membership; the subsequent `enqueue()` is redundant and will be dropped by the new dedupe — either remove the call or leave a comment.
- **`_dedup:<itemKey>` discrepancy**: spec Assumption §128 and clarifications Q5 both assume `enqueue()` currently populates `_dedup:<itemKey>` for a `getDedupKey()` observability reader. **Neither exists in the current code** (grep confirms). Following spec FR-001 literally means adding a *net-new* `HSET _dedup:<itemKey>` inside the Lua body. See `research.md § _dedup discrepancy` for the recommendation (implement as prescribed to satisfy FR-001; reviewer decides whether to accept as new observability or open a follow-up to drop from spec).

## Project Structure

```
packages/orchestrator/
├── src/
│   ├── services/
│   │   ├── redis-queue-adapter.ts                                    # MODIFIED
│   │   │   ├── + ENQUEUE_SCRIPT (new Lua)
│   │   │   ├── + ensureEnqueueCommand()
│   │   │   ├── ~ enqueue(): Promise<void> → Promise<boolean>
│   │   │   └── (no other changes — CLAIM_SCRIPT, ENQUEUE_IF_ABSENT_SCRIPT,
│   │   │       RECLAIM_ORPHAN_SCRIPT, release, complete unchanged)
│   │   ├── in-memory-queue-adapter.ts                                # MODIFIED
│   │   │   └── ~ enqueue(): Promise<void> → Promise<boolean>
│   │   │       + return true on enqueue, false on dedupe drop
│   │   │       + funnel drop log through emitDropLog (FR-005 parity)
│   │   ├── label-monitor-service.ts                                  # MODIFIED
│   │   │   └── ~ processLabelEvent() type==='process' branch
│   │   │       observes enqueue() bool; treats false as success
│   │   │       (no re-log — adapter owns FR-005)
│   │   ├── worker-dispatcher.ts                                      # MODIFIED
│   │   │   └── ~ handleLeaseExpired(): release() before enqueue()
│   │   │       (per clarifications Q2=A)
│   │   ├── drop-log-helper.ts                                        # UNCHANGED
│   │   └── __tests__/
│   │       ├── redis-queue-adapter.enqueue-invariant.test.ts         # NEW (FR-007, FR-008)
│   │       │   └── real Redis; invariant sequence + wedge regression
│   │       ├── in-memory-queue-adapter.enqueue-invariant.test.ts     # NEW (FR-007)
│   │       │   └── in-memory; same sequence for parity assertion
│   │       └── queue-adapter-parity.test.ts                          # NEW (FR-007, SC-003)
│   │           └── parameterized suite across both adapters
│   ├── types/
│   │   └── monitor.ts                                                # MODIFIED
│   │       ├── ~ QueueAdapter.enqueue: Promise<void> → Promise<boolean>
│   │       ├── ~ QueueManager.enqueue: Promise<void> → Promise<boolean>
│   │       └── + interface JSDoc for `after enqueue(k), k ∈ inFlightSet`
│   └── ...
├── .changeset/
│   └── 1060-redis-enqueue-invariant.md                               # NEW
└── ...
```

## Constitution Check

`/workspaces/generacy/.specify/memory/constitution.md` — not present in this repo (verified via `ls` at path). No governing principles to check against.

## Phases

### Phase 1 — Lua-script atomicity + interface contract (FR-001, FR-006)

1. Add `ENQUEUE_SCRIPT` constant to `redis-queue-adapter.ts`, mirroring the `ENQUEUE_IF_ABSENT_SCRIPT` shape but with the differences called out in `contracts/enqueue-script.md`.
2. Add `ensureEnqueueCommand()` following the existing `ensureEnqueueIfAbsentCommand()` pattern. `numberOfKeys: 3` (pending ZSET, in-flight SET, `_dedup:<itemKey>` hash).
3. Rewrite `enqueue()` to invoke `ENQUEUE_SCRIPT` via `defineCommand`, translate the return code to `boolean`, seed `enqueuedAtCache` on success, and call `emitDropLog` on drop via the existing `classifyDropSeverity` + `hasInFlightAge` path used by `enqueueIfAbsent`.
4. Update `QueueManager` and `QueueAdapter` interface signatures in `types/monitor.ts` — both to `Promise<boolean>`. Add JSDoc for the invariant.
5. Migrate `InMemoryQueueAdapter.enqueue()` return type from `Promise<void>` → `Promise<boolean>`. Convert the two `logger.debug` dedupe log lines to funnel through `emitDropLog` with `{ itemKey, source: 'enqueue', reason: 'in-flight' }` fields so SC-003 (cross-adapter log-shape parity) holds.

### Phase 2 — Caller updates (FR-003)

6. `label-monitor-service.ts::processLabelEvent()` `type === 'process'` branch (line ~428): observe the boolean return of `enqueue()`. On `false`, treat as success (item already in-flight; enqueue's intent is satisfied). Do not emit an extra log line — the adapter owns FR-005.
7. `worker-dispatcher.ts::handleLeaseExpired()` (line ~267): call `release()` before `enqueue()`. Verify `release()`'s existing signature accepts the priority-0 `resume` intent (currently it uses `getPriorityScore('retry')` hardcoded — see `research.md § handleLeaseExpired sequencing` for the resolution path). Either remove the redundant `enqueue()` call (recommended) or annotate it with a `// FR-003` comment explaining why it's expected to drop.

### Phase 3 — Regression coverage (FR-007, FR-008)

8. Add `redis-queue-adapter.enqueue-invariant.test.ts` targeting real Redis:
   - `enqueue({ itemKey })` → `SISMEMBER IN_FLIGHT_KEY itemKey === 1`
   - `enqueue → enqueue` same key → second returns `false`, `ZCARD pending === 1`, no second SET member (no-op)
   - `enqueue → claim` → `SISMEMBER IN_FLIGHT_KEY itemKey === 1` (CLAIM_SCRIPT preserves)
   - `enqueue → claim → release-retry → reclaim-orphan → complete` — invariant `in-flight-items == pending-keys ∪ claimed-keys` at every intermediate step
   - **FR-008 named wedge test** in its own `describe('#1060 observed incident regression', ...)`: `enqueue(#N)` → `claim(worker-A, #N)` → concurrent `enqueueIfAbsent(#N)` from a monitor → asserts second call dropped, `ZCARD pending === 0`, exactly one claim exists
   - Deleting the `SADD IN_FLIGHT_KEY` from `ENQUEUE_SCRIPT` breaks at least one test (SC-006)
9. Add `in-memory-queue-adapter.enqueue-invariant.test.ts` running the same FR-007 sequence in-memory (adapter's `inFlightSet` inspected via public `hasInFlight`).
10. Add `queue-adapter-parity.test.ts` parameterized over `[redisAdapter, inMemoryAdapter]` asserting identical drop-vs-accept + log-line shape across the FR-007 sequence (SC-003).

### Phase 4 — Changeset and publication

11. Author `.changeset/1060-redis-enqueue-invariant.md`. `@generacy-ai/orchestrator` **patch** (internal-only public API change; two live callers both in-repo; no external consumer per `pnpm why @generacy-ai/orchestrator`). Bump to **minor** if a downstream package in this repo declares `@generacy-ai/orchestrator` in `dependencies`. Verify at implement time.

---

*Generated by speckit*
