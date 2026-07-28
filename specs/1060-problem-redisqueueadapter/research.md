# Research: RedisQueueAdapter.enqueue() in-flight-SET invariant

## Decision 1 — Fifth Lua script (`ENQUEUE_SCRIPT`) via `defineCommand`

**Chosen**: Add a new `ENQUEUE_SCRIPT` string constant next to the existing four (`ENQUEUE_IF_ABSENT_SCRIPT`, `CLAIM_SCRIPT`, `RELEASE_SCRIPT` (implicit in `release()`), `RECLAIM_ORPHAN_SCRIPT`). Register with `redis.defineCommand('enqueueItem', { numberOfKeys: 3, lua: ENQUEUE_SCRIPT })` behind an `ensureEnqueueCommand()` guard following the sibling `ensureEnqueueIfAbsentCommand()` at `redis-queue-adapter.ts:209-216`.

**Rationale**: FR-001 demands co-atomic `SISMEMBER` + `SADD` + `ZADD` (+ `HSET _dedup:*`). Only a single Lua-script invocation satisfies that under `EVALSHA`. The codebase's four existing scripts follow this exact pattern; a fifth is zero net dependency surface and reuses the `defineCommand` cache. Reviewer touching this code understands the pattern by inspection — no novel primitive introduced.

**Alternatives considered**:

- **Two round-trips (`SISMEMBER` then `SADD`+`ZADD`)** — rejected. Transient window between `SISMEMBER` returning 0 and `SADD` firing. A concurrent `enqueueIfAbsent` in that window sees the SET without the pending entry and adds a duplicate that our subsequent atomic `enqueue()` re-adds as a `SADD` no-op but `ZADD`s a second member. Reproduces the exact bug we're fixing.
- **`WATCH`/`MULTI`/`EXEC` transaction** — rejected. Retry-on-`WATCH`-failure adds a client-side loop, doubles the RTT budget in the collision case, and diverges from the "one Lua script per atomic sequence" convention every other adapter method already follows.
- **Client-side `SISMEMBER` fast-path + Lua for the mutation** — rejected. Race identical to the two-round-trip alternative; the "fast path" turns into "wrong path" the moment two intake sites fire the same tick.
- **Defensive `SADD` inside `CLAIM_SCRIPT`** — rejected. FR-004 explicitly forbids it. Masks the `enqueue()` bug at a location that shouldn't be responsible for it and creates a two-writer story for the in-flight SET where today there is exactly one legitimate writer per verb.

**Sources**: `redis-queue-adapter.ts:34-42` (`ENQUEUE_IF_ABSENT_SCRIPT` shape), `redis-queue-adapter.ts:227-287` (register + invoke pattern), `redis-queue-adapter.ts:107-129` (`RECLAIM_ORPHAN_SCRIPT` return-code enum precedent).

## Decision 2 — `Promise<boolean>` return type on both adapters

**Chosen**: `QueueManager.enqueue(item): Promise<boolean>` (`true` = enqueued, `false` = dropped-in-flight). `QueueAdapter.enqueue` migrates in lockstep. Both adapters return the same shape.

**Rationale**: Clarifications Q1 = A. The `enqueueIfAbsent(item): Promise<boolean>` sibling already lives at `types/monitor.ts:314`; parity is the point of this spec's cross-adapter agreement (US3). Once both verbs return the same shape, they differ only in caller *intent* — `enqueue`: caller inspects the boolean to decide next steps; `enqueueIfAbsent`: caller ignores drops — not in observable behaviour. The two live callers of `enqueue()` (`LabelMonitorService` and `WorkerDispatcher.handleLeaseExpired`) both need the drop signal; `Promise<void>` cannot provide it.

**Alternatives**: Q1 options B (`'enqueued' | 'already-in-flight'` string enum) and C (discriminated union with echoed `itemKey`) — rejected in clarifications for divergence from the sibling verb.

## Decision 3 — `handleLeaseExpired` sequencing: `release()` then `enqueue()`

**Chosen**: `handleLeaseExpired` calls `queue.release(workerId, worker.item)` before calling `queue.enqueue(...)`. Per clarifications Q2 = A. The subsequent `enqueue()` call becomes redundant (the `release()` retry branch already re-pends via `HDEL`/`DEL`/`ZADD pending`) and will be dropped by the new FR-002 dedupe; annotate or remove.

**Rationale**: After FR-001 the itemKey is still in the in-flight SET after a lease expiry (`CLAIM_SCRIPT` preserves it — this is load-bearing for `RECLAIM_ORPHAN_SCRIPT`). It is also still in the claimed hash because no `release()` fired. A direct `enqueue()` in that state hits the new dedupe and gets silently dropped, leaving the item orphan-claimed with no live worker — recreating the #1054 wedge shape this fix sits next to. Q2 = A pre-empts the recovery-loop reintroduction of the #1054 wedge by making the recovery path funnel through the mechanism that already correctly clears the claim (`release()`'s retry branch).

**Alternatives**:

- **B (delegate to `RECLAIM_ORPHAN_SCRIPT`)** — viable now that PR #1056 merged as `afab7d58`, but couples this change to reaper scheduling for no benefit over A.
- **C (fire-and-forget, reaper handles it)** — rejected. Lease expiry and heartbeat expiry are separate mechanisms; a lease can expire while the heartbeat is still live, and in that window the reaper's `EXISTS heartbeat` guard refuses to touch the item. Item wedges silently.
- **D (new `reclaim()` verb on `QueueManager`)** — rejected as interface bloat overlapping #1056.

**Implementation caveat**: today's `WorkerDispatcher.handleLeaseExpired` calls `queue.enqueue({ ...worker.item, priority: 0, queueReason: 'resume', ... })`. `queue.release()` does not accept a caller-supplied priority — its retry branch hardcodes `getPriorityScore('retry')` (`redis-queue-adapter.ts:692`, `in-memory-queue-adapter.ts:258`). Clarification Q2 = A's "the priority-0 `queueReason: 'resume'` intent that the current `enqueue()` carries is instead carried by `release()`'s `retryPriority` argument" describes an argument that does not exist on either adapter today. **Resolution at implement time**:

- **Option R1 (recommended)**: leave `release()` unchanged and let the retry-priority difference stand — a re-enqueued item takes `retry` priority (score ~1.x) instead of `resume` priority (score ~0.x). Cost: lease-expired items dispatch behind fresh `resume` events by ~1 priority tier — matches how the queue already treats any retry.
- **Option R2**: add an optional `retryPriorityOverride?: QueueReason` argument to `release()`. Small interface change; touches both adapters and the interface at `types/monitor.ts:288`. This is a spec-adjacent minor extension that clarifications Q2 = A anticipated but no FR/AC was written for.
- **Option R3**: keep the redundant `enqueue()` call after `release()`. It will be dropped by FR-002 — but the release itself has already re-pended, so state is correct. This is the "leave a comment" outcome the plan/spec allow.

**Recommendation**: R1 for this PR. If ops feedback shows `resume` priority is load-bearing, follow up with R2.

**Sources**: `worker-dispatcher.ts:245-278` (current `handleLeaseExpired` shape); `redis-queue-adapter.ts:653-717` (`release()` retry branch); `in-memory-queue-adapter.ts:222-272` (in-memory `release()` retry branch); `redis-queue-adapter.ts:82-90` (CLAIM_SCRIPT preserves in-flight SET); `redis-queue-adapter.ts:377-577` (`reapOrphanClaims` heartbeat gate).

## Decision 4 — Adapter-side logging only (FR-005 amendment)

**Chosen**: The FR-002 drop log fires **only** in the adapter, via `emitDropLog` (`drop-log-helper.ts::emitDropLog`). `LabelMonitorService` and `WorkerDispatcher.handleLeaseExpired()` observe the boolean without re-logging. Clarifications Q4 = A.

**Rationale**: One line per drop, consistent across `enqueue` and `enqueueIfAbsent`. #1056's transition-edge throttling in `drop-log-helper.ts::classifyDropSeverity` fires inside the adapter — caller-side logging bypasses it and reintroduces the per-cycle log-volume failure that hid #1054 originally (17 identical warns over 84 minutes). Adapter-side logging inherits transition-edge throttling for free.

**Alternatives**: Q4 option B (caller-only), C (both — two lines per drop). Both rejected in clarifications for the volume-failure regression risk.

**Field shape**: `{ itemKey, source: 'enqueue' | 'enqueueIfAbsent', reason: 'in-flight' }` at minimum, plus the existing `ageMs` field emitted by `enqueueIfAbsent` today. Matches the four monitor-site drop lines at `pr-feedback-monitor-service.ts:428`, `merge-conflict-monitor-service.ts:186`, `clarification-answer-monitor-service.ts:240`, `label-monitor-service.ts:361`.

## Decision 5 — Silent drop on priority collision

**Chosen**: A dropped `enqueue()` never upgrades the existing entry's priority regardless of the new call's `priority` / `queueReason`. Clarifications Q3 = A.

**Rationale**: Q2 = A (the `handleLeaseExpired` `release()`-first change) largely defuses the motivating priority-upgrade case — the priority-0 `resume` intent that `handleLeaseExpired` used to carry via `enqueue()` is now carried by `release()`'s retry branch. Q3-B (branch in Lua to upgrade on lower-priority-in-pending) adds conditional logic for a collision that mostly stops arising after Q2 = A. Q3-A matches `enqueueIfAbsent` semantics exactly, preserving the parity FR-006 asserts.

**Documented rule**: "In-flight is in-flight; a priority upgrade requires release-then-enqueue."

## Decision 6 — `_dedup:<itemKey>` inside the Lua body (with discrepancy note)

**Chosen**: The new `ENQUEUE_SCRIPT` writes `HSET _dedup:<itemKey> ...` inside the Lua body on the success path. Clarifications Q5 = A.

**Discrepancy** (⚠ implementer must reconcile): Spec §Ruled out and Assumption §128 both describe `_dedup:<itemKey>` as "populated in `enqueue()` today" and used by `getDedupKey()` for cross-adapter observability. **Neither exists in the current code**. `grep -rn '_dedup\|getDedupKey' packages/orchestrator/src/` returns zero matches. The current `enqueue()` at `redis-queue-adapter.ts:579-601` only runs `zadd(PENDING_KEY, ...)`. `RedisQueueAdapter` has no `getDedupKey` method; `QueueManager` interface has no `getDedupKey` field.

**Resolution direction**:

- **D6-a (default — follow spec literally)**: Add the `HSET _dedup:<itemKey>` write inside the new Lua body per FR-001. Fields to write: at minimum `{ itemKey, queueReason, priority, enqueuedAt, attemptCount }` — a compact reflection of the ZSET member's key attributes for future observability tooling. TTL: match the in-flight SET's lifetime (no TTL — cleared by `complete()`/dead-letter — but `_dedup` is a hash, so add `SREM`-paired `DEL _dedup:<itemKey>` calls to `complete()`, `release()`'s dead-letter branch, and `reapOrphanClaims`'s reclaim path). This grows the scope of "additive to `enqueue()` only" that FR-004 defines.

- **D6-b (recommended — accept the discrepancy, defer `_dedup`)**: Skip the `HSET _dedup:*` write entirely. FR-001's correctness content (`SADD IN_FLIGHT_KEY` co-atomic with `ZADD pending`) is fully delivered; `_dedup` was a spec-drafting artifact from an earlier version of the code and has no live consumer. Update spec at merge time (or in a follow-up) to strike the `_dedup` references. Rationale: FR-004 constrains the fix to be "additive to `enqueue()` — the existing scripts and paths are load-bearing for the healthy path". D6-a expands the diff into `complete()`, `release()`, and `reapOrphanClaims` for observability-only fields with no consumer, which reads as scope creep against FR-004.

**Plan recommendation**: **D6-b** — implement the Lua body without the `_dedup` write, and flag the spec discrepancy in the PR description. This is the reading that best honours FR-004 as the tighter constraint. If reviewer prefers strict FR-001 compliance, D6-a is a mechanical addition (three lines in `ENQUEUE_SCRIPT`, three matching `DEL` calls at cleanup sites); revert to D6-a in that case.

**Sources**: `redis-queue-adapter.ts:579-601` (current `enqueue()`); `grep _dedup packages/orchestrator/` → 0 matches (verified 2026-07-28).

## Decision 7 — Real-Redis integration tests over ioredis-mock

**Chosen**: The FR-007 / FR-008 regression tests use the existing real-Redis test infrastructure (`redis-queue-adapter.enqueueIfAbsent.test.ts` pattern uses a manual mock; `redis-queue-adapter.orphan-reclaim.test.ts` uses real ioredis against a live Redis).

**Rationale**: A mocked SET/HASH would not catch a mis-issued `SADD`/`SREM` command shape — which is exactly the class of bug we're fixing (`enqueue()` today issues no `SADD` at all). The mock in `redis-queue-adapter.enqueueIfAbsent.test.ts` handles the *Lua-script side-effect model* correctly for its narrow use, but adding a fifth script's semantics to that mock duplicates the actual Lua logic and lets a script bug slip through. Real Redis is the honest test.

**Test file split**:

- **`redis-queue-adapter.enqueue-invariant.test.ts`** — real Redis. Covers FR-007 (invariant across sequence) + FR-008 (named wedge regression).
- **`in-memory-queue-adapter.enqueue-invariant.test.ts`** — no infrastructure needed. Same FR-007 sequence against `InMemoryQueueAdapter`.
- **`queue-adapter-parity.test.ts`** — parameterized `describe.each([['redis', redisFactory], ['in-memory', inMemoryFactory]])`. Asserts identical drop-vs-accept + log-line shape across the FR-007 sequence. Satisfies SC-003 in one file.

## Decision 8 — Changeset severity: patch vs. minor

**Chosen**: `patch` bump on `@generacy-ai/orchestrator`.

**Rationale**: The `QueueManager.enqueue` type change (`Promise<void>` → `Promise<boolean>`) is a public-facing signature change. `@generacy-ai/orchestrator` is consumed only by other packages inside this monorepo. Both callers of `enqueue()` are in-package. `pnpm why @generacy-ai/orchestrator` at implement time confirms no external consumers.

**Verification**: at implement time, run `pnpm why @generacy-ai/orchestrator`. If any *sibling* package in the monorepo declares it in `dependencies` (not `devDependencies`), audit that package's call sites; upgrade the bump to `minor` if any call site depends on `enqueue()` treating `undefined` as success.

**File**: `.changeset/1060-redis-enqueue-invariant.md` — single file per the CLAUDE.md gate. Bump line: `'@generacy-ai/orchestrator': patch`.

## Implementation patterns to reuse

- **Lua script constant + `ensureXCommand()` guard**: `redis-queue-adapter.ts:34-42` + `209-216` for `ENQUEUE_IF_ABSENT_SCRIPT`, and the parallel patterns for `CLAIM_SCRIPT` and `RECLAIM_ORPHAN_SCRIPT`.
- **Return-code enum inside Lua**: `RECLAIM_ORPHAN_SCRIPT` returns 0/1/2/3 (`redis-queue-adapter.ts:100-106`). `ENQUEUE_SCRIPT` returns 0 (dropped-in-flight) / 1 (enqueued) — matches `ENQUEUE_IF_ABSENT_SCRIPT`'s 0/1 semantics exactly.
- **Drop-log emit + transition-edge throttling**: `redis-queue-adapter.ts:265-277` + `in-memory-queue-adapter.ts:112-124` for `enqueueIfAbsent`. `enqueue()`'s drop path funnels through the identical two-line pattern (`classifyDropSeverity` + `emitDropLog`) so severity + shape are identical (SC-003).
- **In-flight-SET-based `hasInFlightAge`**: `redis-queue-adapter.ts:317-375`. The drop path in the new `enqueue()` calls the same `hasInFlightAge` to fill the `ageMs` field.
- **Real-Redis integration test harness**: `redis-queue-adapter.orphan-reclaim.test.ts` — existing pattern for a live-Redis test file with the invariant assertions we need.

## Non-goals reaffirmed (from spec §Out of Scope)

- Age-based severity escalation (owned by #1054/PR #1056; inherited via `emitDropLog`).
- `_dedup:*` as a dedupe-gate participant (deferred; see D6).
- Collapsing `enqueue()` and `enqueueIfAbsent()` into one method with a flag (code-shape question).
- Admin CLI/route for inspecting the queue.
- Cloud-side alerting.
