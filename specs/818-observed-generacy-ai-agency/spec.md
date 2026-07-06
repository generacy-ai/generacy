# Feature Specification: Clarify Phase Gate-Skip Race

**Branch**: `818-observed-generacy-ai-agency` | **Date**: 2026-07-06 | **Status**: Draft | **Issue**: [#818](https://github.com/generacy-ai/generacy/issues/818) | **Type**: Bug

## Summary

The clarify phase intermittently completes without pausing on the `waiting-for:clarification` gate, allowing the phase loop to proceed into plan/tasks/implement even though the clarifying questions are unanswered. The bug is nondeterministic — the same workflow paused correctly on a prior issue (generacy#816) minutes earlier, then skipped the gate on agency#374 with identical configuration.

Observed on `generacy-ai/agency#374` on 2026-07-06: clarify posted the Batch 1 questions comment and added `waiting-for:clarification` at `20:38:41.090Z`, and at the same moment the stage comment marked clarify ✅ complete and plan began at `20:38:42.280Z` — with `waiting-for:clarification` still on the issue.

Per `docs/label-protocol.md`: "When a `waiting-for:*` label is present, the worker stops processing. The monitor watches for a matching `completed:*` label to resume." The gate skip silently violates this protocol.

## Root Cause Hypothesis

In `packages/orchestrator/src/worker/phase-loop.ts` (line ~418), the `on-questions` gate evaluation runs:

1. `integrateClarificationAnswers(context, logger)` — fetches issue comments and looks for `Q<n>:` patterns, integrates answers into local `clarifications.md`.
2. `hasPendingClarifications(checkoutPath, issueNumber)` — reads local `clarifications.md` and returns true if any question is still `*Pending*`.

`integrateClarificationAnswers` filters out question comments via `isQuestionComment()` before parsing answers. The filter recognises four marker patterns:

- `<!-- generacy-clarifications:N -->` (orchestrator-posted, plural)
- `<!-- generacy-clarification:` (CLI-posted, singular)
- `<!-- generacy-stage:` (stage comment)
- `## <emoji?> Clarification Questions` heading (fallback)

The race is between the clarify Claude CLI writing `clarifications.md` + posting the questions comment on GitHub, and the phase-loop gate check running `integrateClarificationAnswers` seconds later. If the Claude CLI posts a comment whose body does NOT match any of the four patterns above (e.g., a wording variant, a translation, or a slightly different heading), the answer parser sees each `Q<n>: Topic` heading in the questions body as an answer, overwrites `*Pending*` with the topic text, and `hasPendingClarifications` returns false. Gate skipped.

Alternatively, the answer regex at `clarification-poster.ts:326-327` is greedy across the whole comment body and may parse question topics from a comment that legitimately mixes references to Q1/Q2 in surrounding prose (e.g., "as per Q1: yes" in a discussion thread).

This is consistent with the observation that generacy#816 (control) paused correctly — the questions comment format for that run matched a marker; agency#374 didn't.

## Clarifications

Answers integrated from [clarifications.md](./clarifications.md) Batch 1 (2026-07-06):

- **Q1 (isQuestionComment detection rule)** → **B**: match `### Q<n>:` heading whose section contains ANY of `**Question**:`, `**Context**:`, or `**Options**:`. Rationale: the live failure comment self-matched via its "How to answer" example (`Q1: your answer here`), so FR-002's content-based skip would not have caught it — that makes `isQuestionComment` the primary defense and the widest reliable rule the right pick. Reflected in FR-001.
- **Q2 (US2 warn trigger timing)** → **C**: fire two distinct warns with different codes — `SKIPPED_SUSPICIOUS_ANSWER` (from FR-002 when the defense fires) and `TRANSITION_WITH_QUESTION_HEADINGS` (from FR-004 when a transition happens anyway). Rationale: collapsing them loses exactly the signal SC-001 needs (defense-working vs defense-failing). Reflected in FR-002 and FR-004.
- **Q3 (FR-003 timestamp safety net)** → **C**: drop FR-003 entirely. Rationale: `git checkout` does not preserve mtime reliably, GitHub-vs-cluster clock skew is real, and FR-001/FR-002 already close the same vector. One mechanism per job. Reflected by marking FR-003 as dropped.
- **Q4 (comment id plumbing)** → **A**: plumb the real GitHub numeric comment `id`. Widen `parseAnswersFromComments` input to `{ id: number; body: string; created_at?: string }`; widen `GitHubClient.getIssueComments` return shape. Rationale: only option that lets an operator jump straight to the offending comment. Reflected in FR-004.
- **Q5 (greedy regex fix scope)** → **A**: in scope. Add line-start anchoring to the `Q<n>:` answer regex; single parsing mode for all comments. Rationale: closes a second real vector (human "as per Q1: yes" prose) with the same root-cause class; one-line change, one regression test. Reflected in new FR-005 and FR-008.

## User Stories

### US1: Clarify gate always pauses when questions are pending

**As** a developer whose issue is being processed by a Generacy speckit workflow,
**I want** the orchestrator to reliably pause at `waiting-for:clarification` whenever there are unanswered clarification questions,
**So that** I have a chance to answer before the agent proceeds through plan/tasks/implement on assumed answers, and I don't have to notice the skip and manually requeue with `process:<workflow>`.

**Acceptance Criteria**:

- [ ] After the clarify phase runs, if `clarifications.md` contains any question with `**Answer**: *Pending*`, the phase loop MUST pause on `waiting-for:clarification` before advancing to plan — regardless of what content the just-posted questions comment contains.
- [ ] The gate MUST NOT be skipped because `integrateClarificationAnswers` misidentified the bot's questions comment as answers.
- [ ] The behaviour MUST be deterministic across runs with the same starting state.

### US2: Detecting a silent gate skip

**As** an orchestrator operator,
**I want** the orchestrator to log a warning when `integrateClarificationAnswers` transitions any question from pending to answered based on a comment that could plausibly be the bot's own questions comment,
**So that** we can detect and diagnose recurrences of this bug in production.

**Acceptance Criteria**:

- [ ] When `integrateClarificationAnswers` integrates ≥1 answer AND the comment source has any Q-heading pattern (`### Q<n>:`), the orchestrator logs at `warn` with the comment id and integrated count.
- [ ] Existing successful answer integration (from human comments) does NOT log at warn — only the suspicious case.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                            | Priority | Notes                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| FR-001 | `isQuestionComment(body)` MUST return `true` for any comment body that contains a `### Q<n>:` heading whose section (up to the next `### ` heading or end-of-body) contains ANY of `**Question**:`, `**Context**:`, or `**Options**:` markup — regardless of whether the dedup marker is present.                       | P1       | Primary fix. Per Clarifications Q1 (option B): all three markers are question-side markup that never appears in answer comments; picking the widest reliable rule catches variant question comments (e.g., ones omitting a literal `**Question**:`). |
| FR-002 | `parseAnswersFromComments` MUST skip any answer whose captured text contains `**Question**:` or `**Context**:` markup — these never appear in a human's answer format. When the skip fires, the orchestrator MUST log at `warn` with a distinct code `SKIPPED_SUSPICIOUS_ANSWER`, including source comment id, question number, and captured text excerpt. | P1       | Defense in depth against FR-001 being incomplete. Per Clarifications Q2 (option C): this warn surfaces near-misses when the FR-002 filter fires; it is distinct from FR-004. |
| FR-003 | **Dropped** per Clarifications Q3 (option C). A timestamp-based check against `clarifications.md` mtime was considered but rejected: `git checkout` does not reliably preserve mtime and GitHub-vs-cluster clock skew makes the comparison fragile. FR-001 + FR-002 close the same race window with fewer moving parts. | —        | If SC-001 shows residual skips after deployment, diagnose the specific new vector then rather than pre-committing to a timing heuristic.                                                                                                                                                                        |
| FR-004 | When `integrateClarificationAnswers` transitions a question from pending to answered from a comment whose body contains any `### Q<n>:` heading, the orchestrator MUST log at `warn` with a distinct code `TRANSITION_WITH_QUESTION_HEADINGS`, including the source comment id, question number(s), and answer text integrated. To surface the numeric comment id, the input to `parseAnswersFromComments` MUST widen from `Array<{ body: string }>` to `Array<{ id: number; body: string; created_at?: string }>`, and `GitHubClient.getIssueComments` MUST return `id` (and optionally `created_at`) on each comment. | P2       | Per Clarifications Q4 (option A): plumb the real GitHub numeric `id` all the way through so operators can jump straight to the offending comment. Per Clarifications Q2 (option C): this warn is distinct from FR-002's `SKIPPED_SUSPICIOUS_ANSWER` — it is the residual-race detector for vectors the filters don't cover. |
| FR-005 | `parseAnswersFromComments`'s `Q<n>:` answer regex MUST anchor matches at the start of a line (or immediately after a heading marker), so mid-prose references like "as per Q1: yes" no longer register as answers.                                                                                                     | P1       | Per Clarifications Q5 (option A): in-scope for this fix — line-start anchoring closes a second real vector independent of the bot's own comment. One parsing mode for all comments (not partial per Q5 option C).                                                                                                 |
| FR-006 | Regression test: when clarify posts a well-formed questions comment (matching the bot's own format), a subsequent phase-loop gate evaluation MUST NOT integrate any answers from that comment.                                                                                                                         | P1       | Automated test in `clarification-poster.test.ts`.                                                            |
| FR-007 | Regression test: when clarify posts a questions comment with a variant format (no marker, no "Clarification Questions" heading, but with `### Q<n>:` headings), the gate MUST still activate.                                                                                                                           | P1       | Automated test — the specific failure mode from #818.                                                        |
| FR-008 | Regression test: a comment body containing "as per Q1: yes" (or similar mid-prose Q-reference) MUST NOT cause `parseAnswersFromComments` to integrate an answer for Q1.                                                                                                                                                 | P1       | Regression test for FR-005 (line-start anchoring).                                                            |

## Success Criteria

| ID     | Metric                                                                                       | Target                                    | Measurement                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| SC-001 | Rate of clarify-phase gate skips when pending questions exist                                | 0 in 100 consecutive workflow runs        | Automated: seed 100 issues with a workflow that triggers clarify, assert `waiting-for:clarification` was hit    |
| SC-002 | Rate of false-positive answer integrations from the bot's own questions comment              | 0 across all existing regression fixtures | Vitest run of `clarification-poster.test.ts` — all existing + new tests pass                                    |
| SC-003 | Operator-visible warning fires when a suspicious answer integration is prevented             | 100% of test cases                        | Log capture in tests asserts the warn line                                                                      |
| SC-004 | No regression: legitimate human `Q1: my answer` replies from issue comments are still parsed | 100% of existing fixtures                 | Existing `parseAnswersFromComments` tests still pass                                                            |
| SC-005 | Mid-prose `Q<n>:` references (e.g., "as per Q1: yes") no longer register as answers          | 0 false-positive matches in fixture       | Regression test (FR-008) asserts `parseAnswersFromComments` returns no answers for a body containing only mid-prose Q-references |

## Assumptions

- The Claude CLI clarify command always writes `clarifications.md` with `**Answer**: *Pending*` markers before it posts the questions comment. (Verified in `plans/clarify.md`.)
- The GitHub API returns the just-posted questions comment in the `integrateClarificationAnswers` fetch — i.e., the race window is between the CLI posting and the phase-loop fetching, both inside the same cluster run.
- No human posts an answer whose format matches the bot's `### Q<n>: Topic\n**Context**:...\n**Question**:...` structure. Human answers use `Q1: text` or `Q1: <letter>`.

## Out of Scope

- Rewriting the entire clarification flow to use a machine-parseable JSON marker instead of markdown headings (deferred; would break existing Q&A comments already in flight).
- Fixing any client-side (dashboard) confusion caused by the stage comment showing clarify "complete" while `waiting-for:clarification` is still on the issue — this bug fix eliminates the state where both are true.
- Changing the `on-questions` gate condition to run only in the orchestrator (not the CLI). The CLI's own posting stays; only the orchestrator's answer-integration parser is tightened.
- Broader phase-loop refactoring or gate-config changes for other workflows (`speckit-feature`, `speckit-epic`, etc.). Only the `on-questions` gate path is touched.

---

*Generated by speckit — bug spec derived from generacy#818*
