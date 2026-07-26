# Feature Specification: PR-feedback fixer must consume review bodies, not just inline threads

**Branch**: `1047-problem-orchestrator-s-pr` | **Date**: 2026-07-26 | **Status**: Draft | **Issue**: [#1047](https://github.com/generacy-ai/generacy/issues/1047)

## Summary

The orchestrator's PR-feedback fixer builds its prompt exclusively from **unresolved inline review threads**. Review **body** text (the top-level summary of a `gh pr review` submission) is never fetched from the GitHub API, never rendered into the fixer prompt, and never surfaced to the disposition logic. Every finding that cannot be anchored to a diff hunk — by definition, every finding about a file *not* in the diff — is silently dropped, round after round. This bug is structurally guaranteed to affect exactly the class of finding that most needs fixing: staleness introduced by the current change in files it doesn't touch (stale doc comments, superseded contracts, out-of-date reference types).

## Problem

`packages/orchestrator/src/services/pr-feedback-monitor-service.ts:203` builds the fixer's input list from `threads.filter(t => !t.isResolved)` — threads are the only source. `packages/orchestrator/src/worker/pr-feedback-handler.ts:436` renders each item as `{ id, path?, line?, body, author }`, a per-comment-with-a-location shape. A grep across the orchestrator for any review-body fetch (`listReviews`, `pulls/*/reviews`, `review.body`) returns nothing — the body is never requested from the GitHub API at all, so it cannot reach the prompt even in principle.

Because inline review comments in GitHub can only anchor to lines *present in the diff*, any finding of the form *"this change made file X stale, and X is not in this diff"* is structurally forced into the review body, and structurally dropped by the fixer.

## Evidence

Observed across `generacy-ai/agency#460` (3 review rounds) and `generacy-ai/generacy-cloud#878` (2 rounds), driven by `/cockpit:auto`. **Every inline finding was fixed. Every body finding was ignored — three rounds running.**

| Round (agency#460) | Inline findings | Fixed? | Body findings | Fixed? |
|---|---|---|---|---|
| 1 | `auto.md:96`, `auto.md:72` | ✅ both | stale two-part contract at `auto.md:28`; CI note | ❌ |
| 2 | `tests:4173`, `auto.md:62` | ✅ both | `auto.md:28`; `lib/gate-wire-types.ts:42`; `contracts/gates-flag-parse.md:60` | ❌ all three |
| 3 | `auto.md:28` (anchored this round), `auto.md:116` | ✅ both* | — | — |

\* `auto.md:28` moved only after being posted as an inline comment. Same file, same line, same reviewer, same wording — the only variable was anchored vs body.

Two files named only in bodies stayed **byte-identical to `develop` across all 8 branch commits** (`packages/claude-plugin-cockpit/lib/gate-wire-types.ts`, `specs/449-part-cockpit-remote-gates/contracts/gates-flag-parse.md`) and had to be fixed by hand (`d543c69`, `5b796cb`).

**Not a directory or blast-radius restriction** — the fixer edited `packages/vendored/cockpit-contracts/**`, `pnpm-lock.yaml`, and `services/api/Dockerfile` in the same runs, all driven by inline comments.

**Reply behaviour hides the failure.** Every inline thread gets a `Addressed in <sha> — please review…` reply and is resolved. Body findings have no thread, produce no reply, leave no unresolved marker. A reviewer scanning the PR sees every thread answered.

**The test suite cannot catch it** — 136-137/137 green while stale contracts sat in the tree, because the drift was in prose the tests didn't pin.

## User Stories

### US1: /cockpit:auto reviewer's staleness findings are actually applied

**As** an operator running `/cockpit:auto`,
**I want** review body findings to reach the fixer prompt,
**So that** staleness reports in files outside the diff are addressed in the same cycle as inline findings — instead of looping indefinitely until I intervene by hand.

**Acceptance Criteria**:
- [ ] A review submitted with `gh pr review --request-changes --body "<finding about file X>"` — where file X is not in the PR diff — produces a commit that touches file X in the next fix cycle.
- [ ] The observed round-3 tell (same finding text moves inline → gets fixed; sits in body → gets ignored) is eliminated: identical finding text produces identical edits regardless of anchoring.

### US2: Cycle-completion logic reflects unanchored findings

**As** the orchestrator's disposition-decision code,
**I want** to know whether a body finding was addressed,
**So that** a cycle that touches zero files named in the newest review body does not falsely report as complete and hand back to the human as "done".

**Acceptance Criteria**:
- [ ] A fix cycle that produces zero commits touching any file named by the newest review body does not advance to Disposition A ("complete").
- [ ] A fix cycle that does touch a file named by the body advances normally.

### US3: The `unanchored-findings` marker convention is honored

**As** the `/cockpit:auto` review poster (upstream contract),
**I want** the fixer to parse the `<!-- generacy-cockpit:unanchored-findings -->` block that I already emit,
**So that** the file names I've already extracted for the reviewer flow through to the fixer without heuristics.

**Acceptance Criteria**:
- [ ] When a review body contains the `<!-- generacy-cockpit:unanchored-findings -->` marker, the block underneath is parsed as structured findings and used directly for the "did we touch a named file?" check in US2.
- [ ] Absence of the marker is not an error — the whole body is included in the prompt as free text.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Fetch review bodies via `GET /repos/{owner}/{repo}/pulls/{n}/reviews` for reviews newer than the last fix cycle. | P1 | Existing thread fetch stays; this is additive. |
| FR-002 | Include every non-empty review body in the fixer prompt as a comment-shaped item with no `path` / `line` and a distinguishing author-side label (e.g. `review body (no file anchor)`). | P1 | `buildFeedbackPrompt` already degrades to `'general comment'` when `path`/`line` are absent — render path needs no change. |
| FR-003 | Do not mark a fix cycle complete while a body finding from the newest review has produced no commit touching any file it names. | P1 | Disposition-decision change. Extends today's thread-resolution-based logic. |
| FR-004 | When a review body contains the `<!-- generacy-cockpit:unanchored-findings -->` marker, parse the block underneath for named files and use that structured list for FR-003's "touched a named file?" check. | P1 | High-precision signal. Contract defined in `agency/packages/claude-plugin-cockpit/commands/auto.md § D.2` and `specs/422-summary-auto-md-s/contracts/request-changes-post.md § Unanchored-block shape`. |
| FR-005 | When the marker is absent, fall back to including the whole body in the prompt as free text; do not attempt heuristic file-name extraction for the FR-003 check (bodies without the marker have no reliable file list — the cycle-completion gate simply does not trigger). | P2 | Fail open, not closed — a body without the marker still gets seen by the fixer via FR-002. |
| FR-006 | Do not treat body findings as lower priority than inline findings in the prompt — they are typically higher-precision, not lower. | P2 | Label them equivalently; ordering in the prompt is not load-bearing. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Body-only findings addressed in same cycle | 100% | Test: post a review with `--body "update file X"` where X is not in the diff, assert the next commit touches X. |
| SC-002 | Round-3 regression (inline vs body divergence) | Eliminated | Test: post the same finding text twice, once inline once as body, assert the same edit lands both times. |
| SC-003 | Cycles falsely marked complete despite unaddressed body findings | 0 | Test: post a body-only finding, run the fixer with a stub that produces no commits, assert cycle does not advance to Disposition A. |
| SC-004 | `<!-- generacy-cockpit:unanchored-findings -->` markers ignored | 0 | Test: post a body with the marker, assert the file list under it is used for the FR-003 gate. |
| SC-005 | Manual-fix commits required per `/cockpit:auto` PR to close body findings | 0 | Observational: monitor the next N `/cockpit:auto` runs post-merge for hand-authored fix commits attributable to dropped body findings. |

## Assumptions

- The GitHub REST endpoint `GET /repos/{owner}/{repo}/pulls/{n}/reviews` is available to the orchestrator's `GhCliGitHubClient` via `gh api` (no new auth surface).
- The fixer's existing prompt renderer (`buildFeedbackPrompt` at `pr-feedback-handler.ts:436`) already degrades gracefully when `path`/`line` are missing — no rendering-side change is required, only the input list.
- "Newer than the last fix cycle" can be determined from existing per-issue state (last-processed review id or timestamp) that the monitor already tracks for the inline-thread path; body-review polling reuses that watermark rather than introducing a second cursor.
- The `<!-- generacy-cockpit:unanchored-findings -->` marker contract is stable across `/cockpit:auto` and `/cockpit:review` — this fix consumes it but does not define it. If the contract shifts, the parser degrades to FR-005 (marker absent → whole-body-as-text) rather than failing.
- Cycle-completion gating in FR-003 keys off *any* commit touching a named file in the current cycle — it does not attempt to verify that the commit actually addresses the finding's semantics (that remains the reviewer's job on the next round).

## Out of Scope

- Rewriting the reply/resolution behaviour to post replies against body findings — GitHub review bodies have no thread to reply to; a `Addressed in <sha>` general comment on the PR is a possible follow-up but not part of this fix.
- Changing how `/cockpit:auto`'s reviewer *emits* body findings (contract stays as-is; this fix is on the consumer side).
- Automatic file-name extraction from arbitrary free-text review bodies without the marker — explicitly deferred (FR-005 fails open).
- Retroactive processing of body findings from reviews older than the last fix cycle's watermark — the watermark advances normally; historical drift is out of scope.
- Changes to the test-suite green-path check that let the bug slip undetected — the test suite is not the failure surface here; the fixer is.

---

*Generated by speckit*
