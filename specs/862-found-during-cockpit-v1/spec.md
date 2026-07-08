# Feature Specification: Resume Dedupe — Key Against In-Flight Queue State, Not History

**Branch**: `862-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft
**Source Issue**: [generacy-ai/generacy#862](https://github.com/generacy-ai/generacy/issues/862)
**Related**: [#849](https://github.com/generacy-ai/generacy/issues/849) (paired-clear fix — this spec supersedes/deletes it), cockpit v1 smoke test [generacy-ai/tetrad-development#88](https://github.com/generacy-ai/tetrad-development/issues/88) finding #27

## Summary

`LabelMonitorService.processLabelEvent()` deduplicates resume events (i.e. `completed:<gate>` labels detected by webhook or poll) using a Redis key `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` with a 24-hour TTL. This key is **history-keyed**: once a `(issue, gate)` resume has been seen, further resumes on the same `(issue, gate)` pair are suppressed for 24h regardless of whether the *current* occurrence has actually been processed. This has stranded live issues three times so far. The last incident (`christrudelpw/sniplink#3`) happened *after* #849's paired-clear fix shipped, because the stranding key predated the fix.

The durable fix is to stop keying dedupe on history and start keying it on in-flight queue state. Dedupe's job is to prevent double-enqueue when webhook and poll both observe the same completed-label transition — that is exactly scoped by "is there already a queued or claimed queue item for this issue?" The queue already tracks per-issue items under a stable `itemKey` (`<owner>/<repo>#<issue>`). Replacing the phase-tracker resume key with a queue-level idempotency check makes stranding structurally impossible: the next resume occurrence can enqueue as soon as the previous item leaves the queue (completes or fails), with no cache to invalidate, no TTL to tune, and no paired-clear callback obligation on pause paths. The #849 machinery becomes deletable.

## User Stories

### US1: Operator — Approved Issues Resume Without Manual Redis Repair

**As an** operator of a Generacy cluster,
**I want** an approved issue at a gate to be re-processed automatically the next time its `completed:<gate>` label is observed,
**So that** I don't have to SSH into Redis and `DEL` phase-tracker keys to unstick workflows.

**Acceptance Criteria**:
- [ ] Given an issue at `waiting-for:implementation-review` that gets `completed:implementation-review` applied, when the next poll or webhook runs, exactly one queue item is enqueued and the worker resumes the workflow.
- [ ] This holds even if the same `(issue, gate)` pair had a *prior* resume 24h ago that left a stale phase-tracker key.
- [ ] This holds even if #849's paired-clear callback never ran on the current pause (e.g. because the pause predated #849, or the pause was applied through a code path that didn't wire the callback).
- [ ] Manual `redis DEL phase-tracker:*:resume:*` is never required to un-strand an approved issue.

### US2: Operator — Second Clarification Batch Resumes Correctly

**As an** operator running speckit clarify with multiple batches,
**I want** the second `completed:clarify` on the same issue (after a re-pause) to enqueue a resume,
**So that** multi-batch clarification workflows finish without manual intervention.

**Acceptance Criteria**:
- [ ] Pause → resume → re-pause → resume cycles all enqueue exactly one queue item per resume occurrence.
- [ ] No timing dependency on paired-clear callback ordering vs. label webhook arrival.

### US3: Developer — Delete #849's Paired-Clear Machinery

**As a** developer of the orchestrator,
**I want** to delete the paired-resume-dedupe-clear plumbing (`LabelManager.clearResumeDedupe` callback, `ClaudeCliWorkerDeps.phaseTracker`, `PhaseTrackerService` instantiation in worker-mode `server.ts`, and the paired-resume dedupe integration test),
**So that** I don't have to maintain per-pause-path callback obligations forever, and future contributors can't accidentally add a pause path that skips it.

**Acceptance Criteria**:
- [ ] After this feature ships, `LabelManager` no longer accepts or invokes any `clearResumeDedupe` callback.
- [ ] `packages/orchestrator/src/__tests__/paired-resume-dedupe-clear.integration.test.ts` is removed.
- [ ] No production code path constructs `phase-tracker:*:resume:*` keys.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `LabelMonitorService.processLabelEvent()` MUST NOT read, write, or delete any Redis key of the form `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` when handling a `resume` event. | P1 | Removes the history-keyed dedupe entirely. |
| FR-002 | `LabelMonitorService.processLabelEvent()` for `type === 'resume'` MUST determine "already in flight" by consulting the queue's in-flight state (pending + claimed) for this issue, keyed on the queue's existing per-issue `itemKey` (`<owner>/<repo>#<issue>`). | P1 | Uses the existing `buildItemKey` shape from `redis-queue-adapter.ts:44`. |
| FR-003 | If an in-flight queue item for the same `itemKey` exists at the moment of the resume check, the incoming resume event MUST be dropped (logged as "already in flight, skipping") and MUST NOT produce a second enqueue. | P1 | This is the collapse-webhook+poll-race property that dedupe existed to provide. |
| FR-004 | Once the in-flight queue item completes (worker acks) OR fails (dead-lettered / retries exhausted), a subsequent resume event for the same `(issue, gate)` MUST enqueue without requiring any cache invalidation, key deletion, or TTL expiry. | P1 | This is the stranding-impossibility property. |
| FR-005 | The `process` event dedupe path (label `process:*`) MAY continue to use the phase-tracker (`phase-tracker:<owner>:<repo>:<issue>:<parsedName>`), because `process` events are guarded by an idempotent label-removal step and are not subject to the same history-key stranding class. | P2 | No behavior change for `process`. Kept out of scope to keep the change surgical. |
| FR-006 | `LabelManager.onGateHit()` MUST no longer accept or invoke a `clearResumeDedupe` callback. The `ClearResumeDedupeCallback` type and the `clearResumeDedupe?` constructor argument added in #849 MUST be removed. | P1 | Deletes #849's paired-clear plumbing. |
| FR-007 | `ClaudeCliWorkerDeps.phaseTracker` (the optional field added in #849 to thread `PhaseTrackerService` into `LabelManager`) MUST be removed. | P1 | Deletes #849's paired-clear plumbing. |
| FR-008 | The worker-mode `PhaseTrackerService` instantiation added in #849 to `server.ts` (~line 291) MUST be removed. The full-mode `PhaseTrackerService` instantiation (still used by `process` events) MAY remain. | P2 | Only the worker-mode duplicate is deleted. |
| FR-009 | The regression test `packages/orchestrator/src/__tests__/paired-resume-dedupe-clear.integration.test.ts` MUST be removed. | P2 | The test asserts a mechanism that no longer exists. |
| FR-010 | New regression test: pause → resume → re-pause → resume for the same `(issue, gate)` produces exactly two enqueues (one per resume occurrence). | P1 | The #849 case, kept green under the new mechanism. |
| FR-011 | New regression test: an issue with a *pre-existing* stale `phase-tracker:*:resume:<gate>` key in Redis (simulating pre-#849 state) still enqueues on the next resume event. | P1 | The #862 case — impossible by construction once history keys are gone. |
| FR-012 | New regression test: webhook and poll fire the same `completed:<gate>` transition within the same tick. Exactly one queue item is enqueued. | P1 | The double-enqueue race that dedupe existed to prevent. |
| FR-013 | When the queue backend is `RedisQueueAdapter`, the in-flight check MUST cover both the pending sorted set (`orchestrator:queue:pending`) and any claimed hash (`orchestrator:queue:claimed:*`). | P1 | An item that has been claimed but not yet completed is still in-flight. |
| FR-014 | When the queue backend is `InMemoryQueueAdapter` (dev/test), the in-flight check MUST cover the equivalent in-memory pending + claimed structures. | P1 | Parity for dev/test paths. |
| FR-015 | The in-flight check MUST be exposed via a new `QueueManager.hasInFlight(owner, repo, issueNumber): Promise<boolean>` (or equivalent) method rather than by `LabelMonitorService` reaching into adapter internals. | P2 | Keeps the queue abstraction intact. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero-config recovery from pre-existing stale resume keys | Any pre-existing `phase-tracker:*:resume:*` key in Redis is ignored by the resume path; no operator action required | Manually seed a stale key → send a resume event → observe enqueue in logs |
| SC-002 | Zero paired-clear obligations | `grep -r "clearResumeDedupe\|phase-tracker.*resume" packages/orchestrator/src/` returns no production hits (test-file matches allowed only if verifying the *absence* of the mechanism) | grep after implementation |
| SC-003 | Double-enqueue race still collapsed | Fire webhook + poll for the same `completed:<gate>` label within 100ms → exactly one queue item enqueued | Integration test with fake webhook + poll firing simultaneously |
| SC-004 | Repeat-cycle throughput preserved | Pause → resume → re-pause → resume cycle completes with two distinct queue items (one per occurrence), no drops | Integration test |
| SC-005 | Stranding incident count | Zero further stranding incidents attributable to `phase-tracker:*:resume:*` in the 30 days following deployment | Production log / operator report count |
| SC-006 | Code deletion | Net line count of the change is negative (i.e. more lines deleted than added, once #849's machinery comes out) | `git diff --stat` on the merge commit |

## Assumptions

- **A1**: The queue adapter interface (`QueueManager`) can be extended with an `hasInFlight`-style method without breaking downstream consumers.
- **A2**: Reading pending + claimed state from Redis on every resume event is cheap enough at the observed event rate (poll interval ~seconds, webhook cadence low) that no additional caching is needed.
- **A3**: The `itemKey` shape (`<owner>/<repo>#<issue>`) is stable and is the correct granularity for "an issue is in flight" — i.e. we do not need per-gate uniqueness because an issue can only be in one gate at a time.
- **A4**: `process` events do not exhibit the stranding class (their dedupe is guarded by the idempotent trigger-label removal after enqueue), so they are out of scope for this change.
- **A5**: `PhaseTrackerService` continues to have callers other than the resume path (specifically the `process` path in `LabelMonitorService`), so the service itself is not deleted — only the resume-specific keys and #849's worker-mode paired-clear instantiation.

## Out of Scope

- Changing dedupe behavior for `process` events (kept unchanged per FR-005).
- Deleting `PhaseTrackerService` entirely (still used by `process` events).
- Changing the queue adapter's storage layout (`buildItemKey`, `PENDING_KEY`, `CLAIMED_KEY_PREFIX` all stay).
- Changing the `LabelEvent` payload shape or the webhook/poll ingestion path.
- Backfilling / migrating existing stale `phase-tracker:*:resume:*` keys — they will simply be ignored and expire naturally under their existing TTL.
- Cockpit-side or cloud-side changes.

## Open Questions for Clarification

- **OQ-1**: Should `hasInFlight` be added to `QueueManager` as a new public method, or should the check be implemented as a helper that reaches into adapter-specific storage? *(Recommendation: new public method, per FR-015.)*
- **OQ-2**: On webhook+poll race, is there any observable difference between "first one wins the enqueue, second one silently drops" vs. "both attempt to enqueue and the queue's own idempotency handles it"? *(If `QueueManager.enqueue` is already idempotent on `itemKey`, we may not need FR-002/FR-003 to be an explicit pre-check — the queue could self-deduplicate.)*
- **OQ-3**: Do we want to keep any observability on the "resume dropped because already in flight" case? *(Recommendation: yes, one `info`-level log line, since it's the primary event a debugging operator would look for.)*

---

*Generated by speckit, enhanced from generacy-ai/generacy#862.*
