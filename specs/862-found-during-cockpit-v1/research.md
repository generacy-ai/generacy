# Research: In-Flight-Keyed Resume Dedupe (#862)

## Decisions

### D1 — Replace history-keyed dedupe with in-flight-keyed check

**Decision**: Remove the `phase-tracker:...:resume:<gate>` Redis key. Add `QueueManager.enqueueIfAbsent(item)` primitive. Route `LabelMonitorService.processLabelEvent`'s `type === 'resume'` branch through the primitive; drop `phaseTracker.isDuplicate`/`markProcessed` for that branch.

**Rationale**: The three live stranding incidents (#849 originating, this cockpit-v1 finding, operator's second-clarification-batch class) all share one root: a dedupe keyed on history (issue-lifetime under 24 h TTL) has correctness obligations that leak into every pause path. The dedupe's actual purpose — collapsing webhook + poll on the SAME `completed:*` occurrence — is scoped by "is a resume for this issue currently pending or claimed?" which the queue already knows. History-keyed dedupe over-scopes: it prevents any resume for `(issue, gate)` for 24 h, including legitimate re-visits after retries. Replacing the key with a queue-state read makes the second-occurrence case impossible to strand by construction: the first occurrence's item is long gone from the queue.

**Alternatives considered**:
- **Occurrence-keyed dedupe** (mentioned as spec's fallback): include the `completed:<gate>` label's `applied-at` timestamp in the dedupe key. Achieves the same non-stranding property but requires one `listLabeledEvents` GraphQL/REST call per resume event to fetch the timestamp — a rate-limit cost the queue-state approach avoids. Kept as a "if queue-level state proves awkward" fallback, but the extra hop is real overhead and clarifications Q1–Q4 all resolved cleanly for the queue-state path.
- **Extend #849's paired-clear to also DEL on process-branch label transitions** (a symptom-layer fix): would only patch this specific finding. Does not address the class (any pre-fix key surviving; any pause path missing the callback wire). Rejected — spec's core claim is that the design, not the wiring, is the problem.
- **Reduce TTL from 24 h to poll-interval + slack** (~1 h): reduces the stranding window but does not eliminate the class. Rejected for the same reason.

### D2 — Atomic `enqueueIfAbsent` primitive vs. separate `hasInFlight` + `enqueue` (clarifications Q1 → B)

**Decision**: Add `QueueManager.enqueueIfAbsent(item)` backed by a Lua script (`SISMEMBER + SADD + ZADD` in one round trip). `hasInFlight(itemKey)` stays as an observability helper only, never on the enqueue path.

**Rationale**: `RedisQueueAdapter.enqueue()` writes a distinct JSON member per call (serialized item includes `enqueuedAt`, `queueReason`, `attemptCount`), so two calls for the same `itemKey` produce two distinct ZSET members. A `hasInFlight` check followed by a plain `enqueue` is racy under simultaneous webhook + poll: both callers can observe `hasInFlight === false`, then both `ZADD`, producing two workers driving the same issue. That is exactly the race SC-003 requires we close.

**Alternatives considered**:
- **Option A (accept the race)**: two independent calls in `LabelMonitorService`. The "second worker resumes harmlessly on an idempotent gate check" argument is superficially plausible — but the two workers race on GitHub label writes and comments, which are the operator-visible mess we are trying to avoid. Rejected.
- **Option C (make `enqueue` itemKey-idempotent by default)**: changes a shared contract that requeue/retry callers (`release()`, dispatcher) rely on for intentional re-enqueue. Silent contract change with far-reach blast radius. Rejected.
- **Chosen: Option B** — new atomic primitive alongside `enqueue`. Both contracts stay clear: `enqueue` = "add unconditionally," `enqueueIfAbsent` = "add iff not in flight."

### D3 — Secondary Redis SET for in-flight lookup (clarifications Q2 → A)

**Decision**: Add `orchestrator:queue:in-flight-items` SET. Members are `itemKey` (`owner/repo#issue`). Maintained inside the same Lua scripts that own pending/claimed state transitions.

**Rationale**: Neither `PENDING_KEY` (ZSET members are opaque JSON strings) nor `CLAIMED_KEY_PREFIX<workerId>` (spread across N workers, keyed by `itemKey` inside each hash) is shaped for a cheap "is this itemKey in flight?" lookup. Q1's atomic primitive needs an O(1) check. The SET gives us O(1) `SISMEMBER` and an operator-friendly `SMEMBERS` view for "what's in flight right now" (useful for cockpit debugging). Consolidating writes into the existing Lua scripts (CLAIM_SCRIPT, new ENQUEUE_IF_ABSENT_SCRIPT) is the atomicity boundary — nothing to drift.

**Alternatives considered**:
- **Option B (scan on every check)**: `ZRANGE + JSON-parse each member` + `SCAN claimed:*` + `HEXISTS` per hash. Correct and stateless, but the scan cost recurs on every poll cycle × every open issue. Rejected — A2 in clarifications is a soft "cheap enough at observed rates," but the fixed-key SET is trivially cheaper and gives operator observability for free.
- **Option C (per-itemKey marker keys)**: `orchestrator:queue:item:<itemKey>` = `"pending"|"claimed"`. Same O(1) lookup as A but scatters the keyspace and gives no cheap `SMEMBERS`-style dump. Rejected.

### D4 — Scope `hasInFlight` at `itemKey` only (clarifications Q3 → A)

**Decision**: The in-flight SET keys on `itemKey` (`owner/repo#issue`) alone, not on `(itemKey, gate)`.

**Rationale**: A3 asserts "an issue can only be in one gate at a time" — the workflow does transition gates within a lifecycle (plan → tasks → implement → review), but never in parallel. If a `completed:tasks` resume enqueues an item that is still claimed when `completed:implementation-review` arrives on the same issue (edge case: stuck worker on the earlier gate), the newer resume is dropped by design. This is not lost work: the `waiting-for:*` / `completed:*` label pair persists on the issue, so the next poll re-offers the event, and the newer gate enqueues on the first poll after the earlier item drains. The stuck-earlier-gate case is the dispatcher's orphan-reclaim responsibility, not the resume path's.

**Alternatives considered**:
- **Option B: `(itemKey, gate)`** — preserves per-gate parallelism (irrelevant today, one issue = one worker) but adds complexity for the case A3 says shouldn't happen. Adds a persistence dimension we do not need. Rejected.

### D5 — Orphaned-claim handling (clarifications Q4 → A)

**Decision**: Any entry in a `claimed:<workerId>` hash counts as in-flight regardless of the owning worker's heartbeat state. The dispatcher's existing reclaim path is the sole source of truth for "this worker is dead, reclaim its items."

**Rationale**: The self-healing argument: worst case is drops bounded by one reclaim/heartbeat interval, after which the next poll re-fires the event and enqueues. Permanent stranding is impossible by construction, unlike the history-keyed design this spec replaces. Any other option forks the "is this worker dead?" judgment into two components with drift risk.

**Alternatives considered**:
- **Option B (cross-check heartbeat TTL from `hasInFlight`)**: risks `hasInFlight` declaring the worker dead and enqueueing *while* the dispatcher simultaneously reclaims and requeues — the exact double-enqueue we are preventing. Rejected.
- **Option C (ignore claimed state; only check pending)**: reintroduces the core race against a live in-progress worker on the same issue. Rejected.

### D6 — Dropped-resume observability (clarifications Q5 → A)

**Decision**: One structured `info`-level log line per drop, carrying `itemKey`, `gate`, `reason: "in-flight"`, and the source (`webhook` | `poll`). No metrics registry, no relay event.

**Rationale**: Poll re-offers the event every cycle, so a stuck in-flight item produces a repeating drop line at poll cadence — that repetition is itself the stuck-worker signal for operators. No new infrastructure required. Cockpit `watch` already classifies stuck/waiting states as actionable; per-issue drop counts on the operator UI are v2 scope.

**Alternatives considered**:
- **Option B (Prometheus counter)**: add only if a metrics registry already exists in the orchestrator (currently no). Do not build metrics infrastructure for this feature.
- **Option C (relay event to cockpit)**: v2 scope — cockpit `watch` already surfaces the stranded state.

## Implementation Patterns (existing prior art in the codebase)

- **`ioredis.defineCommand` for Lua scripts**: `RedisQueueAdapter` already uses this pattern (`CLAIM_SCRIPT`, `claimCommandDefined` gate at line 65). New `ENQUEUE_IF_ABSENT_SCRIPT` follows the same shape: registered lazily via `ensureCommand`, invoked as `(this.redis as any).enqueueIfAbsent(pendingKey, inFlightKey, itemKey, priority, serialized)`.
- **Graceful Redis-error degradation**: `RedisQueueAdapter.enqueue` at line 82 wraps the ZADD in `try/catch`, logs `warn`, and returns void without throwing. `enqueueIfAbsent` follows the same pattern but returns `false` on error (fail-safe: dropped resume is recoverable within one poll; false-enqueue would be racy).
- **`ioredis-mock` in integration tests**: `paired-resume-dedupe-clear.integration.test.ts` uses `RedisMock` as a drop-in for a live Redis, drives `PhaseTrackerService` + `LabelMonitorService` + `LabelManager` against it. `defineCommand`/`EVAL` support in the mock is the one thing to verify before landing (see quickstart.md § "Test-harness gotchas"); Lua string execution against `ioredis-mock`'s `EVAL` implementation is known to work for KEYS/ARGV patterns matching `CLAIM_SCRIPT`, which the mock already exercises transitively via the existing paired-clear test.
- **`MULTI/EXEC` transactions**: not currently used in `RedisQueueAdapter` — `release()` and `complete()` do sequential `hdel + del + zadd`. The SET-invariant maintenance uses `.multi().hdel().srem().exec()` in `complete()` and `.multi().hdel().del().zadd(dead-letter).srem(in-flight).exec()` in the dead-letter branch of `release()`. Idiomatic `ioredis` usage; `ioredis-mock` supports MULTI.

## Sources / references

- `packages/orchestrator/src/services/redis-queue-adapter.ts` — existing Lua `CLAIM_SCRIPT` and `defineCommand` registration pattern.
- `packages/orchestrator/src/services/in-memory-queue-adapter.ts` — existing in-memory `enqueue` already has an *implicit* itemKey-idempotency guard (lines 44–61, "reject if item key already exists in pending / claimed"). This spec extracts that behavior into a first-class `enqueueIfAbsent` method and mirrors it in `RedisQueueAdapter`.
- `packages/orchestrator/src/services/label-monitor-service.ts` (lines 264–372) — the `processLabelEvent` control flow this spec refactors.
- `packages/orchestrator/src/worker/label-manager.ts` (lines 1–30) — the #849 `clearResumeDedupe` mechanism this spec deletes.
- `packages/orchestrator/src/__tests__/paired-resume-dedupe-clear.integration.test.ts` — the #849 regression test whose scenarios are re-shaped for this spec's `enqueueIfAbsent` primitive.
- Redis Lua scripting docs — `SISMEMBER`, `SADD`, `ZADD`, `redis.call` in EVAL: <https://redis.io/docs/latest/develop/interact/programmability/eval-intro/>.
- `ioredis` `defineCommand`: <https://github.com/redis/ioredis#lua-scripting>.
