# Feature Specification: Harden clarification-comment-finder with a content guard for stage-status comments

**Branch**: `962-follow-up-from-960` | **Date**: 2026-07-16 | **Status**: Draft
**Source issue**: [#962](https://github.com/generacy-ai/generacy/issues/962) (follow-up to #960; upstream self-answer/auto-advance fix was #958 / PR #959)

## Summary

`findClarificationComment` in `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts`
picks the clarification batch **purely by timing** — it takes the most-recent
`waiting-for:clarification` label event and returns the first comment created
at-or-after that timestamp. There is no content check on the returned comment.

Today the finder is safe only because #958 stopped the engine from
self-answering and auto-advancing to `plan` (which is what posted the
`<!-- generacy-stage:planning -->` status table into the at-or-after window that
#960 tripped over). Any future path that posts a non-clarification comment right
after the label event would resurface the same symptom: `cockpit_context`
returning a stage-status table as if it were the clarification batch.

This spec adds a **content guard** so the finder is correct by construction: if
the only qualifying comment is a stage-status table (`<!-- generacy-stage:planning`,
`<!-- generacy-stage:specification`, `<!-- generacy-stage:implementation`, and
their `speckit-stage:` legacy equivalents), the finder returns `null` — a
distinguishable "absent" — instead of the table.

A regression test for #960's AC-2 pins the behaviour so the finder is no longer
indirectly dependent on the upstream #958 fix.

## User Stories

### US1: Cockpit surfaces a distinguishable "no clarification present" result

**As a** cockpit user (or an automation reading `cockpit_context`),
**I want** the clarification finder to return a distinguishable absent result
when the only post-label comment is a stage-status table,
**So that** downstream tooling never confuses a `generacy-stage:planning` status
table for the clarification batch and never asks a human to "answer" a status
comment.

**Acceptance Criteria** (mirrors issue #962):
- [ ] `findClarificationComment` never returns a comment whose body carries a
      `<!-- generacy-stage:planning`, `<!-- generacy-stage:specification`,
      `<!-- generacy-stage:implementation`, or corresponding
      `<!-- speckit-stage:*` prefix at column 0 of some line.
- [ ] When the only at-or-after candidate is such a stage-status comment,
      the finder returns `null`.
- [ ] The finder continues to return legitimate clarification-batch comments,
      including those carrying `<!-- generacy-stage:clarification` /
      `<!-- generacy-stage:clarification-batch-N` markers.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                        | Priority | Notes |
|--------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | The finder MUST apply a content guard to each at-or-after candidate before returning it. A candidate whose body is a "stage-status comment" (see FR-002) MUST be skipped, not returned.                                            | P1       | This is the residual hardening called out in #962's "Ask". |
| FR-002 | A comment counts as a **stage-status comment** iff its body contains, at column 0 of some line, any of: `<!-- generacy-stage:planning`, `<!-- generacy-stage:specification`, `<!-- generacy-stage:implementation`, `<!-- speckit-stage:planning`, `<!-- speckit-stage:specification`, `<!-- speckit-stage:implementation`. Match rule is prefix substring, case-sensitive ASCII, line-anchored (mirrors `commentCarriesQuestionMarker` in `packages/orchestrator/src/worker/clarification-markers.ts`). | P1       | Explicit allow-list, not a wildcard on `generacy-stage:` — see FR-003. |
| FR-003 | The content guard MUST NOT reject comments carrying the `<!-- generacy-stage:clarification` or `<!-- generacy-stage:clarification-batch-N` markers. Those are legitimate clarification comments stamped by the engine's clarification poster. | P1       | Regression risk: a naïve `startsWith('<!-- generacy-stage:')` guard would break the primary happy path. |
| FR-004 | When every at-or-after candidate is skipped by the guard, the finder MUST return `null` — the same "distinguishable absent" it returns when no timeline label event exists or no at-or-after comment exists.                        | P1       | AC-2 from the parent issue #960. |
| FR-005 | When multiple candidates exist at-or-after the label timestamp, the finder MUST continue to prefer the earliest by `createdAt` **among the candidates that survive the guard**, not the earliest overall. If the earliest is a stage-status comment but a later one is a legitimate clarification, return the later one. | P2       | Preserves the "first qualifying comment" contract while making it precise about what qualifies. |
| FR-006 | A regression test in `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts` MUST cover: only comment at-or-after the `waiting-for:clarification` event is a `<!-- generacy-stage:planning -->` table → finder returns `null`.                                                                | P1       | Direct AC-3 from #962. |
| FR-007 | A second regression test MUST cover FR-003: a comment at-or-after the label event carrying `<!-- generacy-stage:clarification-batch-1 -->` is returned unchanged. This guards against overzealous guarding.                       | P1       | Cheap insurance against a `startsWith('<!-- generacy-stage:')` regression. |
| FR-008 | A third regression test MUST cover FR-005: two candidates at-or-after — first is a `<!-- generacy-stage:planning -->` table, second is a real clarification batch → finder returns the second.                                     | P2       | Documents the "skip and keep scanning" semantic. |

## Success Criteria

| ID     | Metric                                                                                                                                | Target        | Measurement |
|--------|---------------------------------------------------------------------------------------------------------------------------------------|---------------|-------------|
| SC-001 | Direct test of AC-2 exists and passes without relying on the upstream #958 fix being present.                                          | Test passes   | `pnpm --filter @generacy-ai/generacy test clarification-comment-finder` — the new FR-006 case is red before the finder change, green after. |
| SC-002 | Legitimate clarification-batch comments (`<!-- generacy-stage:clarification[-batch-N]`) continue to be returned.                       | Test passes   | The existing tests in `clarification-comment-finder.test.ts` continue to pass; the new FR-007 case passes. |
| SC-003 | No production code path outside the finder is modified.                                                                                | 0 changed files outside `clarification-comment-finder.ts` and its test file (plus the mandatory changeset) | `git diff --stat` on the PR. |

## Assumptions

- The set of "stage-status" markers to reject is fixed to the three stage phases
  currently declared in `packages/orchestrator/src/worker/types.ts` (`specification`,
  `planning`, `implementation`) plus their `speckit-stage:*` legacy equivalents,
  as spelled in the issue body. If a future stage marker is added (e.g.
  `<!-- generacy-stage:review`), FR-002's allow-list must be extended
  explicitly — the guard is a positive allow-list, not a wildcard.
- `<!-- generacy-stage:clarification` and `<!-- generacy-stage:clarification-batch-N`
  are the only `generacy-stage:*` prefixes that must be treated as
  clarification content, and they are already the ones enumerated in
  `CLARIFICATION_QUESTION_MARKERS`. The finder MAY reuse the marker constants
  from that module rather than hard-coding strings, but this is an
  implementation choice deferred to `/plan`.
- `speckit-stage:*` markers are legacy but must still be rejected because
  archived issues can carry them; the issue body explicitly lists both
  namespaces.
- Match rule is line-anchored at column 0 (matches the existing
  `commentCarriesQuestionMarker` rule). Quoted (`> `-prefixed) markers do NOT
  trigger the guard — a human quoting a stage table while writing a real
  answer still gets their comment returned as the clarification batch.
- The `IssueComment` shape (`{ body, author, createdAt, url }`) exposes the
  comment body — no schema change required.

## Out of Scope

- Any change to the label-timing branch of the finder (walking the timeline for
  the latest `waiting-for:clarification` event, comparing `createdAt >=`
  labelTs). Scope is the returned-comment check only.
- Any change to `clarification-poster.ts`, `clarification-markers.ts`, or the
  stage-marker vocabulary in `packages/orchestrator/src/worker/types.ts`. This
  spec only *reads* those constants (directly or by literal); it does not
  modify them.
- Any content check that goes beyond the marker allow-list — e.g. parsing the
  comment body for `Q<n>:` structure. If the returned comment carries neither
  a stage-status marker nor a clarification-question marker, it is still
  returned (matches today's behaviour for human-authored comments).
- Upstream: any further work on #958's self-answer / auto-advance fix. That
  bug is closed; this spec is defensive.

---

*Generated by speckit; hand-edited per issue #962.*
