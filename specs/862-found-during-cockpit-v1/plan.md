# Implementation Plan: In-Flight-Keyed Resume Dedupe (retires history-keyed dedupe from #849)

**Feature**: Replace the history-keyed `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` dedupe with an in-flight-keyed queue check. Deletes the #849 paired-clear machinery.
**Branch**: `862-found-during-cockpit-v1`
**Date**: 2026-07-08
**Status**: Complete
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)

## Summary

Three live strandings (the #849 originating case, this cockpit-v1 finding, and the operator-reported second-clarification-batch class) all share one design: the resume dedupe is keyed on HISTORY — `(issue, gate)` under a 24 h TTL — so its correctness depends on every pause path routing a paired-clear callback, on no pre-fix keys surviving, and on TTL races never landing wrong. #849 added a callback obligation; this spec removes the obligation entirely by re-keying dedupe against IN-FLIGHT queue state.

Dedupe's actual job is preventing double-enqueue when webhook and poll observe the same `completed:*` occurrence. That is exactly scoped by "is a resume for this issue currently pending or claimed in the queue?" — the queue already has per-issue `itemKey` (`owner/repo#issue`). We add an atomic `QueueManager.enqueueIfAbsent(item)` primitive (Q1→B) backed by a Lua script that checks a new secondary Redis SET (`orchestrator:queue:in-flight-items`, Q2→A) and ZADDs in one round trip. `LabelMonitorService` replaces `phaseTracker.isDuplicate/markProcessed` for the `resume` branch with `queue.enqueueIfAbsent(item)`. The #849 paired-clear closure (`claude-cli-worker.ts:420`) and `ClearResumeDedupeCallback` on `LabelManager` are deleted. `phaseTracker.clear`/`markProcessed` remain in use for the `process:*` branch — that path is unaffected.

Properties after the change: a second resume occurrence needs no cache invalidation (the first item is long gone from the queue); webhook/poll racing on the SAME occurrence collapse to one enqueue via the Lua-atomic SET NX; orphan claims (dead worker) count as in-flight (Q4→A) — worst case is drops bounded by one dispatcher-reclaim/heartbeat interval, then the next poll enqueues (permanent stranding is impossible by construction).

## Technical Context

**Language/Version**: TypeScript, Node ≥22 (ESM). Same runtime as the rest of `packages/orchestrator`.
**Primary Dependencies**: `ioredis` (existing Redis client + Lua `defineCommand`), `vitest`, `ioredis-mock` (existing test harness — the mock supports `zadd`, `sadd`, `sismember`, `srem`, `hset`, `hdel`, `defineCommand`; verify `EVAL`/`defineCommand` semantics in the mock before landing).
**Storage**: Redis. One new key: `orchestrator:queue:in-flight-items` (SET, members are `itemKey` strings — `owner/repo#issue`). Existing `orchestrator:queue:pending` (ZSET), `orchestrator:queue:claimed:<workerId>` (HASH), `orchestrator:queue:dead-letter` (ZSET), `orchestrator:worker:<id>:heartbeat` (STRING with TTL) unchanged.
**Testing**: `vitest run` from `packages/orchestrator`. Existing patterns: `__tests__/paired-resume-dedupe-clear.integration.test.ts` uses `ioredis-mock` + real `PhaseTrackerService` + real `LabelMonitorService.processLabelEvent` + real `LabelManager.onGateHit`. This spec's integration test follows the same shape but exercises `queue.enqueueIfAbsent()` instead of the paired-clear closure.
**Target Platform**: In-container Linux (cluster orchestrator process). No platform-specific changes.
**Project Type**: Single package (`packages/orchestrator` inside the monorepo). No new packages.
**Performance Goals**: `enqueueIfAbsent` is one Redis round trip (Lua-atomic `SISMEMBER` + `SADD` + `ZADD` inside a single script). `hasInFlight` (observability helper) is `SISMEMBER` — O(1). Baseline `enqueue` was one `ZADD` — one added `SISMEMBER`/`SADD` inside the same Lua script, no round-trip regression.
**Constraints**: Fail-safe on Redis errors (existing pattern — log warn, return `false` from `enqueueIfAbsent` so caller does not re-fire under partial outages; graceful degradation matches `RedisQueueAdapter`'s existing `catch` blocks). Must not regress `process:*` dedupe (that branch keeps `PhaseTracker`).
**Scale/Scope**: Current cluster load is well below Redis single-instance saturation. The SET grows only as O(pending + claimed items) — bounded by concurrent open workflow issues.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repository. No constitutional gates to evaluate. This section is present for template compliance; no violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/862-found-during-cockpit-v1/
├── spec.md                  # /specify output — problem statement + durable-fix outline
├── clarifications.md        # /clarify output — 5 batched decisions (Q1–Q5)
├── plan.md                  # THIS FILE
├── research.md              # Phase 0 — decisions, alternatives, sources
├── data-model.md            # Phase 1 — Redis keyspace + type-level contracts
├── quickstart.md            # Phase 1 — how to exercise the new behavior locally
├── contracts/               # Phase 1
│   ├── queue-manager.md     # QueueManager.enqueueIfAbsent / hasInFlight contract
│   ├── lua-scripts.md       # ENQUEUE_IF_ABSENT_SCRIPT, extended CLAIM_SCRIPT
│   └── label-monitor.md     # Resume-branch behavior in processLabelEvent
├── conversation-log.jsonl
└── tasks.md                 # NOT YET — /speckit:tasks output
```

### Source Code (repository root — files touched)

```text
packages/orchestrator/
├── src/
│   ├── types/
│   │   └── monitor.ts                                # MODIFIED: extend QueueManager
│   ├── services/
│   │   ├── redis-queue-adapter.ts                    # MODIFIED: enqueueIfAbsent + hasInFlight + SET maintenance in Lua
│   │   ├── in-memory-queue-adapter.ts                # MODIFIED: enqueueIfAbsent + hasInFlight; SET → Set<string>
│   │   ├── label-monitor-service.ts                  # MODIFIED: resume branch uses enqueueIfAbsent, deletes phaseTracker.isDuplicate/markProcessed for resume
│   │   └── phase-tracker-service.ts                  # UNCHANGED — still owns process:* dedupe
│   └── worker/
│       ├── label-manager.ts                          # MODIFIED: delete ClearResumeDedupeCallback + onGateHit clear call
│       └── claude-cli-worker.ts                      # MODIFIED: delete paired-clear closure (~line 420)
├── src/__tests__/
│   ├── inflight-resume-dedupe.integration.test.ts    # NEW: three regression scenarios from spec
│   └── paired-resume-dedupe-clear.integration.test.ts # DELETED — superseded (its scenario is now impossible by construction)
└── src/services/__tests__/
    └── redis-queue-adapter.enqueueIfAbsent.test.ts   # NEW: Lua atomicity + SET invariants + orphan-claim behavior
```

**Structure Decision**: This is a targeted refactor of one subsystem inside an existing package. No new source directories; all changes land in `packages/orchestrator`. The `server.ts` wiring point at line 332–338 (worker-mode `workerPhaseTracker` for #849 paired-clear) is deleted; the full-mode `PhaseTrackerService` instantiation at line 360 stays (still used by `process:*` branch).

## Design Overview

### Data flow — before vs. after (resume branch only)

**Before (#849, current)**:
```
webhook/poll observes completed:<gate> + waiting-for:<gate>
  └─ LabelMonitorService.processLabelEvent(type='resume')
      ├─ phaseTracker.isDuplicate(owner, repo, issue, resume:<gate>)      ← history-keyed lookup
      │   └─ if duplicate → drop silently
      ├─ enqueue(item)                                                     ← one ZADD, no atomicity vs. concurrent caller
      └─ phaseTracker.markProcessed(..., resume:<gate>, TTL=24h)          ← writes history-keyed key

pause path (LabelManager.onGateHit):
  ├─ apply waiting-for:<gate> label
  └─ clearResumeDedupe(<gate>) closure                                    ← #849's obligation
      └─ phaseTracker.clear(..., resume:<gate>)                           ← DEL history-keyed key
```

**After (this spec)**:
```
webhook/poll observes completed:<gate> + waiting-for:<gate>
  └─ LabelMonitorService.processLabelEvent(type='resume')
      ├─ queue.enqueueIfAbsent(item)                                      ← Lua-atomic: SISMEMBER + SADD + ZADD
      │   └─ if in-flight → return false, emit info log { itemKey, gate, reason: 'in-flight' }
      └─ (no phaseTracker call for resume events)

pause path (LabelManager.onGateHit):
  └─ apply waiting-for:<gate> label                                       ← no clearResumeDedupe callback
```

The `process:*` branch (webhook/poll observes `process:<workflow>`) is untouched. It keeps `phaseTracker.clear + isDuplicate + markProcessed` — that path's dedupe purpose is different (prevent double-fire of a fresh trigger before label removal completes on GitHub).

### The atomic primitive — `QueueManager.enqueueIfAbsent(item)`

Contract:
- Return `true` if the item was enqueued (not previously in flight).
- Return `false` if `itemKey` is already in the in-flight SET (pending OR claimed by any worker).
- Behavior is atomic w.r.t. concurrent callers: two `enqueueIfAbsent` calls on the same `itemKey` race → one `true`, one `false`. No double-enqueue.
- Redis unavailable / Lua error → log warn, return `false`. Caller emits the "in-flight" info line either way; the next poll cycle re-offers the event. (Fail-safe: false-drop is recoverable in ≤1 poll; false-enqueue would race two workers.)

Lua script skeleton (`ENQUEUE_IF_ABSENT_SCRIPT`):
```lua
-- KEYS[1] = pending sorted set  = 'orchestrator:queue:pending'
-- KEYS[2] = in-flight SET       = 'orchestrator:queue:in-flight-items'
-- ARGV[1] = itemKey
-- ARGV[2] = priority (numeric)
-- ARGV[3] = serialized item JSON
local exists = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if exists == 1 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[3])
return 1
```

### SET maintenance across all queue transitions

The SET is authoritative for "is `itemKey` in flight?". Every transition that adds/removes an item from pending or claimed must update it atomically inside the same Lua script that owns the transition. This is Q2→A's atomicity-boundary consolidation.

| Transition                | Existing operation                          | SET update                          |
|---------------------------|---------------------------------------------|-------------------------------------|
| enqueue (fresh)           | `ZADD pending`                              | `SADD in-flight` (via new script)   |
| enqueue (retry, from release) | `ZADD pending` (still inside release path) | (already in SET — no-op needed, but idempotent SADD is safe) |
| enqueue (dead-letter)     | `ZADD dead-letter`                          | `SREM in-flight` (drop from set — no longer eligible for reclaim) |
| claim                     | `ZPOPMIN pending` + `HSET claimed`          | (already in SET — no-op)            |
| complete                  | `HDEL claimed`                              | `SREM in-flight`                    |
| release (retry re-queue)  | `HDEL claimed` + `ZADD pending`             | (already in SET — no-op)            |
| release (dead-letter)     | `HDEL claimed` + `ZADD dead-letter`         | `SREM in-flight`                    |

`CLAIM_SCRIPT` (existing): no SET change required — the item was already in SET before ZPOPMIN moved it from pending to claimed.

`release`/`complete` are currently *non*-Lua (two Redis calls). Two options:
- **Chosen**: convert `complete` and the dead-letter branch of `release` to `MULTI/EXEC` transactions (`multi().hdel().srem().exec()` and `multi().hdel().del().zadd(dead-letter).srem(in-flight).exec()`). Simpler than promoting to Lua; sufficient because all SET writers are inside the atomic boundary.
- Rejected: full Lua-ification of `release`/`complete`. Not needed — the SET consistency invariant only requires that `SREM in-flight` and its paired `HDEL claimed` (or `ZADD dead-letter`) happen atomically w.r.t. observers, which `MULTI/EXEC` gives us.

### Observability helper — `QueueManager.hasInFlight(itemKey)`

- Purely `SISMEMBER orchestrator:queue:in-flight-items itemKey`.
- Never called by `processLabelEvent`'s dedupe path (Q1→B keeps `enqueueIfAbsent` as the atomic gate).
- Exposed for the `/queue/*` admin routes and future cockpit views ("what's in flight right now" via `SMEMBERS`).

### Dropped-resume log line (Q5→A)

Format (structured pino), emitted by `LabelMonitorService.processLabelEvent` when `enqueueIfAbsent` returns `false`:

```jsonc
{
  "level": "info",
  "msg": "Dropping resume event (item already in flight)",
  "owner": "…", "repo": "…", "issueNumber": …,
  "itemKey": "owner/repo#N",
  "gate": "implementation-review",
  "reason": "in-flight",
  "source": "webhook" | "poll"
}
```

Poll cadence re-emits this line on every cycle for a stuck in-flight item — the repeating line *is* the stuck-worker signal (Q5's rationale). No metrics infra added.

### What we delete

- `ClearResumeDedupeCallback` type in `packages/orchestrator/src/worker/label-manager.ts` (top of file, ~line 10).
- `clearResumeDedupe?` constructor parameter on `LabelManager` (line 30).
- The `try { await this.clearResumeDedupe?.(gateSuffix); } catch { … }` block inside `LabelManager.onGateHit` (introduced by #849 — grep for `Cleared paired resume dedupe on pause`).
- The paired-clear closure passed into `new LabelManager(...)` at `packages/orchestrator/src/worker/claude-cli-worker.ts:406–422`.
- The worker-mode `PhaseTrackerService` instantiation at `packages/orchestrator/src/server.ts:326–338` (lines 326–334) and the `phaseTracker: workerPhaseTracker` prop passed to `ClaudeCliWorker` (line 338). `ClaudeCliWorkerDeps.phaseTracker?` type field can also be dropped.
- The `paired-resume-dedupe-clear.integration.test.ts` file — its scenario ("stale `resume:<gate>` key from prior cycle blocks re-enqueue after paired-clear runs") is impossible by construction under the new design (there is no key). The FR-008 single-cycle non-regression scenario ("two resume triggers within one cycle collapse to one enqueue") is preserved by SC-003 in the new integration test.

### What we keep

- `PhaseTrackerService` — used by `LabelMonitorService.processLabelEvent`'s `type === 'process'` branch and by `PrFeedbackMonitorService`. Unchanged.
- `phaseTracker.clear(owner, repo, issue, parsedName)` for `type === 'process'` in `LabelMonitorService` (line 279). Unchanged.
- `PhaseTracker` interface itself. No API removal; just no more callers writing `resume:<gate>` keys.
- Server-mode full-mode wiring at `server.ts:360`. Unchanged.

## Constitution Check (Re-check after design)

Not applicable (no constitution file exists).

## Complexity Tracking

None. The refactor removes complexity — one atomic primitive + one Redis SET replaces a two-service, six-callsite coordination protocol (label-monitor writes key, worker's phase-loop clears key, TTL enforces bound, wiring in server.ts, wiring closure in claude-cli-worker.ts, unit + integration tests in both services).
