# Implementation Plan: PR-feedback enqueue migration to in-flight dedupe (#879)

**Feature**: Migrate `pr-feedback-monitor-service.ts` from `PhaseTracker.tryMarkProcessed` dedupe to `QueueManager.enqueueIfAbsent` in-flight dedupe (completes #862's stated goal — last remaining `address-pr-feedback` `PhaseTracker` caller)
**Branch**: `879-found-during-cockpit-v1`
**Status**: Complete

## Summary

`PrFeedbackMonitorService` still writes `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` via `phaseTracker.tryMarkProcessed` (line 341) with a ~24h TTL, while the sibling resume path was already migrated in #862 to atomic in-flight queue-state dedupe. The mismatch leaves a residual failure mode: a stale key from a pre-#869 handler era silently blocks the first trusted enqueue after a deploy, appearing as a broken loop that "heals" at TTL expiry.

This PR converges both surfaces on one dedupe mechanism (`queueManager.enqueueIfAbsent`, self-clearing by construction), removes `PhaseTracker` from **both** `pr-feedback-monitor-service.ts` and `pr-feedback-handler.ts` (per clarification Q1→A), preserves the #869 zero-trusted-does-not-enqueue contract (mandatory interaction guard), and finishes the follow-up bookkeeping so the `PhaseTracker` class itself becomes cleanly deletable in a later PR.

## Technical Context

- **Language**: TypeScript (strict), ESM, Node ≥22
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator/`)
- **Runtime dependency**: `QueueManager.enqueueIfAbsent` (already declared in `packages/orchestrator/src/types/monitor.ts:232`; already used by `label-monitor-service.ts` resume branch)
- **No new packages, no new dependencies.** This is a caller-site migration + dead-code removal.
- **Redis**: `enqueueIfAbsent` uses a Lua script (`redis-queue-adapter.ts:22-30`) atomically checking `SISMEMBER(IN_FLIGHT_KEY, itemKey)`. `itemKey = ${owner}/${repo}#${issueNumber}` (no `command` component — confirmed as intended in clarification Q2→A).
- **In-memory**: `InMemoryQueueAdapter` mirrors the same shape at `packages/orchestrator/src/services/in-memory-queue-adapter.ts:82-105`.

## Project Structure

Changes are localized to `packages/orchestrator/src/`:

```
packages/orchestrator/src/
├── services/
│   ├── pr-feedback-monitor-service.ts       [MODIFY] FR-001, FR-002, FR-009, FR-010, FR-011
│   ├── redis-queue-adapter.ts               [MODIFY] FR-009 log-shape upgrade (warn → structured info on in-flight drop; label at :140-146)
│   ├── in-memory-queue-adapter.ts           [MODIFY] FR-009 parity — emit same info log on `false` return path
│   └── __tests__/
│       └── pr-feedback-monitor-service.test.ts   [MODIFY] Drop phaseTracker stub arg, update dedupe assertions, add SC-001 stale-key test, add SC-002 race test, add SC-005 zero-trusted test, add FR-009 log assertion, add FR-010 idempotent-label-on-collision assertion
├── worker/
│   ├── pr-feedback-handler.ts               [MODIFY] FR-008: delete `DEDUP_PHASE` (line 19), delete `clearDedupe` closure (110-117), delete all 5 `clearDedupe()` call sites (:259, :289, :370, :376, :383), remove `phaseTracker` ctor param (:78)
│   ├── claude-cli-worker.ts                 [MODIFY] Update `PrFeedbackHandler` construction — drop the phaseTracker arg
│   └── __tests__/
│       └── pr-feedback-handler.test.ts      [MODIFY] Drop phaseTracker stub, remove all `phaseTracker.clear` assertions
├── server.ts                                [MODIFY] FR-011: drop `phaseTracker` arg from `PrFeedbackMonitorService` construction (:405-417)
└── __tests__/
    └── phase-tracker-audit.test.ts          [ADD] SC-004: audit test asserting neither `pr-feedback-monitor-service.ts` nor `pr-feedback-handler.ts` references `PhaseTracker`, and no `DEDUP_PHASE` declaration remains under `packages/orchestrator/src/**` (patterned on existing `trust-predicate-audit.test.ts`)

specs/879-found-during-cockpit-v1/
├── spec.md
├── clarifications.md
├── plan.md                     [THIS FILE]
├── research.md                 [ADD]
├── data-model.md               [ADD]
├── quickstart.md               [ADD]
└── contracts/
    └── enqueue-dedupe.md       [ADD]
```

**Files NOT changing:**

- `packages/orchestrator/src/services/phase-tracker-service.ts` — the class stays (deleting it is explicitly out-of-scope per spec; a follow-up PR removes it once no callers remain).
- `packages/orchestrator/src/types/monitor.ts` — `PhaseTracker` interface stays (still used by other services). `QueueManager.enqueueIfAbsent` and `QueueAdapter` shapes stay.
- `packages/orchestrator/src/services/label-monitor-service.ts` — reference implementation, unchanged.
- `packages/orchestrator/src/services/redis-queue-adapter.ts:22-30` (Lua) and `:65-67` (`buildItemKey`) — semantics untouched; only the drop-path log line at `:140-146` upgrades shape.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo (verified: `.specify/memory/` is absent; only `.specify/templates/` is present). Skipping.

## Behavior Contract (per spec + clarifications)

| Site | Before | After |
|------|--------|-------|
| `pr-feedback-monitor-service.ts` dedupe (:341) | `await this.phaseTracker.tryMarkProcessed(owner, repo, issue, 'address-pr-feedback')` returns `false` when the ~24h key exists | `await this.queueManager.enqueueIfAbsent(queueItem)` returns `false` iff the same `itemKey` (`${owner}/${repo}#${issueNumber}`) is currently in the in-flight `Set` (Redis) or in-flight map (memory). Self-clears on handler complete/fail/drop. |
| Drop-path logging (`redis-queue-adapter.ts:140-146`, `in-memory-queue-adapter.ts:100+`) | `warn` on Redis error only; no log on the `false` return path from in-memory | Structured `info` line with `{ itemKey, reason: 'in-flight' }` **on the `false` return path in both adapters** — matches label-monitor pattern at `label-monitor-service.ts:336-346`. Redis-error path stays `warn` (transient failure, distinct signal). |
| Waiting-for label (`pr-feedback-monitor-service.ts:379-387`) | Added only after successful enqueue (`isNew === true`) | Added idempotently whenever trusted unresolved feedback is present, **before** the enqueue call — so it survives the `enqueueIfAbsent → false` branch. Failure to add label stays non-fatal warn. |
| Zero-trusted path (`:295-323`) | Skips enqueue entirely | Unchanged — this is the #869 interaction guard that makes self-clearing dedupe safe. **Must be preserved and verified by SC-005.** |
| Handler-side `phaseTracker.clear()` calls (`pr-feedback-handler.ts:110-117, 259, 289, 370, 376, 383`) | Fired on all 5 terminal exit paths as #869 FR-006 settlement obligation | Deleted. The settlement partner writes nothing post-migration; the calls are dead. |
| `PrFeedbackMonitorService` ctor param 3 (`phaseTracker: PhaseTracker`) | Present | Removed (FR-011). `server.ts:405-417` construction site updated. Test stubs at `__tests__/pr-feedback-monitor-service.test.ts` updated. |
| `PrFeedbackHandler` ctor param 4 (`phaseTracker: PhaseTracker`) | Present | Removed (FR-008 downstream). `claude-cli-worker.ts:296+` construction site updated. Test stubs at `__tests__/pr-feedback-handler.test.ts` updated. |

## Migration Ordering (single PR)

The changes are inter-locking — the ctor signature change and the call-site changes must land together. Suggested implementation order for reviewability (all in one PR):

1. **Handler cleanup (FR-008)** — delete `DEDUP_PHASE`, `clearDedupe` closure, five `clearDedupe()` calls, and `phaseTracker` ctor param from `pr-feedback-handler.ts`. Update `claude-cli-worker.ts` construction. Update `pr-feedback-handler.test.ts` (drop stub, drop clear-assertions).
2. **Adapter log-shape upgrade (FR-009)** — upgrade the `false`-return path in both `redis-queue-adapter.ts` and `in-memory-queue-adapter.ts` to a structured `info` line `{ itemKey, reason: 'in-flight' }`.
3. **Monitor migration (FR-001, FR-002, FR-010, FR-011)** — in `pr-feedback-monitor-service.ts`:
   - Change field type `queueAdapter: QueueAdapter` → `queueManager: QueueManager` (needed to reach `enqueueIfAbsent`).
   - Reorder label-add to fire **before** the enqueue call (FR-010 idempotency guarantee on collision).
   - Replace `phaseTracker.tryMarkProcessed(...)` + `if (!isNew) { skip }` block (:341-350) with `enqueueIfAbsent(queueItem)` returning boolean; on `false`, log info drop and return (label already added).
   - Delete `DEDUP_PHASE` constant (:38) and `phaseTracker` ctor field + param.
   - Update `server.ts:405-417` construction.
4. **New audit test (SC-004)** — add `packages/orchestrator/src/__tests__/phase-tracker-audit.test.ts` (patterned on `trust-predicate-audit.test.ts`).
5. **Regression tests (SC-001, SC-002, SC-003, SC-005)** — extend `pr-feedback-monitor-service.test.ts`:
   - **SC-001**: seed the old `phase-tracker:*:address-pr-feedback` key in the (fake/in-memory) Redis, run monitor with trusted unresolved threads and no in-flight item, assert enqueue fires.
   - **SC-002**: fire simultaneous webhook + poll paths against the same PR state, assert queue depth == 1 and one info-log drop.
   - **SC-003**: run handler through each terminal path, then re-poll with trusted state, assert enqueue fires with no manual clearing.
   - **SC-005**: unresolved-thread w/ only untrusted authors → assert no enqueue on any poll (guards the #869 interaction contract).
   - **FR-009 log assertion**: on `enqueueIfAbsent → false`, assert an `info` log line with `itemKey` and `reason: 'in-flight'`.
   - **FR-010 label assertion**: on `enqueueIfAbsent → false`, assert `addLabels` was still called with `['waiting-for:address-pr-feedback']`.

## Risks / Notes

- **`buildItemKey` collision with in-flight `continue`/`process` (clarification Q2→A confirmed intended):** A PR-feedback trigger arriving while `continue`/`process` is in flight for the same issue drops. This is per-issue single-in-flight semantics, matching #862's Q3. Diagnosability is provided by FR-009 (repeated info drops = stuck-worker signal) + FR-010 (label present = "feedback pending" is truthful in cockpit). No change to `buildItemKey`.
- **The #869 zero-trusted guard is load-bearing.** Without it, self-clearing dedupe busy-loops monitor+handler for zero-trusted PRs. SC-005 is the explicit regression fence.
- **Existing in-flight items keyed by the old phase-tracker scheme need no migration** (Assumption 3). Old `phase-tracker:*:address-pr-feedback` keys in Redis expire on their own TTL and no longer influence enqueue decisions after this change.
- **PhaseTracker class deletion is out-of-scope this PR** (spec Out of Scope). This PR removes the last `address-pr-feedback` caller; a follow-up PR audits remaining callers (other phases) and deletes the class when clean.
- **Test infrastructure**: `pr-feedback-monitor-service.test.ts` currently mocks `phaseTracker`; the migration deletes those stubs and replaces them with `queueManager` stubs (or the in-memory adapter directly, which is simpler and gives real dedupe semantics for SC-001/SC-002/SC-003 without hand-wiring a fake).
