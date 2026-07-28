# Implementation Plan: Atomic `requeueForResume()` / `release()` re-pend in `RedisQueueAdapter`

**Feature**: Fold the read-then-mutate sequence of `RedisQueueAdapter.requeueForResume()` and `RedisQueueAdapter.release()` (retry + dead-letter branches) into single Lua scripts, closing the reaper-interleave TOCTOU window that produces duplicate pending members
**Branch**: `1069-problem-requeueforresume`
**Status**: Complete
**Issue**: [#1069](https://github.com/generacy-ai/generacy/issues/1069)

## Summary

`RedisQueueAdapter.requeueForResume()` at `redis-queue-adapter.ts:839-894` and `RedisQueueAdapter.release()` at `redis-queue-adapter.ts:724-813` each do a two-round-trip read-then-mutate: `HGET claimed:<workerId> <itemKey>` returns the claim payload → then a client-side `MULTI` runs `HDEL claimed` + `DEL heartbeat` + `ZADD pending` (or the `+ SREM in-flight` dead-letter variant). Between those two round trips, `RECLAIM_ORPHAN_SCRIPT` (which runs atomically on the server) can `HDEL` the same claim field and `ZADD` its own re-pend payload to `PENDING_KEY`. The subsequent client `MULTI` then fires with a no-op `HDEL` but its `ZADD` still upserts a **second distinct pending member** — Redis ZSETs key on the full member string, and the two payloads differ in `queueReason` / `priority` / `attemptCount` / `enqueuedAt`. Two pending members → two `CLAIM_SCRIPT` pops → two concurrent workers on one issue. This is the exact failure sequence #1060 (fixed in #1065) exists to prevent, arriving now via `release()` / `requeueForResume()` instead of via `enqueue()`.

The fix mirrors how `RECLAIM_ORPHAN_SCRIPT` already handles the same class of race: fold the read and the re-pend into a single server-side Lua script per method. `release()`'s dead-letter branch is folded into the same script (Clarifications Q1 → A) so SC-004 is satisfied on both branches. `attemptCount` is read and mutated **inside Lua** via `cjson.decode` → mutate → `cjson.encode` (Clarifications Q2 → A) so the caller never observes a value produced by a separate `HGET` round trip. Both scripts return a tuple `{ code, attemptCount }` (Clarifications Q3 → B) so the caller's existing `logger.info` line preserves the "attempt N of maxRetries" diagnostic. `InMemoryQueueAdapter` is single-threaded within its process and requires no behavioural change beyond log-line-shape parity with the Redis adapter (FR-009).

Zero changes to `CLAIM_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`, `complete()`, `hasInFlight`, `hasInFlightAge`, or `reapOrphanClaims`. Zero changes to `QueueManager` / `QueueAdapter` interface signatures — both methods retain `Promise<void>` return contract (FR-008). Zero changes to `WorkerDispatcher`, `label-monitor-service`, `pr-feedback-monitor-service`, or any other caller. This is a self-contained adapter-internal fix.

## Technical Context

- **Language**: TypeScript, ESM, Node >=22
- **Runtime**: `packages/orchestrator/src/services/` in `@generacy-ai/orchestrator`
- **Redis client**: `ioredis` — existing `defineCommand` / Lua `EVAL`/`EVALSHA` pattern via three sibling scripts (`ENQUEUE_IF_ABSENT_SCRIPT`, `CLAIM_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`)
- **Test runner**: `vitest`
- **Integration Redis**: existing real-Redis test infrastructure. Two shapes coexist: (a) `redis-queue-adapter.reclaim-lua.test.ts` uses `ioredis-mock`'s `fengari` VM to exercise real Lua bytes (fast, hermetic — but `cjson` unavailable, so cannot cover the new scripts which decode/encode payload JSON); (b) `redis-queue-adapter.orphan-reclaim.test.ts` uses a stateful mock re-implementing script semantics in TypeScript (catches shape bugs but not command-sequence bugs). Neither is enough on its own for the new scripts — the concurrency-race deliverable requires a **third harness**: real ioredis against a live `redis:7` service, driven by CI's existing container.
- **New dependencies**: none. Two new Lua-script string literals following the existing three-script pattern. `cjson` is a Redis built-in Lua module available on all supported Redis versions (already used implicitly by `CLAIM_SCRIPT`).
- **Public API impact**: **zero**. Both `release(workerId, item): Promise<void>` and `requeueForResume(workerId, item): Promise<void>` signatures are preserved (FR-008 / SC-008).
- **Cross-adapter parity**: `InMemoryQueueAdapter.release()` and `.requeueForResume()` are already atomic by virtue of single-threaded execution within one Node.js process. Parity is limited to log-line-shape (same fields, same message text) and return-contract (`Promise<void>`), both already satisfied by the current implementation. Only the log emit sites are audited for parity; no behavioural change.
- **Composition with #1060/PR #1065**: `ENQUEUE_IF_ABSENT_SCRIPT` (merged as `fbcf85fb`) established the `SADD IN_FLIGHT_KEY` + `ZADD pending` co-atomicity for the intake path. This spec preserves that invariant on the two return paths that were previously non-atomic: `release()` retry branch preserves in-flight membership (no `SREM`), `release()` dead-letter branch removes it (`SREM` inside the script), `requeueForResume` preserves it. FR-006 makes this an explicit invariant of the new scripts.
- **Composition with #1054/PR #1056**: `RECLAIM_ORPHAN_SCRIPT` (already merged) is the atomic implementation of the *same* race pattern for the reaper side of the wire. Its `KEYS[1..3]` shape (`claimed:<workerId>`, `heartbeat`, `pending`) is the direct precedent for both new scripts; its `IN_FLIGHT_KEY` handling (no `SREM` on reclaim) establishes the invariant that `release()` retry and `requeueForResume` must preserve.
- **Concurrency test methodology (Clarifications Q4 → C)**: the load-bearing deliverable is a **deterministic controlled-interleave** test that injects `reapOrphanClaims` between the read and re-pend steps of the *pre-fix* code, demonstrates the assertion FAILS (proving the test is diagnostic), then demonstrates it PASSES against the fixed code where the interleave window is structurally closed. A natural-race `Promise.all` smoke test (N=100) is retained as complement but is not the proof — it would pass 100/100 against the unfixed code because the odds of the scheduler landing the reap precisely in the few-millisecond window are tiny. The round-trip-count assertion (SC-003 / SC-004) is a **separate, plain test** using a wrapped `ioredis` command counter, not folded into the concurrency test.
- **`attemptCount` invariant (Clarifications Q2 → A)**: `attemptCount` MUST be read from inside the Lua script via `cjson.decode(claimed)`, not passed as ARGV. Passing it as ARGV reintroduces the exact TOCTOU hazard being closed — the caller would still read via a separate `HGET` first. `CLAIM_SCRIPT` at `redis-queue-adapter.ts:87-95` already does the same `cjson.decode` → mutate → `cjson.encode` pattern; the two new scripts follow the identical shape.
- **Return-tuple contract (Clarifications Q3 → B)**: both scripts return `{ code, attemptCount }` as a Lua array. `requeueForResume`: `code ∈ {0, 1}`; `release`: `code ∈ {0, 1, 2}`. `attemptCount` on branch 0 (no-op) is the sentinel `-1` — the caller's `logger.info` line reads and logs the actual mutated count on branches 1/2, preserving the diagnostic operators rely on to notice items approaching `maxRetries` (spec §Q3 answer).

## Project Structure

```
packages/orchestrator/
├── src/
│   ├── services/
│   │   ├── redis-queue-adapter.ts                                       # MODIFIED
│   │   │   ├── + RELEASE_SCRIPT (new Lua, single script folding both branches per Q1=A)
│   │   │   ├── + REQUEUE_FOR_RESUME_SCRIPT (new Lua)
│   │   │   ├── + ensureReleaseCommand()
│   │   │   ├── + ensureRequeueForResumeCommand()
│   │   │   ├── + private releaseCommandDefined boolean
│   │   │   ├── + private requeueForResumeCommandDefined boolean
│   │   │   ├── ~ release(): invokes RELEASE_SCRIPT via defineCommand; caller
│   │   │   │                switch on returned code; log-lines unchanged (modulo
│   │   │   │                attemptCount source: tuple element, not local var)
│   │   │   ├── ~ requeueForResume(): invokes REQUEUE_FOR_RESUME_SCRIPT via
│   │   │   │                defineCommand; caller switch on returned code
│   │   │   ├── + _RELEASE_SCRIPT_FOR_TESTS (export for script-wiring test)
│   │   │   ├── + _REQUEUE_FOR_RESUME_SCRIPT_FOR_TESTS (export for script-wiring test)
│   │   │   └── (CLAIM_SCRIPT, ENQUEUE_IF_ABSENT_SCRIPT, RECLAIM_ORPHAN_SCRIPT,
│   │   │       complete, hasInFlight, hasInFlightAge, reapOrphanClaims unchanged)
│   │   ├── in-memory-queue-adapter.ts                                   # UNCHANGED (parity audit only)
│   │   │   └── (FR-009 — no behavioural change; log-line shape already matches
│   │   │       Redis adapter; return contract already Promise<void>)
│   │   └── __tests__/
│   │       ├── redis-queue-adapter.release-atomic.test.ts               # NEW (SC-002 controlled interleave)
│   │       │   └── real ioredis vs redis:7; deterministic reap-injection
│   │       │       between read and mutate on retry branch AND dead-letter
│   │       │       branch; asserts FAILS on pre-fix + PASSES on fix; complement
│   │       │       N=100 Promise.all smoke test
│   │       ├── redis-queue-adapter.requeueForResume-atomic.test.ts       # NEW (SC-001)
│   │       │   └── same shape as release-atomic; deterministic reap-injection
│   │       │       on the requeueForResume path
│   │       ├── redis-queue-adapter.round-trip-count.test.ts             # NEW (SC-003, SC-004)
│   │       │   └── separate plain test per Q4 rider; wrapped ioredis command
│   │       │       counter asserts exactly 1 round trip on happy path for both
│   │       │       methods (both branches of release())
│   │       ├── redis-queue-adapter.attemptcount-preservation.test.ts    # NEW (SC-005)
│   │       │   └── 100 repeated cycles asserting requeueForResume preserves
│   │       │       attemptCount bit-identical; release() increments +1 each cycle
│   │       └── redis-queue-adapter.script-wiring.test.ts                # MODIFIED
│   │           └── + assertions for RELEASE_SCRIPT + REQUEUE_FOR_RESUME_SCRIPT
│   │               following existing ENQUEUE_IF_ABSENT_SCRIPT pattern
│   ├── types/
│   │   └── monitor.ts                                                   # UNCHANGED (SC-008)
│   └── ...
├── .changeset/
│   └── 1069-atomic-release-requeue-resume.md                            # NEW (patch)
└── ...
```

## Constitution Check

`/workspaces/generacy/.specify/memory/constitution.md` — not present in this repo (verified via `ls`; only `.specify/templates/` exists per prior `git log` audit for #1060). No governing principles to check against.

## Phases

### Phase 1 — Lua-script atomicity (FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007)

1. Add `REQUEUE_FOR_RESUME_SCRIPT` constant to `redis-queue-adapter.ts`, immediately after `RECLAIM_ORPHAN_SCRIPT`. Body per `contracts/requeue-for-resume-script.md`:
   - `HGET claimed:<workerId> itemKey` → if `nil`, `DEL heartbeat` (best-effort) and return `{0, -1}` (no-op / reaper-race path).
   - Otherwise `cjson.decode(claimed)`, preserve `attemptCount` verbatim (do NOT increment — FR-003).
   - Assemble re-pend payload: `queueReason = 'resume'`, `priority = ARGV[2]`, `attemptCount = parsed.attemptCount`, `claimedAt = nil` (strip claim-lifecycle field per A6).
   - `HDEL claimed`, `DEL heartbeat`, `ZADD pending` (all inside the script, single atomic execution).
   - Return `{1, parsed.attemptCount}`.
2. Add `RELEASE_SCRIPT` constant to `redis-queue-adapter.ts`, immediately after `REQUEUE_FOR_RESUME_SCRIPT`. Body per `contracts/release-script.md`:
   - `HGET claimed:<workerId> itemKey` → if `nil`, `DEL heartbeat` (best-effort) and return `{0, -1}` (no-op / reaper-race path).
   - `cjson.decode(claimed)`, compute `attemptCount = parsed.attemptCount + 1` (FR-004).
   - If `attemptCount >= maxRetries` (ARGV): **dead-letter branch (FR-002 Q1=A)** — assemble dead-letter payload with incremented `attemptCount`, `HDEL claimed`, `DEL heartbeat`, `ZADD DEAD_LETTER_KEY`, `SREM IN_FLIGHT_KEY itemKey` (FR-006). Return `{2, attemptCount}`.
   - Otherwise **retry branch** — assemble re-pend payload with `queueReason = 'retry'`, `priority = ARGV[2]` (retryPriority), incremented `attemptCount`. `HDEL claimed`, `DEL heartbeat`, `ZADD pending` (in-flight membership preserved — no `SREM`). Return `{1, attemptCount}`.
3. Add `ensureRequeueForResumeCommand()` and `ensureReleaseCommand()` following the existing `ensureEnqueueIfAbsentCommand()` / `ensureReclaimOrphanCommand()` pattern (`redis-queue-adapter.ts:234-250`). Both use `numberOfKeys: 3` (KEYS[1] pending, KEYS[2] claimed:<workerId>, KEYS[3] heartbeat) plus `RELEASE_SCRIPT` additionally needs KEYS[4] dead-letter and KEYS[5] in-flight SET → adjust to `numberOfKeys: 5` for `RELEASE_SCRIPT`. Under Redis Cluster all declared keys must hash to the same slot; A8 asserts the set is already known-safe via `RECLAIM_ORPHAN_SCRIPT` precedent.
4. Add `_RELEASE_SCRIPT_FOR_TESTS` and `_REQUEUE_FOR_RESUME_SCRIPT_FOR_TESTS` `@internal` exports next to `_ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS` at `redis-queue-adapter.ts:67` (FR-012).

### Phase 2 — Caller rewrite of `release()` and `requeueForResume()` (FR-005, FR-007, FR-008)

5. Rewrite `release()` (`redis-queue-adapter.ts:724-813`) to invoke `RELEASE_SCRIPT` via `defineCommand` in a single call. Wrap in the existing `try { ... } catch (error) { logger.warn(...) }` shell (matches existing error contract; never throws). Switch on returned `[code, attemptCount]`:
   - `code === 0`: log the existing "release() called on already-cleared claim (reaper race) — skipping re-pend to avoid duplicate pending member" info line at `:753-756`. `attemptCount` in log payload is `undefined` (sentinel `-1` from script is not logged — matches current behaviour where the null-guard branch does not log an attempt count).
   - `code === 1`: log the existing "Item released back to pending queue" info line at `:802-805`, with `attemptCount` from tuple element 1.
   - `code === 2`: log the existing "Item dead-lettered after max retries" warn line at `:782-785`, with `attemptCount` from tuple element 1. Clear `dropLogState.delete(itemKey)` and `enqueuedAtCache.delete(itemKey)` in caller (script preserves the SREM invariant; caller preserves the in-memory bookkeeping cleanup).
6. Rewrite `requeueForResume()` (`redis-queue-adapter.ts:839-894`) analogously. Switch on `[code, attemptCount]`:
   - `code === 0`: existing "requeueForResume() called on already-cleared claim (reaper race) — skipping re-pend" info line at `:853-856`.
   - `code === 1`: existing "Item re-pended at resume priority (attemptCount preserved)" info line at `:879-887`, with `attemptCount` from tuple element 1.
7. Preserve every existing log field verbatim (`workerId`, `itemKey`, `attemptCount`, `reason: 'lease-expiry'`, `maxRetries` on dead-letter). Do not add new fields. Do not remove existing fields. FR-005 explicitly ties the tuple return to keeping the current `attemptCount` diagnostic operators depend on.
8. `InMemoryQueueAdapter` audit (FR-009): open `in-memory-queue-adapter.ts:225-328`, confirm the current log-line messages and field shapes match the ones in step 5–7 above. Expected: exact match (they were written as parity from the start). No source change; add a single `// FR-009: parity audit — no behavioural change per #1069` comment above `release()` if reviewer asks, otherwise leave file untouched. Do NOT introduce a Lua script here — the file is Redis-free by contract.

### Phase 3 — Concurrency + round-trip regression coverage (FR-010, FR-011, FR-012, SC-001, SC-002, SC-003, SC-004, SC-005)

9. Add `redis-queue-adapter.requeueForResume-atomic.test.ts` (SC-001, FR-010). Real ioredis against a live `redis:7` service (CI-provided). Two `describe` blocks:
   - **Deterministic controlled interleave**: seed a claim + heartbeat; use `redis.monitor()` or a wrapped ioredis command hook to detect the first `HGET claimed:*` from `requeueForResume` and inject a full `reapOrphanClaims()` call between the `HGET` return and the ensuing mutation window. Assert against **pre-fix code** (deleted claim → duplicate pending member appears → `ZCARD pending === 2`, both members parsed to same `itemKey`) — this MUST FAIL, proving diagnostic value. Assert against **fixed code** (script runs atomically; `HGET` inside Lua sees claim already gone; returns `{0, -1}`; `ZCARD pending === 1` because reaper's re-pend is the only writer). Wire the pre-fix run behind a `git stash`-guarded companion script or a `pre-fix-baseline.test.ts.baseline` snapshot per Q4's "demonstration is the deliverable" framing — implement note in `quickstart.md § Deterministic-interleave baseline`.
   - **Natural-race smoke test**: N=100 pairs of `Promise.all([reapOrphanClaims(), requeueForResume(workerId, item)])`, each pair starting from a fresh seeded claim. Assert `ZCARD pending === 1` after each pair (post-fix); pre-fix expected pass (this is a smoke test, not the proof, per Q4).
10. Add `redis-queue-adapter.release-atomic.test.ts` (SC-002, FR-010) — same shape as #9 for both branches of `release()`. Two additional `describe` blocks beyond the requeueForResume shape:
    - `describe('retry branch', ...)`: `attemptCount + 1 < maxRetries` seeded; deterministic interleave asserts `ZCARD pending === 1` post-fix; retry payload preserved in the single surviving pending member; in-flight SET retains `itemKey` (FR-006).
    - `describe('dead-letter branch (FR-002 Q1=A)', ...)`: `attemptCount + 1 === maxRetries` seeded; deterministic interleave asserts (post-fix) `ZCARD pending === 0` (reaper won and re-pended, but our fixed script's `HGET` inside Lua saw claim already gone and returned `{0, -1}` — deterministic pre-fix win scenario is different: reaper wins, our client-side `MULTI` fires with no-op `HDEL` + dead-letter `ZADD` + `SREM` in-flight, producing a pending member without in-flight — the invariant-violation shape called out in Clarifications Q1 answer). Assert `SISMEMBER IN_FLIGHT_KEY itemKey === 0` on dead-letter (post-fix, in the script-fired path) and `=== 1` on the reaper-won path (post-fix — script returns `{0, -1}` without touching the SET). Both branches: one round trip per Q4.
11. Add `redis-queue-adapter.round-trip-count.test.ts` (SC-003, SC-004) — **separate plain test** per Q4 rider, no concurrency harness. Wrap the ioredis client with a command counter (either `redis.monitor()` subscriber or a proxy `Redis` object). Assert one round trip for happy paths:
    - `requeueForResume` success path: exactly 1 command reaching Redis (the `EVALSHA` of `REQUEUE_FOR_RESUME_SCRIPT`), excluding the null-guard `DEL heartbeat` on the reaper-wins path.
    - `release` retry branch success: exactly 1 command (`EVALSHA` of `RELEASE_SCRIPT`).
    - `release` dead-letter branch success: exactly 1 command (`EVALSHA` of `RELEASE_SCRIPT`) — this is the load-bearing SC-004 assertion Q1=A guarantees by folding the dead-letter branch into the same script.
12. Add `redis-queue-adapter.attemptcount-preservation.test.ts` (SC-005). Real ioredis. 100 repeated lease-expiry cycles: `enqueueIfAbsent → claim → requeueForResume → claim`, assert on every cycle that `parsed.attemptCount` post-re-pend equals `parsed.attemptCount` pre-re-pend. Complement: 100 cycles of `enqueueIfAbsent → claim → release-retry → claim`, assert `attemptCount` increments by exactly one each cycle. Complement: single cycle of `enqueueIfAbsent → claim → release × maxRetries`, assert dead-letter on the exact `maxRetries`-th call (SC-006).
13. Extend `redis-queue-adapter.script-wiring.test.ts` (FR-012). For each new script:
    - Static text assertions: `HGET`, `HDEL`, `ZADD`, `DEL`, and (for `RELEASE_SCRIPT`) `SREM` present in the correct order.
    - `KEYS[N]` / `ARGV[N]` positional references match the contract.
    - `defineCommand('release', { numberOfKeys: 5, lua: RELEASE_SCRIPT })` and `defineCommand('requeueForResume', { numberOfKeys: 3, lua: REQUEUE_FOR_RESUME_SCRIPT })` wire-up assertion (minimal-mock harness pattern from the existing file at lines 77–158).
    - Return-tuple shape assertion: script text contains `return {1, parsed.attemptCount}` (or equivalent) for the mutate branches.
14. Verify no regression against existing `redis-queue-adapter.enqueueIfAbsent.test.ts`, `redis-queue-adapter.orphan-reclaim.test.ts`, `redis-queue-adapter.enqueue-invariant.test.ts`, `queue-adapter-parity.test.ts` (SC-007). No source change is expected to touch code these files cover, but the `defineCommand` cache (`this.redis.defineCommand`) is now called for two additional commands; verify no shared-state collision.

### Phase 4 — Changeset and publication

15. Author `.changeset/1069-atomic-release-requeue-resume.md`. `@generacy-ai/orchestrator` **patch** — SC-008 asserts zero public API signature change on `QueueManager`; both methods keep `Promise<void>` return contract (FR-008). This is an internal correctness fix with no consumer-visible surface change. Verify with `pnpm why @generacy-ai/orchestrator` at implement time — if any monorepo sibling declares it in `dependencies` AND depends on the specific log-line count or timing behaviour, upgrade to **minor**; that is not expected given SC-007 preserves existing behavioural coverage.

---

*Generated by speckit*
