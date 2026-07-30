# Research — #1054 Orphaned queue claims must be reclaimed after a worker dies without unwinding

## Scope

Research supporting the four decisions materially not fully resolved in the spec + clarifications:

1. How to iterate claim keys from Redis (SCAN vs. secondary index vs. KEYS).
2. Whether to use Lua vs. MULTI/WATCH for the reclaim's atomicity (already decided in Q2=A; documented here for the record).
3. Where the shared drop-log helper lives and how it composes with the existing `pr-feedback-monitor-service.ts` transition-edge pattern.
4. Whether the four monitor sites should be extracted into a single call helper or modified in place.

## Decision Log

### D1: Iterate claim keys via `SCAN CLAIMED_KEY_PREFIX* COUNT 100`

**Chosen**: `SCAN` with `COUNT 100`, non-blocking iteration over `orchestrator:queue:claimed:*`.

**Alternatives considered**:

- **`KEYS orchestrator:queue:claimed:*`** — atomic O(N) block; simple. **Rejected**: blocks the Redis server for the duration; explicit anti-pattern in the Redis docs for any keyspace >1000 keys. Adopting `KEYS` even for a small keyset trains a bad habit.
- **Secondary index (`orchestrator:queue:workers-with-claims` SET)** — a SET of workerIds updated by `CLAIM_SCRIPT` and `RELEASE_SCRIPT` / `complete()`. `SMEMBERS` in one shot. **Rejected**: adds two extra writes (SADD in CLAIM, SREM in RELEASE/complete) on the hot path, and modifying `CLAIM_SCRIPT` violates FR-010 ("zero change to CLAIM_SCRIPT"). Not worth it for a keyset that is currently 1-10 keys.
- **`getActiveWorkerCount()`'s existing SCAN loop, refactored to return the key list.** — reuses shape from `redis-queue-adapter.ts:370-396`. **Considered**: viable. Rejected in favor of a dedicated internal method for two reasons: (a) `getActiveWorkerCount` is called from admin routes and shouldn't grow return-value width; (b) the reclaim needs the full `HGETALL` payload, not just the key count.

**Sources**: Redis docs on `SCAN` (non-blocking, cursor-based). Existing `getActiveWorkerCount` at `redis-queue-adapter.ts:370-396` as prior art.

### D2: `RECLAIM_ORPHAN_SCRIPT` is a Lua script, not `MULTI`/`WATCH`

**Chosen**: New Lua script `RECLAIM_ORPHAN_SCRIPT` invoked via `EVALSHA`-with-`EVAL`-fallback, registered via `redis.defineCommand` like the existing scripts.

**Alternatives considered**:

- **`MULTI`/`WATCH heartbeatKey`, `EXEC`**. **Rejected**: two extra round trips per orphan (WATCH + EXEC). Under a stuck cluster this compounds. More importantly, mixing `MULTI/WATCH` with `EVAL` fragments the codebase's atomicity story — every existing site uses Lua.
- **Client-side `EXISTS` + `MULTI/EXEC`**. **Rejected**: even more round trips; the race gap between EXISTS and EXEC is exactly what US2 is guarding against.
- **Server-side function (Redis 7 `FUNCTION`)**. **Rejected**: adds a persistent server-side artifact (loaded per Redis instance); Redis 6 compatibility is a stated non-goal but changing that assumption without discussion is scope creep. Lua `EVAL`/`EVALSHA` works identically across Redis 5/6/7.

**Sources**: Existing pattern at `redis-queue-adapter.ts:41-52` (`CLAIM_SCRIPT`) and `:22-30` (`ENQUEUE_IF_ABSENT_SCRIPT`). Clarifications Q2=A.

### D3: Shared drop-log helper is a pure function in a new file, not a class

**Chosen**: `packages/orchestrator/src/services/drop-log-helper.ts` exports `classifyDropSeverity(itemKey, ageMs, thresholdMs, state)` (pure) and `emitDropLog(logger, decision, payload, message)` (thin adapter). State (`Map<string, DropTransitionState>`) is owned by each caller — the Redis adapter has one, the in-memory adapter has one, each of the four monitor services has one.

**Alternatives considered**:

- **Class-based `DropSeverityTracker` with internal Map**. **Rejected**: over-abstracted for a two-function surface. State ownership is clearer at the caller site (each caller sees its own Map lifecycle — construction in the constructor, cleanup on `complete()`).
- **Copy the `lastUnresolvedThreadCount` / `isTransition` pattern into each of the six sites verbatim**. **Rejected**: 6× duplicated conditional logic is exactly the "17 identical `warn` lines" defect this fix is trying to eliminate at the operator level. A single point of decision keeps SC-004 (severity divergence = 0) provable by construction.
- **Extend the existing `PrFeedbackMonitorService.lastUnresolvedThreadCount` shape rather than a new helper**. **Rejected**: that Map is keyed on `stateKey = ${owner}/${repo}#${prNumber}` (per-PR), not on itemKey (per-issue). Semantically different tracking; reusing would conflate two concerns.

**Sources**: `pr-feedback-monitor-service.ts:73`, `:284-286` (existing transition-edge pattern). Clarifications Q4=A (transition-edge addition), Q5=C (shared helper).

### D4: Monitor sites modified in place, no shared "enqueueIfAbsentWithDropLog" wrapper

**Chosen**: Each of the four monitor sites (`pr-feedback`, `merge-conflict`, `clarification-answer`, `label-resume`) modifies its own `if (!enqueued) { ... }` branch to call the shared helper. No wrapper function around `enqueueIfAbsent + drop-log`.

**Alternatives considered**:

- **Extract to `enqueueIfAbsentWithDropLog(queueManager, item, logger, state, context)`**. **Considered strongly.** The four sites are near-identical shape. Rejected because (a) each site has a subtly different `context` payload (`prNumber` for PR-feedback, `gate` for label-monitor, none for merge-conflict/clarification-answer) that would need a `Record<string, unknown>` bag → loses type safety; (b) spec Out of Scope §5 explicitly says "Reworking the four monitor drop-log sites into a shared helper. FR-007's escalation can be applied in place at each site; extracting a helper is preferable but not strictly required for correctness." The shared *decision* (`classifyDropSeverity`) is enough; a shared *wrapper* is a follow-up if reviewers ask.
- **Emit the monitor context line inside `enqueueIfAbsent` itself and drop the monitor-side call.** **Rejected**: violates the two-log-lines-per-drop pattern the codebase established (adapter emits generic; monitor emits context). Existing operator log queries assume both lines exist.

**Sources**: Spec Out of Scope §5, FR-007. Existing site shapes at the four line numbers listed above.

### D5: `hasInFlightAge` accessor rather than embedding `enqueuedAt` in the in-flight SET

**Chosen**: New `QueueManager.hasInFlightAge(itemKey): Promise<number | null>` method returning the age in ms (or null if not in flight / transport error). Adapter impl: `SCAN` claim keys, `HGET` the payload, parse `enqueuedAt`, return `now - parseTime`.

**Alternatives considered**:

- **Store `enqueuedAt` alongside itemKey in the in-flight SET (`SADD in-flight-items <itemKey>:<enqueuedAt-ms>`).** **Rejected**: breaks the SET's dedupe semantic (`SISMEMBER` now needs the exact composite string; existing sites all pass just `itemKey`). Requires changing every enqueue/complete/release site.
- **Secondary sorted set `orchestrator:queue:in-flight-ages` (`ZADD` with `enqueuedAt-ms` as score).** **Considered.** Fewer writes than modifying `CLAIM_SCRIPT`; O(1) age lookup. Rejected for now because (a) drop-path is cold (fires on collision only); (b) monitor drops fire at ~5 min cadence per issue; (c) the O(N-workers) `SCAN` in the accessor is dominated by network RTT, and N=1-10 in practice. If profiling shows the accessor is a hotspot, adding the secondary sorted set is a mechanical follow-up.
- **Cache `enqueuedAt` client-side per itemKey on `enqueueIfAbsent` success.** **Rejected**: the cache would be dispatcher-local and miss for any itemKey that was enqueued on a different replica. The whole point of Redis is cross-replica coordination.

**Sources**: `SerializedQueueItem` shape at `types/monitor.ts:244-249` (has `enqueuedAt` already). `redis-queue-adapter.ts:113-153` (`enqueueIfAbsent` implementation).

### D6: `maxRunDurationMs` as `DispatchConfigSchema` field, not env var directly

**Chosen**: Add `maxRunDurationMs: z.number().int().min(60_000).default(1_800_000)` to `DispatchConfigSchema`. Env var override flows through the existing `config/loader.ts` → `DispatchConfig` pipeline; no new env var name needed (the schema field auto-picks up `ORCHESTRATOR_MAX_RUN_DURATION_MS` or the analogous form that the loader uses for existing dispatch fields).

**Alternatives considered**:

- **Hardcode `MAX_RUN_DURATION_MS = 1_800_000` as a module constant.** **Rejected** per Q1's rejection of D: operators with legitimately longer runs need a knob without a redeploy.
- **Derive at read time from an existing knob (`shutdownTimeoutMs × 12` or similar).** **Rejected** per Q1's rejection of C: opaque multiplier couples two knobs that should move independently.
- **New top-level `ObservabilityConfigSchema` block.** **Rejected**: over-structured for one field. `DispatchConfigSchema` already carries `heartbeatCheckIntervalMs`, `heartbeatTtlMs`, `maxRetries` — a threshold that gates a drop-log severity conceptually belongs there.

**Sources**: `config/schema.ts:164-177` (existing shape). Clarifications Q1=A.

### D7: Cleanup of the transition-edge Map on `complete()` — bounded memory

**Chosen**: In `RedisQueueAdapter.complete()` and `InMemoryQueueAdapter.complete()`, add `this.dropLogState.delete(itemKey)` alongside the existing in-flight cleanup.

**Alternatives considered**:

- **TTL-based expiry (LRU via `Map` insertion order + max-size cap).** **Rejected**: overengineered; wedged itemKeys are rare and each entry is <100 bytes. Cleanup at the natural end-of-life (`complete()`) is the exact right lifetime.
- **No cleanup, rely on OOM as a signal.** **Rejected**: silent unbounded growth.

**Sources**: Risk R6 in plan.md.

## Sources / References

- Issue #1054: <https://github.com/generacy-ai/generacy/issues/1054> — root incident + proposed fixes.
- Prior work #879: enqueueIfAbsent + in-flight SET pattern (`redis-queue-adapter.ts:22-30`).
- Prior work #1049: drop-gate transition-edge logging (`pr-feedback-monitor-service.ts:284-286`).
- `worker-dispatcher.ts:578-614` — existing `reapStaleWorkers` (the path this fix complements).
- `worker-dispatcher.ts:234-278` — existing `handleLeaseExpired` (source of the `queueReason: 'resume'` re-enqueue pattern).
- Redis docs: `SCAN` non-blocking semantics; `EVAL` / `EVALSHA` atomicity; `HDEL` behaviour with empty hashes.
- CLAUDE.md — changeset gate, no-premature-abstraction rule, comment discipline.
