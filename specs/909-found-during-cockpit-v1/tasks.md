# Tasks: Marker-based exclusion in clarification answer-scanner (#909)

**Input**: Design documents from `/specs/909-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Predicate module (new file)

- [X] T001 [US1] Create `packages/orchestrator/src/worker/clarification-markers.ts` exporting `CLARIFICATION_QUESTION_MARKERS: readonly string[]` (four prefixes: `<!-- generacy-stage:clarification`, `<!-- generacy-clarifications:`, `<!-- generacy-clarification:`, `<!-- generacy-cockpit:clarifications-batch:`), plus pure predicates `commentCarriesQuestionMarker(body: string): boolean` and `matchClarificationQuestionMarker(body: string): string | undefined`. Split-on-`\n` + `startsWith` per line (column-0 rule, clarify Q3→B). Case-sensitive ASCII. No side effects, no imports. See `contracts/clarification-markers.md` + `data-model.md` §New types.

- [X] T002 [P] [US1] Add `packages/orchestrator/src/worker/__tests__/clarification-markers.test.ts` covering: all four dialects at column 0 → `true`; `-batch-1` suffix variant → `true` (prefix-substring, SC-001 root cause); unrelated marker (e.g. `<!-- generacy-untrusted-answer:5 -->`) → `false`; `> <!-- generacy-stage:clarification -->` quoted → `false` (US4 / clarify Q3→B); leading whitespace → `false`; marker on non-first line → `true`; empty body → `false`; `matchClarificationQuestionMarker` returns the exact prefix (identity from the const array) per dialect.

## Phase 2: Wire predicate into clarification-poster.ts

<!-- Phase boundary: T001 must land before T003–T005 can import the predicate -->

- [X] T003 [US1] In `packages/orchestrator/src/worker/clarification-poster.ts`, add named import `{ commentCarriesQuestionMarker, matchClarificationQuestionMarker } from './clarification-markers.js'` near the top-of-file imports. Then in `isQuestionComment` (line ~210), replace lines 211–216 (the three inline `body.includes('<!-- generacy-stage:clarification')` / `<!-- generacy-clarifications:` / `<!-- generacy-cockpit:clarifications-batch:` checks) with a single `if (commentCarriesQuestionMarker(body)) return true;` as the first branch. Preserve the content-shape branches unchanged (`## Clarification Questions` heading, `splitByQuestionHeading` + `**Question**:` / `**Context**:` / `**Options**:`) per FR-106. See plan.md §`isQuestionComment` for the exact final shape.

- [X] T004 [US1] In the same file, modify `integrateClarificationAnswers` (line ~568) to pre-filter engine-authored question comments **before** the `#842` trust check (FR-102 / FR-103). Introduce a `scanCandidates: TrustComment[]` array; iterate the raw `comments` input, call `matchClarificationQuestionMarker(c.body)`, and on non-`undefined` result: emit exactly one FR-107 debug log line `logger.debug({ event: 'clarification-answer-scanner-marker-excluded', commentId: c.id, author: c.author, markerPrefix, issueNumber }, 'Excluded from answer-scanner via question marker')` (body NEVER logged) and `continue`; otherwise push to `scanCandidates`. Replace the existing `isTrustedCommentAuthor` loop's input to iterate `scanCandidates` instead of `comments`. The downstream `answerComments = trustedComments.filter((c) => !isQuestionComment(c.body))` at line ~643 collapses to `answerComments = trustedComments` (the pre-filter has already handled marker exclusion; FR-106 content-shape sniff inside `parseAnswersFromComments` still fires). See plan.md §`integrateClarificationAnswers` for the exact ordering diagram.

- [X] T005 [US2] In the same file, `postUntrustedAnswerExplainers` (line ~517), replace the explainer body template at line ~541–542. Old text ends with `must post or confirm the answers.`; new text ends with `must re-post the answers themselves in the \`Q1: <answer>\` format for the batch to integrate.` (FR-104 / SC-005 / SC-006). Preserve the `${marker}` prefix and the `Answers from @${c.author} were not applied (association tier: \`${tier}\`).` sentence unchanged. Zero substring overlap with `confirm` / `Confirm` / `confirms` / `confirmed` / `confirmation` — grep guard in T009 asserts this.

## Phase 3: Integration & regression tests

<!-- Phase boundary: T003–T005 must land before T006–T010 can exercise the wiring -->

- [X] T006 [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add `describe('parseAnswersFromComments — marker exclusion', ...)` with cases: snappoll#4 fixture (body = `<!-- generacy-stage:clarification-batch-1 -->\n\n## ❓ Clarification Questions — Batch 1\n\n### Q1: <topic>\n<prose>\n\n### Q2: <topic>\n...`) → `parseAnswersFromComments` returns `[]` (SC-001); same fixture with `authorAssociation` forced to `OWNER` / `MEMBER` / cluster-self bot login → still `[]` (SC-002 at parser level); trusted `Q1: A\nQ2: B` with no marker → 2 answers (SC-003); quoted-marker fixture `> <!-- generacy-stage:clarification -->\n> ### Q1: Topic\n\nQ1: A\nQ2: B` → 2 answers (SC-004 / US4); logger spy asserts exactly one FR-107 debug line per excluded comment with all five fields present and no `body` field (SC-008).

- [X] T007 [US1] **Load-bearing per FR-110** — in the same test file, add `describe('integrateClarificationAnswers — marker exclusion + trust independence', ...)`. Mock `github.getIssueComments` to return the snappoll#4 fixture; `checkoutPath` has a real `clarifications.md` with 2 pending Q's; assert `isTrustedCommentAuthor` mock is invoked with the marker-filtered `scanCandidates` set, NOT the raw `comments` array; assert result is `{ integrated: 0, ... }` (or the equivalent no-integration outcome); assert `github.addIssueComment` was NOT called with any body containing `not applied` or `association tier` (no explainer for engine-authored questions). Repeat with `isTrustedCommentAuthor` mocked to return `{ trusted: true, reason: 'owner' }` for the bot author → still `integrated: 0`, still no answers written to file, still no explainer (FR-103 trust independence — this is the assertion that guards #910 from silent self-answer).

- [X] T008 [P] [US2] In the same test file, add `describe('untrusted-answer explainer copy', ...)` triggering the explainer path with a genuinely-untrusted human commenter posting `Q1: A`. Assert `github.addIssueComment` was called with a body that (a) contains the exact `re-post the answers themselves in the \`Q1: <answer>\` format` phrase (SC-006), (b) contains zero matches of `/confirm/i` including `Confirm`/`confirms`/`confirmed`/`confirmation` (SC-005 — regex guard, not substring), (c) still names `OWNER/MEMBER/COLLABORATOR` (regression on the unchanged half of the sentence).

- [X] T009 [P] [US1] In the same test file, add `describe('SC-007 — no hardcoded markers outside clarification-markers.ts', ...)` as a source-level lint test. At test time, `readdirSync('packages/orchestrator/src/worker')` filtered to `*.ts` excluding `clarification-markers.ts` and the `__tests__/` subdir; for each of the four `CLARIFICATION_QUESTION_MARKERS` prefixes, assert `readFileSync(file, 'utf8').includes(prefix) === false`. NB: `MARKER_PREFIX = '<!-- generacy-clarifications:'` in `clarification-poster.ts:163` will trip this — the test must special-case that ONE line (posting-marker family, deliberate per plan.md §Files NOT changing) via an allowlist tuple `{ file: 'clarification-poster.ts', prefix: '<!-- generacy-clarifications:', reason: 'posting-marker constant' }`. Any other occurrence fails the test.

- [X] T010 [P] [US1] In the same test file, extend the existing `describe('isQuestionComment', ...)` block (near line ~673) with a delegation assertion: `vi.mock('../clarification-markers.js', async (importOriginal) => ({ ...(await importOriginal()), commentCarriesQuestionMarker: vi.fn(commentCarriesQuestionMarker) }))` — then call `isQuestionComment('<!-- generacy-clarifications:42 -->\n')` and assert the spy was invoked. Guards against future refactors re-inlining the marker check.

## Phase 4: Polish

- [X] T011 [US1] Run `pnpm -F @generacy-ai/orchestrator test` (asserts T001–T010 pass) + `pnpm -F @generacy-ai/orchestrator lint` + `pnpm -F @generacy-ai/orchestrator typecheck` from the repo root. All three must be green before opening for review. No other packages are touched, so no repo-wide test run is required.

## Dependencies & Execution Order

**Sequential edges** (must complete predecessor first):

- T001 → T003, T004 (imports `commentCarriesQuestionMarker`, `matchClarificationQuestionMarker`).
- T001 → T002 (test imports the module under test — technically both are new; can be authored in parallel but T001 must exist for T002 to compile).
- T003, T004 → T006, T007 (integration tests exercise the wired seam).
- T005 → T008 (explainer copy test asserts the new string).
- T003, T004, T005 → T011 (final CI run).

**Parallel opportunities** (marked `[P]`):

- T002 can be authored in parallel with T003 (different files: predicate test vs poster edit); recommend authoring T002 first as it locks the predicate contract.
- T008, T009, T010 are all separate `describe` blocks in `clarification-poster.test.ts` and don't share state; can be authored in parallel once T003–T005 land.

**Critical path**: T001 → T003 → T004 → T007 → T011. T007 is load-bearing per FR-110 — this finding exists because `isQuestionComment` existed but was never called on the scan path; T007 is the assertion that guards against the exact class of recurrence.

**FR-105 merge-order constraint**: land THIS PR before generacy-ai/generacy#910. Enforced by discipline (no in-code assertion possible), but SC-002's trust-independence test (T007) exercises the exact `authorAssociation` configuration #910 will land the cluster into — so a bot-trust regression combined with a marker-exclusion regression would fail T007 by construction.
