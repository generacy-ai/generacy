# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #36

**Branch**: `879-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #36. Completes #862 — same disease, last remaining surface.

## Observed

`pr-feedback-monitor-service.ts` still dedupes enqueue via `PhaseTracker.tryMarkProcessed` (SET NX on `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback`, ~12–24h TTL). #862 replaced history-keyed dedupe with in-flight queue-state dedupe for the *resume* path, with the stated goal that the phase-tracker machinery be deletable — but the pr-feedback path wasn't migrated, so the machinery survives with per-surface settlement semantics (#869 FR-006's clear-on-exit here; #862's in-flight keying there).

Live consequence, caught during pre-flight for the #878 acceptance run: a stale key from the pre-#869 handler era (`…:sniplink:4:address-pr-feedback`, marked 2026-07-08T23:28Z when the zero-trusted exit never settled keys, ~8h TTL remaining at time of writing) would have silently blocked the **first** trusted enqueue after the #878 deploy — the loop would appear broken for hours and then spontaneously heal at TTL expiry. Any crash-shaped gap between mark and the handler's settle recreates this window going forward; TTL rescue is the same silent-strand failure #862 eliminated elsewhere.

## Proposal

Migrate the pr-feedback enqueue to the #862 mechanism: dedupe against in-flight queue state (`enqueueIfAbsent` / itemKey NX in the same atomic layer the resume path now uses), delete the `DEDUP_PHASE`/`tryMarkProcessed` usage and #869 FR-006's settlement obligations — in-flight state is self-clearing by construction, no TTL tuning, no per-exit-path bookkeeping. One dedupe mechanism, both surfaces; the PhaseTracker machinery becomes fully deletable as #862 intended.

Note the interaction guard from #869: with dedupe self-clearing, the zero-trusted path must (and does, post-#869) *not enqueue at all* — otherwise monitor+handler busy-loop. That contract is what makes this migration safe.

## Regression tests

- Trusted unresolved thread + no in-flight item → enqueues, regardless of any historical marker for the same issue/phase (the stale-key scenario).
- Trusted unresolved thread + item already pending/claimed → exactly one in-flight item (webhook+poll race collapses).
- Handler completes (any terminal path) → next trusted state re-enqueues on the following poll with no manual state clearing.
- Code-audit test (`trust-predicate-audit.test.ts` style): (i) neither `pr-feedback-monitor-service.ts` nor `pr-feedback-handler.ts` references `PhaseTracker`, and (ii) no `DEDUP_PHASE` declaration remains under `packages/orchestrator/src/**`. (See SC-004; the older raw grep shape is unreliable per clarification Q5.)

## Repro state

The stale key was deleted after capture (name, mark-era, and TTL recorded above) so the #878 acceptance run on christrudelpw/sniplink#4 / PR #14 measures the deployed fixes rather than pre-fix residue.


## User Stories

### US1: PR-feedback enqueue survives residual/stale history state

**As an** operator whose cluster carries stale `phase-tracker:*:address-pr-feedback` keys from a prior handler era (or a crash-shaped gap between mark and settle),
**I want** the first trusted PR-feedback state after a deploy or restart to enqueue on the next poll regardless of any historical marker,
**So that** the loop is not silently blocked for hours until a TTL expires and does not spontaneously "heal" at TTL boundaries.

**Acceptance Criteria**:
- [ ] Trusted unresolved thread + no in-flight item enqueues on the next poll even when a same-key `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` value is present in Redis.
- [ ] After the migration, no code path in `pr-feedback-monitor-service.ts` writes to any `phase-tracker:*:address-pr-feedback` key.
- [ ] A crash between "enqueue decision" and "handler settle" cannot leave dedupe state that blocks a subsequent trusted enqueue — because dedupe is derived from in-flight queue state, which self-clears when the item completes/fails/is dropped.

### US2: Webhook + poll races collapse to exactly one in-flight item

**As** the orchestrator processing simultaneous webhook and poll triggers for the same PR feedback state,
**I want** dedupe to be enforced by an atomic in-flight itemKey NX in the same layer the resume path uses (post-#862),
**So that** concurrent enqueue attempts produce exactly one in-flight item, not one-per-trigger, and both surfaces share a single dedupe mechanism.

**Acceptance Criteria**:
- [ ] Trusted unresolved thread + item already pending/claimed results in exactly one in-flight item across concurrent webhook and poll paths.
- [ ] Handler completes on any terminal path → next trusted state re-enqueues on the following poll with no manual key clearing.
- [ ] The `PhaseTracker` / `tryMarkProcessed` / `DEDUP_PHASE` machinery is fully deletable (no remaining callers for `address-pr-feedback`), completing the #862 intent.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `pr-feedback-monitor-service.ts` MUST dedupe enqueue against in-flight queue state (`enqueueIfAbsent` / itemKey NX) in the same atomic layer the resume path uses post-#862 — not against `PhaseTracker.tryMarkProcessed`. | P1 | Both surfaces converge on one dedupe mechanism. |
| FR-002 | All `PhaseTracker.tryMarkProcessed` / `DEDUP_PHASE`-shaped writes for the `address-pr-feedback` phase MUST be removed from `pr-feedback-monitor-service.ts`. No settlement/clear-on-exit paths for that key remain. | P1 | #869 FR-006's settlement obligations lapse for this surface. |
| FR-003 | The zero-trusted path MUST NOT enqueue at all. This is the interaction guard from #869 that keeps the migration safe: with dedupe self-clearing, an accidental zero-trusted enqueue would busy-loop monitor+handler. | P1 | Contract from #869 must be preserved and verified. |
| FR-004 | A trusted unresolved thread MUST enqueue regardless of any historical `phase-tracker:*:address-pr-feedback` marker for the same issue/phase (the stale-key scenario). | P1 | Regression target for the observed live consequence. |
| FR-005 | Concurrent webhook and poll triggers for the same PR feedback state MUST produce exactly one in-flight item (webhook+poll race collapses). | P1 | Atomic itemKey NX guarantees single-in-flight semantics. |
| FR-006 | After handler completion (any terminal path — success, failure, drop), the next trusted state on the following poll MUST re-enqueue with no manual state clearing. | P1 | Self-clearing derives from in-flight state, not TTL. |
| FR-007 | The `PhaseTracker` machinery MUST become fully deletable as a follow-up: no remaining `phase-tracker:*:address-pr-feedback` writes anywhere in the repo. | P1 | Completes #862's stated goal. Audit shape is now defined by SC-004 as a code-audit test, not a raw grep. |
| FR-008 | `pr-feedback-handler.ts` MUST delete its `DEDUP_PHASE` constant and all five terminal-path `phaseTracker.clear(owner, repo, issueNumber, DEDUP_PHASE)` calls in this PR. The handler was the settlement partner for a key nothing writes post-FR-002; retaining those calls is precisely the per-surface bookkeeping FR-002 targets, and FR-007's "no remaining callers for `address-pr-feedback`" is unsatisfiable while they stay. (Clarification Q1 → A.) | P1 | In-scope in this PR; not deferred. |
| FR-009 | When `enqueueIfAbsent` returns `false` because of an in-flight collision on the same itemKey, the monitor MUST emit a structured info log line containing at minimum `itemKey` and `reason: "in-flight"`. The current "silently dropped" fail-safe path at `redis-queue-adapter.ts:143` MUST NOT survive this PR: a repeating drop line at poll cadence is the operator's stuck-worker signal, and silence turns the Q2 drop window into an invisible failure mode. (Clarification Q2 → A.) | P1 | Diagnosability requirement carried over from #862's Q5. |
| FR-010 | The `waiting-for:address-pr-feedback` label MUST be added idempotently whenever trusted unresolved feedback is present on the PR, decoupled from the enqueue outcome — including when `enqueueIfAbsent` returns `false` due to an in-flight collision. Labels are the operator-facing state plane (cockpit `watch`/`status` render from them); enqueue is work scheduling. (Clarification Q3 → B.) | P1 | Combined with FR-009 gives the diagnosable picture: label present + repeating drop lines = feedback pending, blocked by in-flight item. |
| FR-011 | `PrFeedbackMonitorService` MUST NOT accept `PhaseTracker` as a constructor field/parameter after this PR. `server.ts` wiring and all test stubs of the monitor MUST be updated in the same PR — no dead DI. (Clarification Q4 → A.) | P1 | Tests are already touched (dedupe semantics change), so dropping the field is amortized. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Stale-key scenario no longer blocks first trusted enqueue | 100% | Regression test: seed `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` in Redis with any TTL, run monitor with a trusted unresolved thread and no in-flight item, assert enqueue fires on the first poll. |
| SC-002 | Webhook + poll race collapses to single in-flight item | 1 in-flight item | Test: fire simultaneous webhook + poll triggers against the same PR feedback state, assert queue depth == 1. |
| SC-003 | Handler-terminal → next poll re-enqueue works with zero manual key clearing | 100% | Test: run handler through each terminal path (complete, fail, drop), then re-poll with a trusted state, assert enqueue fires on the following poll. |
| SC-004 | No `address-pr-feedback` phase-tracker caller remains, verified by code-audit test | 0 offending references | Audit test in the `trust-predicate-audit.test.ts` style asserting: (i) neither `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` nor `packages/orchestrator/src/worker/pr-feedback-handler.ts` references `PhaseTracker` at all (identifier grep on the file), and (ii) no `DEDUP_PHASE` declaration remains anywhere under `packages/orchestrator/src/**`. The original `grep -R "phase-tracker"` shape false-passes because the string appears only in the key builder, not in callers, and the literal `'address-pr-feedback'` legitimately survives as the queue command name. (Clarification Q5 → B.) |
| SC-005 | Zero-trusted path does not enqueue | 0 enqueues on zero-trusted | Test: unresolved thread with only untrusted authors → no item is added to the queue on any poll. |

## Assumptions

- The #862 in-flight dedupe layer (`enqueueIfAbsent` / itemKey NX on the queue-state atomic layer) is production-hardened for the resume path and is safe to consume from a second surface without further changes.
- The #869 zero-trusted-does-not-enqueue contract is currently enforced in the monitor's shared predicate and continues to hold post-migration; without it, self-clearing dedupe would busy-loop.
- Existing in-flight items keyed by the current dedupe scheme do not need migration — the handler drains them naturally; the new dedupe applies to enqueues going forward.
- The itemKey shape used by the resume path (`${owner}/${repo}#${issueNumber}`, no `command` component) is intentionally per-issue single-in-flight: while a `continue`/`process` item is working issue N, a concurrent `address-pr-feedback` enqueue for the same issue is dropped and re-detected on the next poll after the in-flight item completes. This is confirmed as the intended semantics — a second worker concurrently pushing feedback fixes to the same branch is a race we must not create; single-writer-per-issue matches #862's Q3 resolution ("itemKey alone; an issue is in one gate at a time"). Unresolved-thread state persists on the PR, so the drop is deferred-not-lost. `buildItemKey` is NOT extended to include `command` in this PR. Diagnosability of the drop window is provided by FR-009 (structured drop log) and FR-010 (idempotent `waiting-for` label). (Clarification Q2 → A.)

## Out of Scope

- Deleting the `PhaseTracker` implementation itself (class, module, tests) — this PR removes the last `address-pr-feedback` caller so that a follow-up can delete the machinery cleanly. Note: handler-side cleanup (`pr-feedback-handler.ts` `DEDUP_PHASE`/`clearDedupe` removal) is IN scope this PR per FR-008 (clarification Q1 → A); only the `PhaseTracker` class deletion itself is deferred.
- Migrating other unrelated `phase-tracker:*` phases beyond `address-pr-feedback`.
- Changes to the #869 shared predicate (trusted-vs-untrusted classification) — this migration relies on the predicate's contract but does not modify it.
- Changes to the resume path's dedupe (already migrated in #862).
- Backfilling any historical `phase-tracker:*:address-pr-feedback` keys already in Redis — they expire on their own TTL and no longer influence enqueue decisions after this change.

---

*Generated by speckit*
