# Feature Specification: Zero-question clarify phase must not strand an issue

**Branch**: `1246-problem-if-clarify-phase` | **Date**: 2026-11-27 | **Status**: Draft
**Issue**: [#1246](https://github.com/generacy-ai/generacy/issues/1246) | **Workflow**: speckit-bugfix

## Summary

When a `clarify` phase determines a spec is unambiguous it produces **zero**
questions and never writes `clarifications.md`. The `on-questions` gate reads
this missing file as "pending clarifications" and pauses the issue at
`waiting-for:clarification` + `agent:paused`, where nothing can ever be
answered. Requeueing re-runs clarify with the same zero-question result, so the
issue is permanently stranded (observed on #1240: requeued twice, three clarify
runs, same outcome each time).

The fix is in `hasPendingClarifications`
(`packages/orchestrator/src/worker/clarification-poster.ts`): a missing
`clarifications.md` when the spec dir exists is the **normal** output of a
zero-question run and must resolve to "no pending questions" (gate skips,
workflow advances to `plan`). Genuinely ambiguous or anomalous states stay
fail-closed.

## Root Cause

`hasPendingClarifications` was changed in #958 (679d2e71, FR-007 "fail closed")
to return `true` on any `readFileSync` failure, undoing #332 ("skip
clarification gate when no pending questions"). A missing file was treated as an
unknown state, but it is actually what a zero-question clarify run always leaves
behind — `clarifications.md` is only written on the append (has-questions) path
of the `/clarify` playbook. The only branch that returns "no questions" (an
empty file) is never produced by anything.

## User Stories

### US1: Unambiguous spec advances automatically

**As a** maintainer running the speckit pipeline,
**I want** a clarify phase that finds zero questions to advance the workflow to the next phase,
**So that** an unambiguous spec is not stranded at `waiting-for:clarification` with nothing to answer.

**Acceptance Criteria**:
- [ ] A clarify run that writes no `clarifications.md` (spec dir present) lets the `on-questions` gate skip.
- [ ] The workflow advances to `plan` without a `waiting-for:clarification` / `agent:paused` pause.
- [ ] No `completed:clarification` force-advance override is needed.

### US2: Genuine anomalies still fail closed

**As a** maintainer,
**I want** real anomalies (missing spec dir, unreadable file, non-empty file with zero parsed questions) to still pause for human review,
**So that** the #958 fail-closed guarantee is preserved where the state is genuinely unknown.

**Acceptance Criteria**:
- [ ] A missing spec dir still returns pending (`true`).
- [ ] A non-ENOENT read error (EACCES, EIO, …) still returns pending (`true`).
- [ ] A non-empty `clarifications.md` that parses to zero questions still returns pending (`true`).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | When the spec dir exists and reading `clarifications.md` fails with `ENOENT`, `hasPendingClarifications` returns `false`. | P1 | The zero-question normal case. |
| FR-002 | On the ENOENT branch, log at info level (e.g. `no clarifications.md — clarify produced no questions`). | P2 | Observability for the advance decision. |
| FR-003 | A missing spec dir continues to return `true` (fail closed). | P1 | Specify output gone = real anomaly. |
| FR-004 | Non-ENOENT read errors (EACCES, EIO, …) continue to return `true` (fail closed). | P1 | Unknown state. |
| FR-005 | A non-empty file parsing to zero questions continues to return `true` (fail closed). | P1 | Unchanged from existing behaviour. |
| FR-006 | An empty (`''` after trim) `clarifications.md` continues to return `false`. | P1 | Existing no-questions path preserved. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero-question clarify phase strands at `waiting-for:clarification` | 0 occurrences | A spec-dir-present, no-file run advances to `plan`. |
| SC-002 | Fail-closed cases preserved | 100% | Missing spec dir / non-ENOENT error / non-empty-zero-question all return `true`. |
| SC-003 | #958 unit test (SC-006) updated | Passing | The missing-file ⇒ `true` assertion is updated to the new ENOENT ⇒ `false` behaviour. |
| SC-004 | New regression test added | Passing | A zero-question clarify (spec dir present, no file) makes the `on-questions` gate skip and the workflow advance to `plan`. |

## Assumptions

- Spec-dir presence is distinguishable from file absence at the point
  `hasPendingClarifications` runs (dir existence can be checked before the read).
- The `on-questions` gate in `phase-loop.ts` (~L1972) consumes
  `hasPendingClarifications` unchanged; only the helper's missing-file branch changes.

## Out of Scope

- Changing the `/clarify` playbook to write an empty `clarifications.md` on the
  no-questions branch (rejected: depends on the agent following the prompt — the
  exact drift #958 documents — and commits an empty file to every spec dir).
- The separate agency-MCP-unavailable-in-workers gap (`check_prereqs`,
  `manage_clarifications`); unrelated to this bug because the no-questions branch
  skips those tools anyway.

---

*Generated by speckit*
