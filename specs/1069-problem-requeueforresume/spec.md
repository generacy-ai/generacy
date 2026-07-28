# Feature Specification: Atomic `requeueForResume()` / `release()` re-pend in `RedisQueueAdapter`

**Branch**: `1069-problem-requeueforresume` | **Date**: 2026-07-28 | **Status**: Draft
**Source issue**: [generacy-ai/generacy#1069](https://github.com/generacy-ai/generacy/issues/1069)
**Provenance**: Non-blocking follow-up raised in the review of #1065 (fix for #1060, merged as `fbcf85fb` on 2026-07-28).

## Summary

`RedisQueueAdapter.requeueForResume()` and `RedisQueueAdapter.release()` each perform a read-then-modify sequence as **two separate Redis round trips** (`HGET` claim payload → `MULTI: HDEL + DEL + ZADD`). Between the two round trips, the orphan reaper's `RECLAIM_ORPHAN_SCRIPT` can run atomically, `HDEL` the claim, and `ZADD` its own re-pend payload. The subsequent client `MULTI` fires with a no-op `HDEL` but its `ZADD` still adds a **second distinct pending member** — because Redis ZSETs key on the full member string and the two payloads differ in `queueReason` / `priority` / `attemptCount` / `enqueuedAt`.

Two pending members → two `CLAIM_SCRIPT` pops → two concurrent workers on one issue → conflicting pushes to one branch. This is the exact failure sequence that generacy#1060 (fixed in #1065) exists to eliminate; it arrives now via `release()` / `requeueForResume()` instead of via `enqueue()`.

Fix: fold the read and the re-pend of both methods into a single Lua script (mirroring how `RECLAIM_ORPHAN_SCRIPT` already handles the same class of race). `InMemoryQueueAdapter` is single-threaded and needs no behavioral change; its return contract stays in parity.

## Severity

**Low.** The race window is the few milliseconds between two Redis round trips (vs. the entire handler duration in the pre-#1060 hazard, where the duplicate was deterministic rather than raced). Nothing here regresses #1060 — this is the residue #1060 did not reach.

Still worth closing, because the two actors involved (the orphan reaper and the lease-expiry handler) are independent detectors of the *same* event — a dead worker — so they are unusually likely to run at nearly the same moment. This is not a hypothetical interleaving between unrelated code paths.

## User Stories

### US1: Orchestrator operator — no duplicate concurrent workers under reaper-interleave race

**As an** orchestrator operator running a cluster with Redis-backed queueing,
**I want** lease-expiry re-pends (`requeueForResume`) and retry re-pends (`release`) to be atomic against a concurrent orphan reclaim,
**So that** a dead-worker event handled by both actors simultaneously produces exactly one pending queue member and exactly one subsequent worker claim — never two workers pushing to the same PR branch in parallel.

**Acceptance Criteria** (mirror the issue's acceptance list):
- [ ] `requeueForResume()` issues exactly one Redis round trip for the read-and-re-pend.
- [ ] `release()` issues exactly one Redis round trip for the read-and-re-pend, with its dead-letter branch intact.
- [ ] A test that interleaves a reclaim between the read and the re-pend leaves `ZCARD pending == 1`.
- [ ] `attemptCount` is preserved verbatim across a lease-expiry re-pend (`requeueForResume`).
- [ ] `attemptCount` is incremented exactly once across a retry re-pend (`release`), matching current semantics.
- [ ] The dead-letter transition in `release()` continues to fire at `attemptCount >= maxRetries`, preserving the current `SREM` of the in-flight SET on that branch.
- [ ] The fix is exercised against a real `redis:7` service (as a Lua script), not against a hand-written TypeScript reimplementation of the Lua — asserting against a TS reimplementation cannot catch a mis-issued command sequence, which is the exact bug class here.

## Functional Requirements

| ID     | Requirement                                                                                                                                                          | Priority | Notes |
|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | `RedisQueueAdapter.requeueForResume()` MUST perform the read-and-re-pend in a single server-side atomic operation (Lua script).                                      | P1       | Mirrors `RECLAIM_ORPHAN_SCRIPT` pattern. |
| FR-002 | `RedisQueueAdapter.release()` MUST perform the read-and-re-pend **and dead-letter transition** in a single server-side atomic operation (single Lua script; Clarifications Q1 → A). | P1       | Dead-letter branch is folded into the same script; the script dispatches on `attemptCount + 1 >= maxRetries`. Dead-letter branch fires `SREM IN_FLIGHT_KEY` inside the script; retry branch does not. |
| FR-003 | The `requeueForResume` script MUST preserve `attemptCount` verbatim (do NOT increment). Lease expiry is an infrastructure event, per #1060 finding 2.                | P1       | Prevents infra events consuming retry budget. |
| FR-004 | The `release` script MUST increment `attemptCount` by exactly one on the retry branch and dead-letter at `attemptCount >= maxRetries`.                               | P1       | Matches current behavior. |
| FR-005 | Both scripts MUST return a **tuple `{ code, attemptCount }`** (Clarifications Q3 → B). `requeueForResume`: code ∈ {0: no-op / already-cleared, 1: re-pended}. `release`: code ∈ {0: no-op, 1: retry re-pended, 2: dead-lettered}. `attemptCount` is the post-mutation value on branches 1/2; on the no-op branch (0) it is `-1` (sentinel for "unknown, claim already cleared"). Caller's `logger.info` line reads `attemptCount` from the tuple, preserving the diagnostic operators rely on to notice items approaching `maxRetries`. | P1       | Diverges from `RECLAIM_ORPHAN_SCRIPT`'s integer-only return; the extra byte is worth preserving the "attempt N of maxRetries" signal. |
| FR-006 | Both scripts MUST preserve the current `IN_FLIGHT_KEY` invariant: `release` retry branch preserves in-flight membership; `release` dead-letter branch `SREM`s it; `requeueForResume` preserves it. | P1       | Matches current in-memory + Redis behavior; do not disturb `enqueue`-side invariant established by #1060 / #1065. |
| FR-007 | Both scripts MUST best-effort `DEL heartbeat` on the null-guard path, matching the current TypeScript fallback.                                                      | P2       | Prevents stale heartbeat keys when reaper wins the race. |
| FR-008 | Callers (`WorkerDispatcher.handleLeaseExpired`, `worker.release`) MUST NOT need to change their call signature; the returned `Promise<void>` contract stays.         | P1       | Backwards-compatible refactor. |
| FR-009 | `InMemoryQueueAdapter.requeueForResume()` and `.release()` MUST retain their current single-threaded semantics (no script; no Redis dependency) and log-line shape parity with the Redis adapter. | P1       | Issue explicitly scopes in-memory as no-op. |
| FR-010 | The new scripts MUST be exercised in tests against a real Redis instance (as scripts, via `defineCommand` / `EVALSHA`), not stubbed or reimplemented in TypeScript.   | P1       | Test-quality gate from the issue. CI already has `redis:7` service. |
| FR-011 | Both scripts MUST be registered on `RedisQueueAdapter` with the same `defineCommand` pattern already used for `CLAIM_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, and `RECLAIM_ORPHAN_SCRIPT`. | P2       | Consistency with existing three scripts. |
| FR-012 | The new scripts MUST be exported to the `redis-queue-adapter.script-wiring.test.ts` static-assertion test in the same `_SCRIPT_FOR_TESTS` pattern as `_ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS`. | P2       | Existing test-infra pattern. |

## Success Criteria

| ID     | Metric                                                                                                                                                                                 | Target                                  | Measurement |
|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------|-------------|
| SC-001 | **Deterministic controlled-interleave** regression test injects `reapOrphanClaims` between the read and mutate steps of `requeueForResume` (via ioredis command-hook or Redis proxy). Test MUST demonstrate failure against pre-fix code (proving diagnostic value) and success against fixed code (`ZCARD orchestrator:queue:pending == 1`). Clarifications Q4 → C. Complement: cheap natural-race smoke test (N=100 pairs via `Promise.all`, sequential across pairs) guards unrelated regressions but is NOT the proof. | Deterministic test passes on fix, fails on pre-fix baseline; smoke test 100% pass. | New integration test in `packages/orchestrator/src/services/__tests__/` with real `redis:7`. |
| SC-002 | Same deterministic + smoke pair for `release()` (retry branch AND dead-letter branch, since dead-letter is folded into the same script per Q1 → A) also leaves `ZCARD == 1`.        | Deterministic passes on fix, fails on pre-fix; smoke 100% pass. | New integration test. |
| SC-003 | `requeueForResume()` end-to-end operation issues exactly **one** Redis round trip (excluding the null-guard `DEL heartbeat` on the reaper-wins path). Asserted via a **separate plain test** using a wrapped `ioredis` command counter — NOT folded into the concurrency test (Clarifications Q4 rider). | 1 round trip on happy path.             | Command-count assertion via wrapped ioredis client. |
| SC-004 | `release()` end-to-end operation issues exactly **one** Redis round trip on both the retry branch and the dead-letter branch (excluding the null-guard). Q1 → A guarantees this by folding the dead-letter branch into the single script. Same separate plain test as SC-003. | 1 round trip on happy path (both branches). | Command-count assertion via wrapped ioredis client. |
| SC-005 | `attemptCount` value on a re-pended item is bit-identical to the pre-re-pend value across a lease-expiry sequence (100 repeated cycles).                                              | 100% bit-identical.                     | Integration test asserting `parsed.attemptCount` before/after. |
| SC-006 | `release()` still dead-letters at exactly `maxRetries` retries, and dead-letter items are removed from `IN_FLIGHT_KEY`.                                                                | Existing behavior unchanged.            | Existing test coverage continues to pass. |
| SC-007 | Zero new failing tests in `packages/orchestrator/src/services/__tests__/redis-queue-adapter.*.test.ts`.                                                                                | 0 regressions.                          | CI. |
| SC-008 | No public API signature change on `QueueManager` interface (`release`, `requeueForResume` return types unchanged).                                                                     | Interface diff empty for these methods. | `git diff packages/orchestrator/src/types/monitor.ts`. |

## Assumptions

- **A1**: The `RECLAIM_ORPHAN_SCRIPT` pattern is the correct reference for this fix. It is already load-bearing for the same class of race (`HGET` → check → `HDEL` + `ZADD`) and its `IN_FLIGHT_KEY` handling (no `SREM` on reclaim) already establishes the invariant this fix must preserve.
- **A2**: The `attemptCount` value MUST be read from inside the Lua script rather than passed in from the caller. Passing it in from the caller reintroduces the exact TOCTOU (time-of-check-to-time-of-use) hazard the fix is closing — the caller would still read via a separate `HGET` first. The script performs the read-then-write internally with `cjson.decode` on the claim payload, mutates `parsed.attemptCount` (verbatim for `requeueForResume`, `+1` for `release`), then `cjson.encode` and `ZADD`. Matches the `claimedAt` pattern `CLAIM_SCRIPT` uses at `redis-queue-adapter.ts:87-95` (Clarifications Q2 → A).
- **A3**: The `release()` dead-letter branch's `SREM IN_FLIGHT_KEY` is intentional and MUST be preserved. Only the retry branch, `requeueForResume`, and reclaim leave the item in-flight; dead-letter removes it.
- **A4**: `resumePriority` and `retryPriority` continue to be computed client-side via `getPriorityScore()` and passed to the script as `ARGV`, matching how `RECLAIM_ORPHAN_SCRIPT` receives `ARGV[4]` today.
- **A5** (revised): The script re-serializes the re-pend payload **inside Lua** via `cjson.encode(parsed)` after mutation. Superseded original concern: `cjson.encode`'s unstable key ordering was thought to risk downstream member-string identity lookups, but audit of `redis-queue-adapter.ts` confirms no member-identity lookup exists — pending members are consumed by `ZPOPMIN` inside `CLAIM_SCRIPT` and otherwise read wholesale via `ZRANGE`. Additionally, `CLAIM_SCRIPT` at `:87-95` already round-trips every claimed payload through Lua `cjson.encode`, so the caller-side ordering B tried to preserve is already lost by the time these scripts run. Clarifications Q2 → A settles this.
- **A6**: `strip claim-lifecycle fields` (`claimedAt: undefined`) currently done client-side in `requeueForResume` (`redis-queue-adapter.ts:871`) must be preserved by whichever party (script or caller) constructs the final ZADD member.
- **A7**: The `InMemoryQueueAdapter` counterpart methods are already atomic by virtue of being single-threaded within a single Node.js process, and the issue explicitly scopes their behavior as no-change. Test parity with the Redis adapter (same log-line shape, same return contract, same `attemptCount` semantics) MUST be preserved.
- **A8**: Under Redis Cluster, all keys touched by a single script must hash to the same slot (`CROSSSLOT`). `PENDING_KEY`, `CLAIMED_KEY_PREFIX + workerId`, `HEARTBEAT_KEY_PREFIX + workerId + ':heartbeat'` today all appear in the same script for `RECLAIM_ORPHAN_SCRIPT`, so the same set is already known-safe for these new scripts.

## Out of Scope

- **OoS-1**: Refactoring `enqueue()`, `enqueueIfAbsent()`, or `CLAIM_SCRIPT` — those paths were fixed by #1060 / #1065 and are not implicated in this race.
- **OoS-2**: Changing the reaper's grace-window (`RECLAIM_ORPHAN_SCRIPT` `ARGV[3]`) or heartbeat-expiry semantics.
- **OoS-3**: Changing the `QueueManager` public interface. Both methods retain `Promise<void>` return contract (FR-008).
- **OoS-4**: Any changes to `WorkerDispatcher`, `label-monitor-service`, `pr-feedback-monitor-service`, or other callers. This is a self-contained adapter-internal fix.
- **OoS-5**: Any change to `InMemoryQueueAdapter` beyond preserving test parity with the Redis adapter's log-line shape / return contract (FR-009).
- **OoS-6**: Introducing new Redis keys, new persisted state, or new heartbeat semantics.
- **OoS-7**: Any observability or telemetry additions beyond the existing `logger.info` / `logger.warn` lines already present in the two methods (their message text and fields stay the same modulo the `queueReason: 'retry'` / `'resume'` distinction already present).
- **OoS-8**: Backporting or shipping a companion change to any other repo (this is a generacy-repo-internal fix).

---

*Generated by speckit. Enhanced from issue #1069 body on 2026-07-28.*
