# Feature Specification: fix `cockpit_context` clarification-comment finder against label re-application

**Branch**: `995-summary-cockpit-context-issue` | **Date**: 2026-07-18 | **Status**: Draft
**Issue**: [#995](https://github.com/generacy-ai/generacy/issues/995)
**Workflow**: `speckit-bugfix`
**Related**: [#993](https://github.com/generacy-ai/generacy/issues/993), [#987](https://github.com/generacy-ai/generacy/issues/987), [#976](https://github.com/generacy-ai/generacy/issues/976)

## Summary

`cockpit_context(issue)` on a `waiting-for:clarification` issue currently returns `clarificationComment: null` whenever the `waiting-for:clarification` label has been **re-applied** (by requeue, boot-resume, cluster restart — or, before #993, the resume loop) *after* the clarification-question comments were posted. `/cockpit:auto`'s D.1 dispatch needs that question list to draft answers; with `null`, it can't, so it falls back to a direct `gh` inspection — the engine bundle stops being the source of truth.

The fix replaces the label-timeline heuristic in `findClarificationComment` with a positive-identification strategy anchored on the `CLARIFICATION_QUESTION_MARKERS` registry so that comment-identification survives arbitrary re-application of the gate label.

## Root cause (current behavior)

`findClarificationComment` (`packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts`):

1. Walks the issue timeline, finds the **most-recent** `labeled` event for `waiting-for:clarification` → `labelTime`.
2. Returns the first comment (ascending) with `createdAt >= labelTime` that isn't a stage-status comment.

Because `waiting-for:clarification` is re-applied by requeue / boot-resume / restart **without re-posting the questions**, `labelTime` jumps ahead of every existing question comment and the `>=` filter rejects them all → `null`.

Evidence (snappoll #8, 2026-07-18) confirms the failure: label re-applied at `04:31:08Z` while the last question comment was posted at `03:02Z`.

Secondary defect: not every question comment currently carries a leading HTML marker on line 0 (some batch comments emit `## ❓ Clarification questions — Batch 2` as their first line, with the `<!-- generacy-clarifications:N -->` marker only on a sibling comment). A marker-only finder must therefore either (a) match whichever batch actually carries the open-question list, or (b) require the poster to emit a consistent marker on every batch comment.

## User Stories

### US1 (P1): Cockpit auto continues to draft clarification answers after a cluster restart

**As a** `/cockpit:auto` operator whose cluster has just been restarted (or whose issue has just been requeued),
**I want** `cockpit_context` to still return the current clarification-question comment,
**So that** D.1 dispatch can draft answers from the engine bundle instead of degrading to a direct `gh` inspection.

**Acceptance Criteria**:
- [ ] `cockpit_context(issue)` on an issue whose `waiting-for:clarification` label was re-applied *after* the question comments were posted returns a non-null `clarificationComment`.
- [ ] The returned comment is the one carrying the *latest* batch of open questions (multi-batch case).
- [ ] `/cockpit:auto` D.1 succeeds against the engine bundle without any `gh issue view` fallback path being taken.

### US2 (P2): Regression coverage encodes the failure mode

**As a** maintainer of the cockpit clarification plumbing,
**I want** a regression test that reproduces the "late label re-apply + earlier question comment" timeline,
**So that** the failure mode described in #995 cannot silently reappear.

**Acceptance Criteria**:
- [ ] A unit test constructs a fixture where the latest `waiting-for:clarification` timeline event post-dates every question comment; `findClarificationComment` returns the question comment (not `null`).
- [ ] A unit test with two batch comments returns the latest batch.
- [ ] Existing behavior (fresh clarification, no re-apply) remains covered and passing.

### US3 (P2): Marker inventory stays single-source-of-truth

**As a** maintainer adding a new clarification-question dialect,
**I want** the finder to key off the same `CLARIFICATION_QUESTION_MARKERS` (or `MACHINE_MARKERS`) registry the rest of the clarification plumbing uses,
**So that** dialect drift can't reopen this class of bug.

**Acceptance Criteria**:
- [ ] The finder imports its marker set from `packages/orchestrator/src/worker/clarification-markers.ts` (or a shared re-export) — no local duplication.
- [ ] Adding a new engine dialect requires appending to `CLARIFICATION_QUESTION_MARKERS` only; the finder picks it up with no additional edits.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                             | Priority | Notes |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | `findClarificationComment` MUST return a non-null `IssueComment` when the issue carries a comment matching the `CLARIFICATION_QUESTION_MARKERS` registry, regardless of the relative ordering of comment vs label events. | P1       | Core fix. |
| FR-002 | When multiple question-marker comments exist on the issue, `findClarificationComment` MUST return the one with the *latest* `createdAt`.                                                                                | P1       | Multi-batch case. |
| FR-003 | `findClarificationComment` MUST continue to skip stage-status comments (`<!-- generacy-stage:planning`, `specification`, `implementation`, and the `speckit-*` variants).                                                | P1       | Existing exclusion preserved. |
| FR-004 | The finder MUST NOT introduce a heading-based matcher for marker-less batch comments. The durable fix is poster-side: the clarification poster MUST emit a `<!-- generacy-clarifications:N -->` marker at column 0 on EVERY batch comment (one comment per batch, no marker-less-heading + separate-marker-sibling split). Legacy marker-less batches remain unrecoverable by this finder and fall through to FR-005's fallback (and, in `/cockpit:auto`, its existing `gh` degradation path) until re-posted. The poster change is tracked as a REQUIRED companion issue/PR in this repo, landed promptly. | P1       | Resolved via clarification Q1: option A. Companion PR covers the poster; this PR keeps the finder marker-only. Adding a heading matcher (options B/C) is explicitly rejected as the divergent, brittle matcher FR-006 warns against. |
| FR-005 | If no comment carries a question marker, the finder MUST fall back to the current label-timeline heuristic (post-label comment, skipping stage-status comments) before returning `null`. The fallback path MUST emit a single-line `warn`-level log (`marker-less clarification comment; poster should be updated — issue=<owner/repo#N>`) so we can measure how many issues still hit it. The fallback is removed in a follow-up once FR-004's poster fix has made markers universal. | P1       | Resolved via clarification Q2: option C (union with deprecation warning). Prevents regressing marker-less-but-normal-timing issues that work today via the label-timeline heuristic. The fallback is literally today's code path — no new complexity. |
| FR-006 | Marker matching MUST be line-anchored at column 0, case-sensitive, as defined by `matchClarificationQuestionMarker` — the finder must not introduce a divergent matcher.                                                | P1       | Prevents parser drift. |
| FR-007 | The change MUST ship with a `.changeset/*.md` entry (patch bump for `@generacy-ai/generacy`, per `workflow:speckit-bugfix` convention).                                                                                  | P1       | CI gate. |
| FR-008 | No changes to the label protocol, the resume-loop plumbing (#993), or the `waiting-for:clarification` label lifecycle. Fix is confined to comment identification.                                                       | P1       | Scope guard. |

## Success Criteria

| ID     | Metric                                                                                             | Target                                                    | Measurement |
|--------|----------------------------------------------------------------------------------------------------|-----------------------------------------------------------|-------------|
| SC-001 | `cockpit_context` returns a non-null `clarificationComment` on a re-applied-label fixture.         | 100%                                                      | New unit test in `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts` (or equivalent). |
| SC-002 | Latest-batch selection is correct for multi-batch fixtures.                                        | 100%                                                      | Unit test with 2+ question-marker comments. |
| SC-003 | No `gh issue view` fallback path fires from `/cockpit:auto` D.1 on a re-applied-label issue.       | 0 fallbacks in a full snappoll cycle.                     | Manual verification against the snappoll #8 scenario or a synthetic reproduction. |
| SC-004 | Existing `findClarificationComment` unit tests continue to pass.                                   | 100%                                                      | `pnpm test` in `packages/generacy`. |
| SC-005 | Bug does not silently regress.                                                                     | New regression test fails on a git-revert of the fix.     | CI. |

## Assumptions

1. `CLARIFICATION_QUESTION_MARKERS` in `packages/orchestrator/src/worker/clarification-markers.ts` is the canonical registry and either already is importable from `@generacy-ai/generacy`'s cockpit code, or can be re-exported / duplicated in a shared location without ownership friction. If not, a small refactor to expose it may be required.
2. The current stage-status exclusion list in `clarification-comment-finder.ts` (`STAGE_STATUS_REJECT_PREFIXES` + `CLARIFICATION_STAGE_OVERRIDE_PREFIXES`) is correct and remains the source of truth for skipping stage banners — the fix does not touch it.
3. `/cockpit:auto`'s D.1 dispatch reads the returned `clarificationComment.body` and parses it for `Q<n>:` prompts; no downstream consumer requires the *first-after-label* semantics — they all just want "the current open-question comment".
4. Batch heading comments and marker-tagged comments always originate from the engine (never from a human), so treating a marker as sufficient evidence of a question comment is safe.

## Out of Scope

- Changes to the poster that emits clarification-question comments live in a REQUIRED companion PR (per FR-004 resolution), tracked as a follow-up issue in this repo. That companion PR is not blocked by this fix and vice versa, but SC-003 assumes both have landed before the snappoll measurement.
- Changes to the `waiting-for:clarification` label lifecycle, boot-resume behavior (#824), or the resume loop (#993).
- Changes to the answer-scanner (`clarification-poster.ts::integrateClarificationAnswers`) or the answer-monitor (`clarification-answer-monitor-service.ts`).
- Cross-repo / multi-issue clarification correlation.
- Any refactor of `findClarificationComment`'s public signature — it stays `(gh, repo, number) → Promise<IssueComment | null>`.

## Clarifications

All open clarifications resolved on 2026-07-18 (see `clarifications.md` Batch 1):

- **Q1** (FR-004): Poster-side fix only. The finder stays marker-only; a companion PR updates the poster to emit `<!-- generacy-clarifications:N -->` on every batch comment. Heading-based finder matchers (options B/C) are explicitly rejected as the divergent matcher FR-006 warns against.
- **Q2** (FR-005): Union with deprecation warning. Marker-based primary, label-timeline fallback when zero markers exist, `warn`-level log on fallback for measurement. Fallback removed in a follow-up once Q1's poster fix has made markers universal.

---

*Generated by speckit — enhanced from GitHub issue #995 on 2026-07-18*
