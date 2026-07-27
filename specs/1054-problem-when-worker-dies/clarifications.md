# Clarifications — #1054

Speckit clarify phase. Answers are consumed by `/plan`, `/tasks`, and `/implement`.

## Batch 1 — 2026-07-27

### Q1: Age-escalation threshold source and default

**Context**: FR-006 requires the drop-log line to escalate from `info` to `warn` when the in-flight entry's age exceeds "the maximum plausible run duration." FR-012 constrains any new configurable knob to have a documented default derivable from existing signals, and lists candidates: `shutdownTimeoutMs × N`, or the observed CLI timeout of 20 min (1,200,000 ms). The Assumptions section suggests 20–30 min as a heuristic. The implementer needs one canonical answer so FR-006, FR-007, and SC-001/SC-003/SC-005 all reference the same value.

**Question**: How should the age-escalation threshold be sourced and defaulted?

**Options**:
- A: New `maxRunDurationMs` field on `DispatchConfigSchema`, default `1_800_000` (30 min — the upper end of the Assumptions range; comfortably above the 20 min CLI timeout that produced the observed incident).
- B: New `maxRunDurationMs` field on `DispatchConfigSchema`, default `1_200_000` (20 min — exactly the observed CLI timeout, matches the natural "no run should legitimately exceed the hard timeout" ceiling).
- C: No new knob — derive at read time from `shutdownTimeoutMs × 12` (or similar multiplier) so tuning stays with the existing knob.
- D: No new knob — hardcode `1_800_000` (30 min) as a `MAX_RUN_DURATION_MS` module constant; make it configurable only if operators later ask.

**Answer**: *Pending*

### Q2: Reclaim atomicity primitive

**Context**: FR-002 requires the reclaim's three writes (`SREM in-flight`, `re-enqueue pending`, `HDEL/DEL claim hash`) to be co-atomic so a concurrent live-worker `complete()` cannot race into double-enqueue. FR-004 additionally requires a mid-check heartbeat re-appearance to abort the reclaim, phrased as "`WATCH` on the heartbeat key with abort-on-change is the equivalent primitive." The existing codebase uses Lua scripts (`CLAIM_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, `RELEASE_SCRIPT`) rather than `MULTI`/`WATCH` for its hot-path atomicity. The two approaches have different failure modes and testing overhead.

**Question**: Which Redis atomicity primitive should the reclaim use?

**Options**:
- A: New Lua script (`RECLAIM_ORPHAN_SCRIPT`) — checks `EXISTS heartbeat`, aborts if present, otherwise performs `HDEL`+`DEL`+`SREM`+`LPUSH pending`. Matches the existing pattern; single round trip; server-side atomicity is guaranteed. Grace-window check (FR-005) is embedded via a Lua `now`-vs-`enqueuedAt` comparison.
- B: `MULTI`/`EXEC` with `WATCH` on the heartbeat key — if the heartbeat is `SET` between `WATCH` and `EXEC`, the transaction aborts and the reclaim is skipped for that claim. More client round trips; matches the `WATCH` phrasing in FR-004 but not the existing Lua-script pattern.
- C: Hybrid — Lua script for the write path (A), plus a preceding `WATCH`-based guard for the heartbeat re-appearance check. Redundant with Lua's own atomicity guarantee; adds no value if A is chosen.

**Answer**: *Pending*

### Q3: `attemptCount` handling on reclaim

**Context**: The claim hash payload includes `attemptCount` (0 in the observed incident). When the reaper re-enqueues the item, it can (a) preserve `attemptCount` as-is — treating "the worker died without executing" as a non-attempt, or (b) increment `attemptCount` — treating any claim followed by a death as a failed attempt. This matters for pathological cases: if a specific item consistently kills its worker (e.g. OOM on a giant PR diff), preserving means the item keeps re-entering the queue forever; incrementing means it eventually hits `maxAttempts` and dead-letters, which matches `release()`'s existing failure-path semantics. The spec is silent on this and the `handleLeaseExpired` path (`worker-dispatcher.ts:267-273`) does not increment either — but that path predates the observed wedge.

**Question**: On orphan reclaim, should `attemptCount` be incremented or preserved?

**Options**:
- A: Increment `attemptCount` on every reclaim. If `attemptCount + 1 >= maxAttempts`, the reaper sends the item to the dead-letter queue instead of re-enqueueing it. Protects against loops where a specific item consistently kills its worker.
- B: Preserve `attemptCount` unchanged. Matches `handleLeaseExpired`'s existing behaviour. Simpler; risks infinite reclaim loop for a genuinely pathological item.
- C: Increment `attemptCount`, but never dead-letter from the reaper path — always re-enqueue regardless of `attemptCount`. Splits the difference: pathological loops are visible via the counter but not gated on it (dead-letter stays a code-path invoked only from `release()`).

**Answer**: *Pending*

### Q4: Log severity — single-tier or two-tier escalation

**Context**: FR-006, FR-007, and FR-008 all say `warn` "or higher." The "or higher" phrasing leaves room for a two-tier scheme where mildly-stale entries escalate to `warn` and severely-stale ones escalate to `error`. A single tier is simpler; a two-tier keeps alerting granular. The operator paging surface is the target audience — FR-008 explicitly names "an operator paging on `warn`s." Whether they should also page on `error`s at a longer horizon is a policy decision.

**Question**: Should log escalation be single-tier (`warn` only, past threshold) or two-tier (`warn` past threshold, `error` past a second longer threshold)?

**Options**:
- A: Single tier — one threshold (Q1's answer), one severity (`warn`) at both the adapter drop site (FR-006), the four monitor sites (FR-007), and the reclaim event (FR-008). Simplest; single knob to tune.
- B: Two tiers — `warn` past threshold `T`, `error` past `2 × T`. Applies uniformly to FR-006, FR-007, and FR-008. Two thresholds derived from Q1's answer (T and 2T); no second knob.
- C: Two tiers with separate signals — FR-006/FR-007 (drop-side, visible on every monitor cycle) stays at `warn` regardless of age; FR-008 (reclaim-side, fires once per orphan) always `warn`. No `error`-level escalation anywhere; keep alerting simple.

**Answer**: *Pending*

### Q5: In-memory adapter behaviour for FR-006/FR-007 log escalation

**Context**: FR-011 says the in-memory adapter's *reclaim path* may be a no-op if it has no equivalent orphan case ("verify during /plan"). The log escalation from FR-006/FR-007 is a separate concern: the drop log at `in-memory-queue-adapter.ts:89` fires whether or not orphans exist. If tests inject in-flight age via the in-memory adapter, the escalation rule should apply uniformly for behavioural parity — or the in-memory path can stay `info`-only if the wedge is Redis-specific in practice.

**Question**: Should the in-memory queue adapter apply the FR-006/FR-007 log escalation rule?

**Options**:
- A: Yes — `InMemoryQueueAdapter.enqueueIfAbsent` inherits the same age-vs-threshold escalation. Keeps behavioural parity so tests written against either adapter observe the same signal.
- B: No — in-memory adapter stays `info`-only. The wedge is a Redis-specific liveness hole; the in-memory adapter's process death is total, so no orphan can survive.
- C: Yes for the log escalation, no for a reclaim sweep — the log line escalates via a shared helper (or copy-pasted rule); no `reapOrphanClaims`-equivalent is added to the in-memory adapter.

**Answer**: *Pending*
