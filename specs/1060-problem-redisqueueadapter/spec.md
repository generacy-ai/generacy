# Feature Specification: RedisQueueAdapter.enqueue() must maintain the in-flight-SET invariant on the primary intake path

**Branch**: `1060-problem-redisqueueadapter` | **Date**: 2026-07-28 | **Status**: Draft | **Issue**: [#1060](https://github.com/generacy-ai/generacy/issues/1060)

## Summary

`RedisQueueAdapter.enqueue()` (`packages/orchestrator/src/services/redis-queue-adapter.ts`) adds an item to `orchestrator:queue:pending` via `ZADD` but never adds the corresponding `itemKey` to `orchestrator:queue:in-flight-items`, and applies no dedupe. This breaks the invariant `in-flight = pending ∪ claimed` on the **dominant** intake path — the `process:<workflow>` label route driven by `LabelMonitorService`, which is how most work enters the queue. Every other adapter operation (`ENQUEUE_IF_ABSENT_SCRIPT`, `CLAIM_SCRIPT`, `release()`'s retry and dead-letter branches, `complete()`) honours the invariant; only `enqueue()` violates it. Once an item is enqueued via this path and then claimed, its `itemKey` is absent from the in-flight SET, so any concurrent monitor calling `enqueueIfAbsent()` for the same issue passes the `SISMEMBER` guard, `SADD`s + `ZADD`s a **second distinct pending member** (member strings differ across `queueReason`/`priority`/`enqueuedAt`/`attemptCount`), and a second worker is dispatched against the same issue. On 2026-07-28 at ~15:18Z a variant of this shape produced **four concurrent claims across two issues** (`generacy-ai/generacy#1053` held by two workers, `#1054` by two more) on the tetrad-development cluster; blast radius was limited only because the duplicate runs happened to converge on a comment-only change. The sibling `InMemoryQueueAdapter.enqueue()` correctly dedupes against pending + claimed *and* adds to its `inFlightSet` — the two adapters disagree, and only the Redis one is wrong. This spec restores the invariant on `enqueue()`, closes the primary intake path's dedupe hole, and adds a direct test of the invariant so it stops being implied by the scripts.

## Problem

Four architectural facts combine to produce the failure mode:

1. **`enqueue()` is unguarded.** `RedisQueueAdapter.enqueue()` runs `ZADD pending <score> <member>` and returns. No `SADD IN_FLIGHT_KEY itemKey`, no `SISMEMBER` dedupe check against pending, no dedupe check against claimed. This is unique to the Redis adapter — the sibling `InMemoryQueueAdapter.enqueue()` does both (dedupes against `pendingQueue` + `claimedItems`, then `this.inFlightSet.add(itemKey)`).

2. **The `process` intake path routes through the unguarded `enqueue()`.** `LabelMonitorService.processLabelEvent()`'s `type === 'process'` branch (the `process:<workflow>` label handler) enqueues via `QueueManager.enqueue()`. Same for `WorkerDispatcher`'s lease-expiry re-enqueue path (`worker-dispatcher.ts:267`). Every other intake path (four monitor sites: PR-feedback, clarification, merge-conflict, and label-monitor's `type === 'resume'` branch) uses `enqueueIfAbsent()`, which is guarded by `ENQUEUE_IF_ABSENT_SCRIPT`'s `SISMEMBER` check followed by `SADD` + `ZADD` — the correct pattern.

3. **`claim()` deliberately leaves the in-flight member.** `CLAIM_SCRIPT` moves an item pending → claimed and **does not** `SREM` the itemKey from the in-flight SET. That is intentional and load-bearing — the SET is the "in flight = pending ∪ claimed" index, so a claimed item still counts as in-flight, and a concurrent `enqueueIfAbsent` for the same key correctly declines. This design relies on the item having been added to the SET at enqueue time. When `enqueue()` skips that step, `claim()` cannot repair it; the item lives in the claimed hash with no in-flight membership.

4. **Redis ZSET members are opaque strings, not itemKey-keyed.** A ZSET pending entry is the JSON-serialized `SerializedQueueItem`, not just the itemKey. Two enqueues for the same issue with different `queueReason` / `priority` / `enqueuedAt` / `attemptCount` produce two distinct member strings; without the SET-level dedupe, both live in pending as separate entries. The dispatcher then picks each independently and issues two claims for the same issue.

### Failure sequence

1. `process:speckit-feature` label lands on `#N`. `LabelMonitorService` calls `queueManager.enqueue({ itemKey: "owner/repo#N", ... })`.
2. `RedisQueueAdapter.enqueue()` runs `ZADD pending <score> <member>`. `SADD IN_FLIGHT_KEY "owner/repo#N"` never fires. `SISMEMBER IN_FLIGHT_KEY "owner/repo#N"` returns 0.
3. Dispatcher claims. `CLAIM_SCRIPT` moves the member from pending to the claimed hash. It does not add to the in-flight SET (by design — `enqueue()` was supposed to have done that). `SISMEMBER` still returns 0.
4. Any monitor using `enqueueIfAbsent` (PR-feedback fires on review activity, clarification fires on clarification-answered comments, merge-conflict fires on push events, label-monitor `resume` fires on `waiting-for:*` label removal) resolves the same itemKey. `ENQUEUE_IF_ABSENT_SCRIPT` runs `SISMEMBER` → 0 → passes the guard → `SADD` + `ZADD` a second pending member.
5. Two workers claim, two workers dispatch, two workers push to the same branch. Conflicting pushes; whichever commits second wins/loses depending on ordering. Even when both write the same content, the label-state churn (`agent:in-progress` add/remove races) surfaces as flapping.

### Observed incident (2026-07-28 ~15:18Z, tetrad-development cluster)

`orchestrator:queue:in-flight-items` was empty at the moment the monitors fired. Four concurrent claims resulted:

- `generacy-ai/generacy#1053`: two workers with live heartbeats holding two distinct claims.
- `generacy-ai/generacy#1054`: two workers with live heartbeats holding two distinct claims.

The trigger for the observed incident was an out-of-band `DEL` of the in-flight SET (external state cleanup during `#1054` debugging), not the routine `enqueue()` bug — but the state produced by that `DEL` is byte-for-byte the state `enqueue()` produces on every routine use: an item in the claimed hash with no in-flight-SET membership. The distinction between the two triggers is diagnostic, not architectural. Every routine use of the `process` path produces a latent version of the same wedge shape; the observed incident merely amplified it. Blast radius was small — the duplicate runs converged on a comment-only change — but that is a lucky-throw, not a design property.

### Relationship to #1054 (PR #1056)

Adjacent, not overlapping. `enqueue()`'s bug is pre-existing; PR #1056 does not touch it. PR #1056's `RECLAIM_ORPHAN_SCRIPT` for orphaned claims deliberately omits the `SREM` so the item stays in the in-flight SET while re-pended — the design is correct and depends on the item having been in the SET to begin with. That premise holds for items enqueued via `enqueueIfAbsent()`, and fails for items enqueued via `enqueue()`. PR #1056 should merge on its own merits; this spec closes the adjacent hole that PR #1056 does not (and should not) cover.

### Ruled out

- **Not a race in `enqueueIfAbsent`.** The double-enqueue is the *correct* behaviour of `enqueueIfAbsent` given the corrupt state upstream — `SISMEMBER` says "not in flight", so `SADD` + `ZADD` runs. The bug is in `enqueue()`'s failure to establish the state `enqueueIfAbsent` expects, not in `enqueueIfAbsent`'s handling of it.
- **Not a `CLAIM_SCRIPT` bug.** `CLAIM_SCRIPT`'s intentional non-`SREM` is correct and load-bearing (see #1054/PR #1056). Adding a defensive `SADD` inside `CLAIM_SCRIPT` would mask the `enqueue()` bug at a location that should not be responsible for it.
- **Not solvable by the `_dedup:*` marker hash.** `RedisQueueAdapter` maintains a `_dedup:<itemKey>` hash for cross-adapter observability (used by `getDedupKey`); this hash is populated in `enqueue()` today but does not participate in the `enqueueIfAbsent` gate — `ENQUEUE_IF_ABSENT_SCRIPT` reads only `IN_FLIGHT_KEY`. Rewiring `_dedup` into the gate is a larger refactor with unclear semantics (which fields should collide? how does it interact with `release()`?) — out of scope. The fix should route through the existing `IN_FLIGHT_KEY` mechanism that every other path already uses.

## User Stories

### US1: Every enqueue leaves the in-flight invariant intact

**As** an operator running the orchestrator cluster,
**I want** `RedisQueueAdapter.enqueue()` to maintain the same `in-flight = pending ∪ claimed` invariant that every other adapter operation already honours,
**So that** the primary intake path (`process:<workflow>` label route) does not silently corrupt the state that the dedupe guard relies on.

**Acceptance Criteria**:
- [ ] After `enqueue({ itemKey })` returns success, `SISMEMBER orchestrator:queue:in-flight-items itemKey` is 1.
- [ ] After a subsequent `claim()` moves the item to the claimed hash, `SISMEMBER orchestrator:queue:in-flight-items itemKey` is still 1 (the SET tracks the union; claiming does not remove).
- [ ] After `complete()` or `release()`'s dead-letter branch, `SISMEMBER orchestrator:queue:in-flight-items itemKey` is 0.
- [ ] After `release()`'s retry branch (re-pend), `SISMEMBER orchestrator:queue:in-flight-items itemKey` remains 1 (retry preserves in-flight membership).
- [ ] The invariant holds across a representative end-to-end sequence: `enqueue → claim → release-retry → reclaim-orphan → complete` (composing this spec with PR #1056's `RECLAIM_ORPHAN_SCRIPT`). After each step, `in-flight = pending ∪ claimed` as a set equality.

### US2: The primary intake path dedupes duplicate enqueues

**As** the queue manager,
**I want** a second `enqueue()` for an itemKey that is already in-flight to be dropped (not appended as a second pending entry),
**So that** the `process:<workflow>` label path cannot silently produce two concurrent workers on the same issue when the same label transition fires twice (label churn, replay, monitor overlap with an already-claimed item).

**Acceptance Criteria**:
- [ ] A second `enqueue()` for an `itemKey` currently in-flight (either in pending or in the claimed hash) is dropped: it does not add a second pending member, does not modify the claimed hash, and returns a result distinguishable from a successful enqueue (see FR-002 for the return-shape contract).
- [ ] After `enqueue()` places an item in pending, a subsequent `enqueueIfAbsent()` for the same itemKey is also dropped (not double-added) — the two paths' dedupe agrees.
- [ ] After `claim()` moves the item to claimed, a subsequent `enqueue()` for the same itemKey is dropped (still in-flight, not eligible to re-enqueue). Re-enqueue after claim requires the caller to first `release()` or `complete()`.
- [ ] The drop is logged (severity per FR-005) with `{ itemKey, source: 'enqueue' | 'enqueueIfAbsent', reason: 'in-flight' }` fields, matching the shape used by the four monitor-side drop sites (`pr-feedback-monitor-service.ts:428`, `merge-conflict-monitor-service.ts:186`, `clarification-answer-monitor-service.ts:240`, `label-monitor-service.ts:361`) so operators querying for the wedge pattern find both.

### US3: Both queue adapters agree on `enqueue()` semantics

**As** a future engineer switching between adapters or writing tests against either,
**I want** `RedisQueueAdapter.enqueue()` and `InMemoryQueueAdapter.enqueue()` to have identical observable behaviour,
**So that** tests written against one adapter catch bugs in the other, and a switch from in-memory (dev/test) to Redis (prod) does not silently change queue semantics.

**Acceptance Criteria**:
- [ ] `InMemoryQueueAdapter.enqueue()` and `RedisQueueAdapter.enqueue()` produce identical outcomes for every representative sequence: same drop-vs-accept decision, same in-flight-SET membership after each operation, same log-line shape.
- [ ] The `QueueManager` interface contract (existing `packages/orchestrator/src/services/queue-manager.ts`) documents the invariant that both adapters must maintain: `after enqueue(itemKey), itemKey ∈ inFlightSet`.
- [ ] A shared test suite (parameterized over both adapters) asserts the invariant across the FR-006 sequence. The Redis case uses the existing real-Redis test infrastructure (`redis-queue-adapter.*.test.ts` pattern); the in-memory case runs against `InMemoryQueueAdapter` directly.

### US4: The regression that would have caught this ships with the fix

**As** a future engineer refactoring `RedisQueueAdapter` or its Lua scripts,
**I want** a test that fails if `enqueue()` regresses to `ZADD`-only,
**So that** the invariant is guarded by CI, not by scripture in the surrounding scripts.

**Acceptance Criteria**:
- [ ] A regression test asserts: after `enqueue({ itemKey: 'owner/repo#N' })`, `SISMEMBER orchestrator:queue:in-flight-items owner/repo#N` returns 1.
- [ ] A regression test asserts: after `enqueue({ itemKey: 'owner/repo#N' })` followed by `enqueueIfAbsent({ itemKey: 'owner/repo#N' })`, the second call is dropped and `ZCARD orchestrator:queue:pending` remains 1.
- [ ] A regression test asserts the incident-reproducing sequence: `enqueue(#N)` → `claim(worker-A)` → concurrent monitor calls `enqueueIfAbsent(#N)` → the monitor call is dropped, and only one claim exists for `#N` at every step.
- [ ] A regression test asserts the end-to-end invariant equality: after `enqueue → claim → release-retry → reclaim-orphan → complete`, `in-flight = pending ∪ claimed` as a set at every intermediate step.
- [ ] Deleting the `SADD IN_FLIGHT_KEY` from `enqueue()` (the exact regression this spec fixes) causes at least one of the above tests to fail.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `RedisQueueAdapter.enqueue()` must add the itemKey to `orchestrator:queue:in-flight-items` before returning success. The `ZADD` to `orchestrator:queue:pending` and the `SADD` to `orchestrator:queue:in-flight-items` must be **co-atomic** (single Lua script invocation via `EVAL`/`EVALSHA`, matching the codebase's established `CLAIM_SCRIPT` / `RELEASE_SCRIPT` / `ENQUEUE_IF_ABSENT_SCRIPT` pattern). A concurrent `enqueueIfAbsent` or `claim` observing an in-flight-SET-only membership without a matching pending entry (or vice versa) is a forbidden state. | P1 | Direct restoration of the invariant. Atomicity is load-bearing — a two-round-trip `SADD` + `ZADD` sequence would produce a transient window during which `enqueueIfAbsent` sees the SET member without the pending entry, and could `SADD` a duplicate that the atomic `enqueue()` then also `SADD`s (no-op) but `ZADD`s over. Lua co-atomicity closes the window. |
| FR-002 | `RedisQueueAdapter.enqueue()` must reject a second enqueue for an itemKey currently in-flight. The rejection path executes inside the same Lua script from FR-001: if `SISMEMBER IN_FLIGHT_KEY itemKey` returns 1 at the top of the script, the script returns an `already-in-flight` result code without mutating `pending`, `in-flight-items`, or `_dedup:*`. The caller receives a return shape that distinguishes "enqueued" from "dropped-in-flight" (see clarifications Q1). Callers that assume `enqueue()` always succeeds (`LabelMonitorService.processLabelEvent()`'s `type === 'process'` branch; `WorkerDispatcher.handleLeaseExpired()`) must be updated to log the drop at the FR-005 severity and continue; treating drop as failure would surface as spurious retries. | P1 | US2. The dedupe check runs inside the same Lua body as the write, so no `WATCH`/`MULTI` or double round-trip. Aligns `enqueue()` with `enqueueIfAbsent()` — the two verbs now differ only in whether the caller intends to require presence (`enqueue`) vs. tolerate absence (`enqueueIfAbsent`); today's difference (drop-vs-add) becomes a caller-observable return code, not silent divergent behaviour. |
| FR-003 | The two direct callers of `enqueue()` (`LabelMonitorService.processLabelEvent()` `type === 'process'` branch at `label-monitor-service.ts`; `WorkerDispatcher.handleLeaseExpired()` re-enqueue path at `worker-dispatcher.ts:267-273`) must be updated to consume FR-002's return code. On `already-in-flight`, they log at the FR-005 severity with `{ itemKey, source: 'enqueue', reason: 'in-flight' }` fields and treat the outcome as success (the item is in-flight; the enqueue's intent is satisfied by the existing membership). On `enqueued`, behaviour is unchanged. | P1 | Prevents the dedupe hardening from surfacing as spurious retries or `error` logs on the primary intake path. |
| FR-004 | Zero change to `CLAIM_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, `RELEASE_SCRIPT`, `release()`, `complete()`, `getDedupKey()`, or `handleLeaseExpired`'s claim-side logic. The fix is additive to `enqueue()` — the existing scripts and paths are load-bearing for the healthy path and modifying them risks new races. Do not modify `_dedup:*` semantics; the `_dedup` hash remains an observability artifact of `enqueue()`, not a participant in the dedupe gate. | P1 | Bounds blast radius. Preserves the FR-001 relationship with PR #1056's `RECLAIM_ORPHAN_SCRIPT` (which relies on the in-flight SET being populated at enqueue time — this spec makes that reliably true). |
| FR-005 | The FR-002 drop log line and the FR-003 caller-side drop lines default to `info` severity, matching the existing four monitor-site drop lines (`pr-feedback-monitor-service.ts:428`, `merge-conflict-monitor-service.ts:186`, `clarification-answer-monitor-service.ts:240`, `label-monitor-service.ts:361`) which are `info`-tier. Severity escalation on age is out of scope — that is #1054/PR #1056's FR-006/FR-007 concern, which applies uniformly once implemented. The log line must be machine-parseable: `{ itemKey, source: 'enqueue' | 'enqueueIfAbsent', reason: 'in-flight' }` fields at minimum. | P2 | Keeps the drop signal consistent across the seven adapter/monitor sites so alerting rules key on one shape. Deferring severity escalation avoids coupling this fix to #1054/PR #1056's transition-edge machinery. |
| FR-006 | `InMemoryQueueAdapter.enqueue()`'s existing dedupe and in-flight-set-add behaviour is preserved unchanged. The `QueueManager` interface contract (`packages/orchestrator/src/services/queue-manager.ts` — the interface both adapters implement) must be updated to document the invariant `after enqueue(itemKey), itemKey ∈ inFlightSet` and the FR-002 return-shape contract (`enqueued` vs. `already-in-flight`) so both adapters are held to the same public contract. | P1 | US3. Locks in cross-adapter parity in the type system, not just in behavioural test agreement. |
| FR-007 | A parameterized regression test suite runs both adapters through an identical end-to-end sequence (`enqueue → claim → release-retry → reclaim-orphan → complete`) and asserts the FR-006 invariant `in-flight = pending ∪ claimed` at every intermediate step, plus the FR-002 dedupe (`enqueue → enqueue same key` → second call returns `already-in-flight` and does not double-add). Redis-adapter case uses the existing real-Redis test infrastructure (`redis-queue-adapter.*.test.ts` pattern — mocked SET/HASH would not catch a mis-issued `SADD`/`SREM` command shape). In-memory case runs directly against `InMemoryQueueAdapter`. The `reclaim-orphan` step composes with PR #1056; if PR #1056 has not yet landed at merge time of this spec, the test uses a synthetic reclaim (direct Redis writes) that produces the equivalent state. | P1 | US4 + US3. Direct assertion of the invariant, not implied by the scripts. Cross-adapter parameterization catches divergence in either direction. |
| FR-008 | A minimal targeted test asserts the exact wedge shape from the observed incident: after `enqueue({ itemKey: 'owner/repo#N' })` + `claim(worker-A, itemKey)`, a concurrent `enqueueIfAbsent({ itemKey: 'owner/repo#N' })` from a monitor code path returns `dropped` and `ZCARD orchestrator:queue:pending` remains 0. This is a *distinct* test from FR-007's suite — it targets the specific "monitor fires while claimed" cross-path interaction that produced the observed four-concurrent-claim state, and it is the single most important test for regression detection. | P1 | Named regression test for the observed incident. Distinguishable in the test file's `describe` block so a failure surfaces "the #1060 wedge is back" rather than "some queue test failed". |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Duplicate concurrent claims produced by the `process:<workflow>` intake path | 0 | Test: enqueue an item via the `process` code path, claim it, run every monitor's `enqueueIfAbsent` for the same itemKey → assert the monitor calls are dropped and only one claim exists. Reproduces the 2026-07-28 tetrad-development incident. |
| SC-002 | In-flight-SET membership drift after `enqueue()` | 0 items missing | Test: enqueue N distinct items → assert `SCARD orchestrator:queue:in-flight-items` = N. Regression fires if `enqueue()` reverts to `ZADD`-only. |
| SC-003 | Divergence between `RedisQueueAdapter.enqueue()` and `InMemoryQueueAdapter.enqueue()` observable outcomes | 0 divergences across the FR-007 test suite | Parameterized test suite runs both adapters through the FR-006 sequence and asserts identical outcomes for: drop-vs-accept on duplicate, in-flight-SET membership after each step, log-line shape. |
| SC-004 | Invariant `in-flight = pending ∪ claimed` violations across the FR-006 representative sequence | 0 | FR-007's test explicitly asserts `in-flight-items == pending-keys ∪ claimed-keys` at every intermediate step of `enqueue → claim → release-retry → reclaim-orphan → complete`. |
| SC-005 | Change to Redis operation count on the healthy dispatch path (per `claim → complete` cycle) | 0 additional round-trips | Measurement: `redis-cli MONITOR` during a healthy `enqueue → claim → complete` cycle before and after the fix → assert the fix adds exactly one operation inside the atomic Lua body (the `SADD`), not a separate round-trip. |
| SC-006 | Regression re-appearance of the `enqueue()` bug under refactor | Fails CI | Delete the `SADD IN_FLIGHT_KEY` line from the FR-001 Lua script → at least one of FR-007/FR-008's tests fails. |
| SC-007 | Spurious retries or `error`-tier logs on the `process` intake path when the FR-002 drop fires | 0 | Test: fire `enqueue()` twice for the same in-flight itemKey via the actual `LabelMonitorService.processLabelEvent()` code path → assert no `error`-tier log, no dispatcher retry, no `phase-tracker` re-mark. |

## Assumptions

- The `QueueManager` interface (`packages/orchestrator/src/services/queue-manager.ts`) is the shared contract between `RedisQueueAdapter` and `InMemoryQueueAdapter`. Both adapters must implement any return-shape or method-signature changes; there are no other implementations to migrate.
- `RedisQueueAdapter` already uses `EVAL`/`EVALSHA` for its four Lua scripts (`CLAIM_SCRIPT`, `RELEASE_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, plus PR #1056's `RECLAIM_ORPHAN_SCRIPT`). Adding a fifth `ENQUEUE_SCRIPT` follows the established pattern without introducing new dependencies or infrastructure.
- The `_dedup:<itemKey>` hash's current role — populated by `enqueue()`, read by `getDedupKey()` for cross-adapter observability, not read by the dedupe gate — is intentional and preserved. Rewiring `_dedup` into the gate would require deciding which fields collide (all? just `itemKey`? excluding `attemptCount`?) and produces unclear semantics under `release()`'s retry path. Deferred.
- `LabelMonitorService.processLabelEvent()`'s `type === 'process'` branch and `WorkerDispatcher.handleLeaseExpired()` are the only two direct callers of `enqueue()`. A codebase grep confirms this; if a third caller lands mid-flight, FR-003 extends to it uniformly. All other queue-entry paths (four monitor sites + label-monitor `resume` branch) already use `enqueueIfAbsent()`.
- The FR-007 test suite reuses existing real-Redis infrastructure (`redis-queue-adapter.enqueueIfAbsent.test.ts:300-313` already spins up a real Redis for assertion of Lua script side-effects). A mocked SET/HASH would not catch a mis-issued `SADD` command shape, and the existing infrastructure is proven.
- The observed 2026-07-28 incident's `SET`-cleared trigger and this spec's routine-`enqueue()` trigger produce byte-for-byte identical Redis states — an item in the claimed hash with no in-flight-SET membership. The fix that prevents the routine case also prevents the observed case (the observed case's out-of-band `DEL` remains reproducible manually, but no code path routinely produces the state).
- The composition with PR #1056 is additive and non-conflicting. PR #1056 adds `RECLAIM_ORPHAN_SCRIPT` for the "dispatcher-invisible dead worker" case and depends on the in-flight SET being populated at enqueue time to correctly leave the item in the SET during reclaim. This spec makes that dependency reliably true. Merge order does not matter; the two work independently and together.
- The bug applies uniformly to every workflow (`workflow:speckit-feature`, `workflow:speckit-bugfix`, any future workflow) because the affected code path is workflow-agnostic — the `process:<workflow>` label handler dispatches through the same `enqueue()` call regardless of which workflow triggered.
- Return-shape change to `enqueue()` (`enqueued` vs. `already-in-flight` — clarifications Q1) is a public-API change to the `QueueManager` interface. Because `enqueue()` is only called from two internal sites (both updated by FR-003) and no external package imports `QueueManager` from `@generacy-ai/orchestrator`, the change is a `patch` from a semver perspective (internal-only), but land it under a `minor` bump if any package.json downstream declares `@generacy-ai/orchestrator` in `dependencies`. Confirm at implement time by grepping `pnpm why @generacy-ai/orchestrator`.

## Out of Scope

- **Age-based severity escalation of drop logs.** This is #1054/PR #1056's FR-006/FR-007 concern; when that lands, the FR-002/FR-003 drop lines from this spec inherit it via the shared helper. Duplicating the mechanism here would create merge conflict and cross-spec ownership confusion.
- **Rewiring `_dedup:*` into the dedupe gate.** A larger refactor with unclear semantics under `release()`; the FR-001 route through the existing `IN_FLIGHT_KEY` is the smaller, correctness-equivalent change. Deferred as a possible follow-up if `_dedup` acquires additional consumers.
- **Refactoring `enqueue()` and `enqueueIfAbsent()` into a single method with a `require-absent: boolean` flag.** After FR-002 the two verbs differ only in whether the caller wants the outcome as a return code (`enqueue`: caller inspects) or as a boolean (`enqueueIfAbsent`: caller ignores drops). Collapsing them is a code-shape question, not a correctness question — deferred.
- **A `/queue` admin endpoint or CLI tool for inspecting/clearing wedged in-flight items.** The fix removes the code path that produces wedges via routine operation; the manual `DEL` trigger from the observed incident remains but is an operational concern, not a code-shape one. If operators still want inspection tooling post-fix, follow-up.
- **Changing `LabelMonitorService`'s or `WorkerDispatcher`'s call patterns beyond FR-003.** The two direct callers are updated to consume FR-002's return code; larger changes (e.g., routing `LabelMonitorService`'s `type === 'process'` branch through `enqueueIfAbsent()` instead) are alternative designs the issue's "Proposed fix" enumerates. FR-001+FR-002 achieves the same functional outcome with less churn; the alternative is deferred as a follow-up if any second consideration emerges.
- **Cloud-side or SSE-side alerting on the drop log.** FR-005's log-line shape is the observer surface; downstream alerting is ops-config, not code.
- **Migrating the claim hash to per-key `SET`-with-TTL storage.** Cited in #1054/PR #1056's out-of-scope; unchanged here.

---

*Generated by speckit*
