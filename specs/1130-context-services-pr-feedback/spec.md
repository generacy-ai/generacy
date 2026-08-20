# Feature Specification: PR-feedback monitor — exclude engine threads, route external feedback into remediate

**Branch**: `1130-context-services-pr-feedback` | **Date**: 2026-08-20 | **Status**: Draft

## Summary

Today `PrFeedbackMonitorService` triggers on any unresolved *trusted* review thread and
enqueues the legacy fixer (`worker/pr-feedback-handler.ts`). With the engine-native review
& remediate phases (epic #1120), the engine now posts its **own** review threads carrying an
engine-authored marker (#1125/#1127). Those self-authored threads must never re-trigger the
monitor — otherwise the monitor and the engine race on the engine's own review rounds.

At the same time, genuine **external trusted feedback** (e.g. the final human reviewer
requesting changes) must flow into the *same* remediate machinery the engine uses internally —
one loop, one round counter, one code path — rather than the separate legacy fixer. This
feature rewires the monitor to (a) exclude engine-authored threads from the trigger, and
(b) route external trusted feedback into a `remediate` re-entry, retiring the legacy fixer's
divergent dispositions (notably the `blocked:stuck-feedback-loop` dead-end) in favor of the
`remediation-limit` gate.

## Context

- Monitor: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`. Trust filter
  iterates unresolved threads' comments via `isTrustedCommentAuthor` (`:264-286`); Case A tail
  (`:388+`) checks a `blocked:*` label skip guard on the linked issue.
- Engine-authored marker helper already exists (shipped by #1127): `matchEngineAuthoredReviewMarker`,
  `commentCarriesEngineAuthoredReviewMarker`, and `ENGINE_AUTHORED_REVIEW_MARKERS` in
  `packages/orchestrator/src/worker/review-poster.ts`. Marker family: review body
  `<!-- generacy-engine-review round=<N> -->` and per-finding `<!-- generacy-finding:<id> -->`.
  Match rule: prefix substring, case-sensitive ASCII, line-anchored at column 0; `> `-quoted
  markers do not match.
- Legacy fixer: `packages/orchestrator/src/worker/pr-feedback-handler.ts`. Reads both inline
  threads AND review bodies (`:249-360`) so body-only findings are not dropped. Applies
  `blocked:stuck-feedback-loop` on stuck cycles.
- Remediate machinery (epic siblings #1124/#1125/#1126): `review`/`remediate` phases in
  `phase-loop.ts`; findings artifact; `waiting-for:remediation-limit` gate on exhaustion.
- Part of epic #1120 (engine-native review & remediate phases). Full design lives at
  `docs/engine-review-remediate-plan.md` (generacy-ai/tetrad-development).

## User Stories

### US1: Engine's own review threads never re-trigger the monitor (P1)

**As** the orchestrator running its engine-native review rounds,
**I want** the PR-feedback monitor to ignore review threads the engine itself authored,
**So that** the monitor and engine do not race on the engine's own review rounds and no
duplicate remediate re-entry is enqueued while a review round is in flight.

**Acceptance Criteria**:
- [ ] An unresolved thread whose comments are all engine-authored (marker-matched) is excluded
      from the trusted-unresolved count and does not cause an enqueue.
- [ ] During an active engine review/remediate loop, the monitor enqueues no remediate re-entry
      for engine-authored threads (no monitor/engine race).
- [ ] Engine-authored exclusion is by marker (and/or authorship), independent of the
      authorship-based human trust filter.

### US2: External trusted feedback enters the shared remediate loop (P1)

**As** a human reviewer submitting a CHANGES_REQUESTED review or inline threads,
**I want** my unresolved feedback to drive the engine's remediate phase,
**So that** my requested changes are addressed through the same converging review→remediate
loop the engine uses, with one round counter and one code path.

**Acceptance Criteria**:
- [ ] A trusted external unresolved thread (inline) enqueues a `remediate` re-entry, not the
      legacy fixer path.
- [ ] Findings are synthesized into the findings artifact from BOTH inline threads AND review
      bodies — body-only findings are not silently dropped.
- [ ] The re-entry converges: after remediation the engine re-reviews and, when clean, the PR
      returns to ready-for-review.
- [ ] Trust for humans remains authorship-based, never content-based — plain issue/PR comments
      from trusted humans are first-class feedback.

### US3: Retire the legacy fixer and its dead-end disposition (P2)

**As** a maintainer of the orchestrator,
**I want** `pr-feedback-handler` retired (or reduced to a thin adapter) and its dispositions
migrated into the remediate machinery,
**So that** there is a single feedback-handling path and the `blocked:stuck-feedback-loop`
dead-end is replaced by the `remediation-limit` gate.

**Acceptance Criteria**:
- [ ] External-feedback remediations count toward the remediation cap and, on exhaustion, land
      on the `waiting-for:remediation-limit` gate rather than `blocked:stuck-feedback-loop`.
- [ ] Existing legacy dispositions are migrated with no loss of coverage (or the handler remains
      only as an adapter into the shared path).
- [ ] No regression to: untrusted-notice episode behavior, the `blocked:*` skip guard, and the
      webhook+polling hybrid with adaptive interval.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The monitor MUST exclude engine-authored threads from the trusted-unresolved count using the engine-authored marker helper (`commentCarriesEngineAuthoredReviewMarker` / `ENGINE_AUTHORED_REVIEW_MARKERS`). | P1 | Marker and/or authorship; must not depend on human trust logic. |
| FR-002 | Human trust MUST remain authorship-based, never content-based; plain issue/PR comments from trusted humans stay first-class. | P1 | Preserve `isTrustedCommentAuthor` semantics. |
| FR-003 | A trusted external unresolved thread MUST enqueue a `remediate` re-entry into the shared review/remediate loop, not the legacy fixer. | P1 | One loop, one counter, one code path. |
| FR-004 | External feedback findings MUST be synthesized into the findings artifact from BOTH inline threads AND review bodies. | P1 | Preserve `pr-feedback-handler.ts:249-360` dual-source behavior. |
| FR-005 | External-feedback remediations MUST count toward the remediation cap and land on `waiting-for:remediation-limit` on exhaustion. | P1 | Replaces `blocked:stuck-feedback-loop`. |
| FR-006 | Human intervention MUST reset the remediation counter per the semantics defined below. | P1 | [NEEDS CLARIFICATION: what precisely constitutes "human intervention" that resets the counter — a new human review after cap? removing the gate label? a manual comment?] |
| FR-007 | The legacy `pr-feedback-handler` MUST be retired or reduced to an adapter, with its dispositions migrated into the shared path. | P2 | No loss of behavior coverage. |
| FR-008 | The `blocked:stuck-feedback-loop` dead-end MUST be removed in favor of the `remediation-limit` gate. | P2 | |
| FR-009 | The following existing behaviors MUST NOT regress: untrusted-notice episode behavior, the `blocked:*` skip guard, and the webhook+polling hybrid with adaptive interval. | P1 | |
| FR-010 | When an unresolved thread mixes engine-authored and trusted-external comments, the thread MUST still trigger on the external comment(s). | P1 | [NEEDS CLARIFICATION: confirm mixed-thread handling — exclude only if ALL comments are engine-authored.] |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Engine-authored threads triggering the monitor | 0 | Harness: engine posts its review threads; assert no remediate enqueue during engine rounds. |
| SC-002 | Human CHANGES_REQUESTED / inline threads routed to remediate | 100% | Harness: trusted human review triggers a remediate re-entry that converges through re-review. |
| SC-003 | Monitor/engine race during engine's own rounds | 0 | Harness: no duplicate enqueue while a review round is in flight. |
| SC-004 | Body-only findings dropped | 0 | Harness: a review-body-only finding appears in the synthesized artifact. |
| SC-005 | External-feedback remediation exhaustion disposition | `waiting-for:remediation-limit` (never `blocked:stuck-feedback-loop`) | Harness: exceed the cap and assert the gate label. |
| SC-006 | Regressions in untrusted-notice / `blocked:*` skip / adaptive-interval behavior | 0 | Existing monitor test suites remain green. |

## Assumptions

- The engine-authored marker helper (`review-poster.ts`) is the source of truth for identifying
  engine-authored threads and is already shipped (#1127).
- The `review`/`remediate` phases, findings artifact, and `waiting-for:remediation-limit` gate
  (#1124/#1125/#1126) are the target machinery that external feedback routes into.
- Epic siblings #1124/#1125/#1126/#1127 land before or alongside this work; this branch composes
  with (does not re-implement) their surfaces.
- A thread is "engine-authored" only when it carries an engine-authored marker at column 0 per
  the existing match rule (`> `-quoted markers and human replies do not qualify the thread).

## Out of Scope

- Re-implementing the engine review executor, findings artifact schema, or the review/remediate
  phase loop (owned by #1124/#1125/#1126).
- Changing the human trust predicate (`isTrustedCommentAuthor`) semantics.
- Cloud-side (generacy-cloud) review consumers.
- The adaptive polling interval mechanism itself (must be preserved, not modified).

---

*Generated by speckit*
