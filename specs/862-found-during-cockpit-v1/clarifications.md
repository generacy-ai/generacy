# Clarifications — Resume Dedupe (#862)

<!-- Batch 1 -->
## Batch 1 — 2026-07-08

### Q1: Enqueue idempotency vs. explicit pre-check
**Context**: `RedisQueueAdapter.enqueue()` writes a distinct JSON-encoded member per call (the serialized item includes `enqueuedAt`, `queueReason`, `attemptCount`, so two calls for the same `itemKey` produce two distinct members in the sorted set). This means the `hasInFlight` check proposed in FR-002/FR-015 followed by a plain `enqueue` is racy under simultaneous webhook + poll: both callers can observe `hasInFlight === false`, then both ZADD. OQ-2 in the spec flagged this. Which shape do we want?
**Question**: How should the "collapse webhook+poll race" property (FR-003, SC-003) be enforced?
**Options**:
- A: `hasInFlight(itemKey)` + `enqueue()` as two separate calls in `LabelMonitorService`. Accept that a tightly interleaved webhook+poll pair may occasionally double-enqueue; the second worker will resume harmlessly (idempotent gate-check on the issue).
- B: Add a new atomic `QueueManager.enqueueIfAbsent(item)` primitive backed by a Lua script that checks a pending/claimed index and ZADDs in one Redis round trip. `hasInFlight` (FR-015) becomes an observability helper only.
- C: Change `enqueue()`'s contract to be itemKey-idempotent by default (no-op if the itemKey is already in-flight). All callers get race-free enqueue for free.

**Answer**: B — add an atomic `QueueManager.enqueueIfAbsent(item)` primitive backed by a Lua script (check pending/claimed index + ZADD in one round trip). Race-free collapse of the webhook+poll pair is the point of this spec (FR-003, SC-003); A tolerates exactly the race we're closing (two workers concurrently driving the same issue race labels and comments), and C silently changes a shared contract that requeue/retry callers rely on for intentional re-enqueue. `hasInFlight` (FR-015) stays as an observability helper only.

### Q2: In-flight lookup data model
**Context**: Neither `PENDING_KEY` (sorted-set members are opaque JSON strings, not indexed by `itemKey`) nor `CLAIMED_KEY_PREFIX<workerId>` hashes (spread across N workers, field = itemKey) are shaped for a cheap "is this itemKey in flight?" lookup. Any implementation of `hasInFlight` requires either a scan or a new secondary index. FR-013 requires covering *both* pending and claimed.
**Question**: Which storage strategy should the `hasInFlight` check use?
**Options**:
- A: Add a secondary Redis SET `orchestrator:queue:in-flight-items` (member = itemKey), maintained atomically alongside `enqueue`/`claim`/`complete`/`release` (extend the CLAIM_SCRIPT Lua). O(1) lookup, but four call sites must stay in sync.
- B: Scan pending sorted set (ZRANGE + JSON-parse each member) + `SCAN` all `claimed:*` hashes + `HEXISTS` per hash on every resume event. Correct and stateless; O(pending + workers) per call. Per A2 ("cheap enough at observed event rate") this is likely fine at current cluster sizes.
- C: Maintain per-itemKey marker key `orchestrator:queue:item:<itemKey>` with value `"pending"|"claimed"`, set/unset on state transitions. O(1) lookup with a slightly larger keyspace than option A.

**Answer**: A — secondary Redis SET `orchestrator:queue:in-flight-items`, maintained atomically alongside the existing transitions. O(1) lookup, and `SMEMBERS` gives operators a free "what's in flight right now" view. The four-call-sites-in-sync risk is neutralized by putting the SET updates inside the same Lua scripts that already own those state transitions (extend CLAIM_SCRIPT and the enqueueIfAbsent script from Q1) — one atomicity boundary, nothing to drift. B's scan cost recurs on every poll cycle × every open issue; C is A with a scattered keyspace and no cheap way to list in-flight items.

### Q3: Scope of the in-flight check — per-issue or per-(issue, gate)?
**Context**: A3 asserts "an issue can only be in one gate at a time," which implies `itemKey` (`owner/repo#issue`) is the right granularity. But the workflow *does* transition between gates within a single issue lifecycle (plan → tasks → implement → review). If a `completed:tasks` resume enqueues an item that's still claimed when `completed:implementation-review` arrives on the same issue (edge case — e.g., a stuck worker on the earlier gate), should the newer resume be dropped, or is it a distinct enqueue?
**Question**: Does `hasInFlight` key on `itemKey` alone (per A3), or on `(itemKey, gate)`?
**Options**:
- A: `itemKey`-only. Newer-gate resumes are dropped while an earlier-gate item for the same issue is in flight. Matches A3; simplest; the stuck-earlier-gate case is handled by the dispatcher's orphan reclaim, not by the resume path.
- B: `(itemKey, gate)`. Newer-gate resumes always enqueue as long as no *same-gate* item is in flight. Preserves per-gate parallelism (irrelevant today since one issue, one worker) but adds complexity for a case that A3 says shouldn't happen.

**Answer**: A — key on `itemKey` alone, per A3. One property worth stating explicitly in the spec: with in-flight-keyed dedupe, a dropped resume is deferred, not lost — the `waiting-for:*`/`completed:*` label pair persists on the issue, so the next poll cycle re-offers the event and the newer gate enqueues on the first poll after the earlier item drains. The stuck-earlier-gate case belongs to dispatcher reclaim, not the resume path.

### Q4: Orphaned-claim / dead-worker handling
**Context**: If a worker crashes mid-processing, its `claimed:<workerId>` hash entry persists until either the dispatcher's reclaim path runs or the heartbeat key expires. Naive `hasInFlight` would treat that orphaned claim as in-flight and permanently strand every future resume on that issue until reclaim fires — which is a new class of the same stranding bug this spec is fixing.
**Question**: How should `hasInFlight` handle claimed items whose owning worker's heartbeat has expired?
**Options**:
- A: `hasInFlight` treats any entry in a `claimed:*` hash as in-flight regardless of worker liveness. Rely on the dispatcher's existing reclaim path to run promptly; resumes stay dropped until reclaim fires (may take one heartbeat interval).
- B: `hasInFlight` cross-checks the `orchestrator:worker:<id>:heartbeat` key TTL — if absent/expired, treat the claim as not in-flight and enqueue. Prevents any orphan-driven stranding but overlaps responsibility with the dispatcher's reclaim path.
- C: `hasInFlight` looks at pending only; claimed state is ignored. Simpler and orphan-safe, but reintroduces the double-enqueue race between the resume path and a live in-progress worker on the same issue.

**Answer**: A — any entry in a `claimed:*` hash counts as in-flight; rely on the dispatcher's reclaim path. Same self-healing argument as Q3: worst case is drops bounded by one reclaim/heartbeat interval, after which the next poll enqueues — permanent stranding is impossible by construction, unlike the history-keyed design this spec replaces. B forks the "is this worker dead" judgment into two components with drift risk (`hasInFlight` declares the worker dead and enqueues while the dispatcher simultaneously reclaims and requeues — the exact double-enqueue we're preventing). C reintroduces the core race against a live in-progress worker.

### Q5: Observability for dropped resume events (spec OQ-3)
**Context**: When a resume event is dropped because `hasInFlight === true`, an operator debugging "why didn't my issue advance?" needs to see it. Spec OQ-3 recommends "one info-level log line."
**Question**: What signal should a dropped resume emit?
**Options**:
- A: One `info` log line only (per OQ-3 recommendation). Minimal surface area.
- B: Log + a Prometheus/metrics counter (e.g., `orchestrator_resume_dropped_total{reason="in-flight"}`) for dashboarding.
- C: Log + a `cluster.orchestrator` relay event so the cloud operator UI / cockpit can surface a per-issue drop count in-line.

**Answer**: A, with structure — one info-level log line per drop carrying `itemKey`, `gate`, and `reason: "in-flight"`. Because the poll re-offers the event every cycle, a stuck in-flight item emits a repeating drop line at poll cadence, which is itself a useful stuck-worker signal for operators. Add B's counter only if a metrics registry already exists in the orchestrator — do not build metrics infrastructure for this feature. C (relay event) is v2 scope; cockpit watch already classifies stuck/waiting states as actionable.
