# Tasks: Widen the deterministic clarification-answer parser to accept the cockpit dialect

**Input**: Design documents from `/specs/949-summary-cockpit-plugin-posts/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/regex-contract.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = single-story bugfix)

## Phase 1: Fixtures

Test fixtures come first so the implementation tasks have a target to satisfy. A cockpit-body fixture captured verbatim from a real issue is a MUST per plan (Q4→A) — modeling it by hand is not acceptable.

- [ ] T001 [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add fixture constants near the top of the file per `data-model.md` §"Fixture inventory": `FIXTURE_COCKPIT_MULTI` (captured verbatim from issue #949's cockpit-format answer comment; MUST contain ≥ 2 `### Q<n>` blocks), `FIXTURE_COCKPIT_SINGLE`, `FIXTURE_ENGINE_HEADING`, `FIXTURE_ENGINE_ANSWER_COLON_OUTSIDE`, `FIXTURE_BARE_HUMAN`, `FIXTURE_MID_PROSE`, `FIXTURE_BARE_LINE_START_NO_HEADING`, `FIXTURE_LEAKED_QUESTION`, `FIXTURE_COCKPIT_UNTRUSTED_AUTHOR`, `FIXTURE_COCKPIT_FR004_NEGATIVE` (MAY reuse `FIXTURE_COCKPIT_MULTI`). Fetch the real cockpit comment body from GitHub (`gh issue view 949 --json comments` or the raw comment URL) — do NOT hand-model it.

## Phase 2: Shared constants

- [ ] T002 [US1] In `packages/orchestrator/src/worker/clarification-poster.ts`, add three colocated top-of-file raw-string constants per `data-model.md` §"Constants": `QN_OPENER_PATTERN` (numeric captures), `QN_OPENER_PATTERN_NONCAPTURING` (all `(\d+)` → `(?:\d+)` and `(.*)` → `(?:.*)`), and `QN_TERMINATOR_LOOKAHEAD` (leading `\n` required, no `^` alternation). Include JSDoc explaining the three composition sites, the deliberate exclusion of `:453`, and the coupling invariant between opener and terminator. Also add the `pickQnMatch(m)` helper (returns `{ qn, trailing }` from the disjunction's alternate captures).

## Phase 3: Parser wiring

Sequential — all edits target the same file (`clarification-poster.ts`), and later tasks read from constants added in T002.

- [ ] T003 [US1] In `packages/orchestrator/src/worker/clarification-poster.ts` at `:97-99`, rewrite `commentMatchesAnswerPattern` to use `new RegExp(QN_OPENER_PATTERN_NONCAPTURING).test(body)`. Delete the inline regex literal.

- [ ] T004 [US1] In `packages/orchestrator/src/worker/clarification-poster.ts` at `:406-420`, add a third arm `m0` to `extractEmbeddedAnswer` **before** the existing `m1`/`m2` arms: `text.match(/\*\*Answer:\*\*\s*(.+?)$/m)`. On match, capture the answer, then run `text.match(/\n\*\*Rationale:\*\*\s*(.+?)$/m)` and if it matches, return `` `${answer}\nRationale: ${rationale}` `` (Q1→B rationale join). Otherwise return `answer`. Leave `m1` and `m2` arms unchanged.

- [ ] T005 [US1] In `packages/orchestrator/src/worker/clarification-poster.ts` at `:457-458`, replace the inline outer regex in `parseAnswersFromComments` with `new RegExp(`${QN_OPENER_PATTERN}(.*?)${QN_TERMINATOR_LOOKAHEAD}`, 'gs')`. Update the body-capture consumer to read from `match[5]` (index shifts because the opener disjunction adds four capture groups). Use `pickQnMatch(match)` to resolve the Q number and trailing text from the two disjunction arms. Verify the outer regex still uses `gs` flags per data-model invariant.

- [ ] T006 [US1] In `packages/orchestrator/src/worker/clarification-poster.ts` at `:453`, add a multi-line code comment above `sourceHadQuestionHeadings` recording (a) that the colon in `/(?:^|\n)###\s+Q\d+:/` is DELIBERATE and load-bearing, (b) that it discriminates engine-authored `### Q1: Topic` question headings from cockpit `### Q1` answer delimiters, (c) that folding this into `QN_OPENER_PATTERN` would cause `TRANSITION_WITH_QUESTION_HEADINGS` to fire on every legitimate cockpit integration (100%-rate false positive), and (d) that this exclusion is per clarification Q5→C. Do NOT modify the regex itself.

- [ ] T007 [US1] In `packages/orchestrator/src/worker/clarification-poster.ts` at `:730-732`, verify the write-back regex ``/### Q${n}:[\s\S]*?\*\*Answer\*\*:\s*\*Pending\*/`` is unaffected (it targets `clarifications.md`'s engine dialect written by `formatComment` at `:341`, not comment bodies). Do NOT modify it. Note verification in commit message.

## Phase 4: Positive integration tests

Load-bearing per plan (Q4→A + terminator-lockstep). Run against the fixtures added in T001.

- [ ] T008 [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "cockpit dialect: multi-question integrates each block independently" using `FIXTURE_COCKPIT_MULTI` against pending questions `[1, 2]`. Assert `answers.get(1)?.answer === 'A — Use the sealed file backend\nRationale: It avoids a cloud round-trip.'` and `answers.get(2)?.answer === 'B\nRationale: Because.'` (adjust to real fixture text). MUST fail if terminator lookahead is not widened in lockstep with opener (per plan §"Fail-loud on the load-bearing test").

- [ ] T009 [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "cockpit dialect: single question with rationale integrates and joins rationale" using `FIXTURE_COCKPIT_SINGLE`. Assert Q1 answer contains `\nRationale: ` join per Q1→B.

- [ ] T010 [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "cockpit dialect: single question without rationale integrates without join" — inline body `### Q1\n**Answer:** X`, assert `answers.get(1)?.answer === 'X'` (no `Rationale:` suffix).

## Phase 5: Regression tests (existing dialects)

All parallel — independent test cases, no shared state.

- [ ] T011 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "engine dialect: heading + `**Answer: X**` still parses" using `FIXTURE_ENGINE_HEADING`. Assert m1 arm result unchanged.

- [ ] T012 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "engine dialect: heading + `**Answer**: X` still parses" using `FIXTURE_ENGINE_ANSWER_COLON_OUTSIDE`. Assert m2 arm result unchanged.

- [ ] T013 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "bare human dialect: `Q1: answer text` still parses" using `FIXTURE_BARE_HUMAN`. Assert `answers.get(1)?.answer === 'answer text'`.

- [ ] T014 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "bold-wrapped colon-bearing form: `**Q1**: A` still parses" per contract row 10.

## Phase 6: Negative regression tests

All parallel — independent test cases.

- [ ] T015 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "FR-005: mid-prose `as per Q1: yes` does NOT capture" using `FIXTURE_MID_PROSE`. Assert `answers.get(1)` is `undefined`.

- [ ] T016 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "Q2→A: bare line-start `Q1\n**Answer:** X` without heading does NOT open a block" using `FIXTURE_BARE_LINE_START_NO_HEADING`. Assert `answers.get(1)` is `undefined`.

- [ ] T017 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "FR-002: cockpit-shaped opener with leaked `**Question**:` in body is SKIPPED_SUSPICIOUS_ANSWER" using `FIXTURE_LEAKED_QUESTION`. Assert no answer captured and (if the module logs a code) that the skip reason is emitted.

## Phase 7: Guard-feature tests (FR-013, FR-004)

- [ ] T018 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "FR-013: cockpit-format answer from untrusted author produces explainer" using `FIXTURE_COCKPIT_UNTRUSTED_AUTHOR`. Verify `commentMatchesAnswerPattern` returns `true` for the body and the untrusted-answer explainer path fires (mock the poster's comment-post call and assert it is invoked with an explainer body).

- [ ] T019 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add test "FR-004 negative pin (Q5→C): well-formed cockpit answer integrates WITHOUT `TRANSITION_WITH_QUESTION_HEADINGS`" using `FIXTURE_COCKPIT_FR004_NEGATIVE`. Assert `logger.warn` is NOT called with an argument containing `code: 'TRANSITION_WITH_QUESTION_HEADINGS'` during integration. This is the load-bearing surface for the `:453` exclusion.

## Phase 8: `extractEmbeddedAnswer` unit-level tests (contract rows 1-6)

Direct-input tests against the extractor per `contracts/regex-contract.md` §"`extractEmbeddedAnswer`". All parallel.

- [ ] T020 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add unit tests for `extractEmbeddedAnswer` covering all 6 rows from contract §"`extractEmbeddedAnswer` — nested extraction behavior": m0 with rationale, m0 without rationale, m1 unchanged, m2 unchanged, no-match returns `undefined`, and the ill-formed multi-`**Answer:**` case (first-match wins per `/m` mode).

## Phase 9: `commentMatchesAnswerPattern` unit tests (contract rows 1-6)

- [ ] T021 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add unit tests for `commentMatchesAnswerPattern` covering all 6 rows from contract §"`commentMatchesAnswerPattern` — boolean predicate behavior".

## Phase 10: Invariant tests

- [ ] T022 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add invariant test: mid-block bare `Q1\n**Answer:** X` inside a captured cockpit block's body is NOT re-opened as a new block by the terminator lookahead (per `data-model.md` §Validation "Terminator lockstep invariant" and `contracts/regex-contract.md` §"Invariants" item 2). Construct a fixture with `### Q1\n**Answer:** X\nsome text\nQ1\n**Answer:** Y\n### Q2\n**Answer:** Z`; assert two blocks captured (Q1 and Q2), with `Q1\n**Answer:** Y` remaining inside Q1's body.

- [ ] T023 [P] [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add invariant grep-style test (or documented review checklist): the raw string `(?:^|\\n)(?:(?:#{1,6}` appears in the module exactly at `QN_OPENER_PATTERN` and `QN_OPENER_PATTERN_NONCAPTURING` definitions, and nowhere else inline (Q3→A shared-constant invariant). Simplest form: read `clarification-poster.ts` in the test and assert `occurrences === 2` for a distinctive substring.

## Phase 11: End-to-end integration test

- [ ] T024 [US1] In `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`, add end-to-end test per `contracts/regex-contract.md` §"`integrateClarificationAnswers`": stub `clarifications.md` with two pending questions, feed a trusted-author cockpit-format multi-block comment, assert (a) return value is `{ integrated: 2 }`, (b) persisted file contents match the specified output with `Rationale:` lines joined, and (c) `logger.warn` is NOT called with `code: 'TRANSITION_WITH_QUESTION_HEADINGS'`.

## Phase 12: Changeset

- [ ] T025 [US1] Create `.changeset/949-cockpit-answer-parser.md` per plan §"Changeset" and repo `CLAUDE.md` §"Changesets (required — CI gate)". Content: bump `@generacy-ai/orchestrator` at `patch` level (defect fix, `workflow:speckit-bugfix`; no new public exports — the regex constants stay internal). Body: one-sentence description ("Widen `parseAnswersFromComments` to accept the cockpit `### Q<n>` + `**Answer:** value` dialect, so the deterministic backstop parser stops silently returning `no-answers` on every cockpit-posted clarification comment"). MUST be a newly-added file per the CI gate at `.github/workflows/changeset-bot.yml`.

## Phase 13: Verification

- [ ] T026 [US1] From `/workspaces/generacy`, run `pnpm --filter @generacy-ai/orchestrator test -- clarification-poster` and confirm all new + existing tests pass. Then run `pnpm --filter @generacy-ai/orchestrator typecheck` (or the repo's canonical typecheck script) to confirm no type regressions from capture-group index shifts.

- [ ] T027 [US1] Run `pnpm changeset status` from the repo root to confirm the new changeset is picked up. Run `git status --short` to confirm the change surface is exactly: `packages/orchestrator/src/worker/clarification-poster.ts` (modified), `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` (modified), `.changeset/949-cockpit-answer-parser.md` (added), `specs/949-summary-cockpit-plugin-posts/tasks.md` (added by /tasks). Nothing else — cross-package changes indicate scope creep.

## Dependencies & Execution Order

**Sequential phases** (each phase depends on the previous):
- Phase 1 (fixtures) → Phase 2 (shared constants) → Phase 3 (parser wiring) → Phase 4-11 (tests) → Phase 12 (changeset) → Phase 13 (verification).
- Within Phase 3 (T002-T007) all edits target the same file (`clarification-poster.ts`) and share the shared-constant symbol, so they MUST run sequentially in the listed order.

**Parallel opportunities within phases**:
- Phase 5 (T011-T014): four independent regression tests, all `[P]`.
- Phase 6 (T015-T017): three independent negative regression tests, all `[P]`.
- Phase 7 (T018-T019): two independent guard-feature tests, both `[P]`.
- Phase 8 (T020), Phase 9 (T021), Phase 10 (T022-T023): all unit/invariant tests marked `[P]` — each writes an independent `describe` block to the same test file. In practice, a single agent can bundle all Phase 5-10 test additions into one edit pass; the `[P]` marker signals *safe to split*, not *must split*.

**Load-bearing tests** (MUST exist and MUST fail if the corresponding bug regresses):
- T008 — multi-question terminator-lockstep pin. A single-question fixture goes green with the primary defect live.
- T019 — FR-004 negative pin. If someone folds `:453` into `QN_OPENER_PATTERN`, this test fires immediately.
- T023 — shared-constant invariant. Catches duplicate inline regex copies in review.

**Out of scope** (do NOT include in this task list):
- Cockpit posted format changes (byte-locked by `agency` contract).
- Write-back `**`-consumption bug at `:730-732` (separate issue).
- `cockpit_advance` validation (separate issue).
- `no-open-clarifications` typed-error missing in `agency` playbook (separate repo issue).
- Any change to `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` (LLM path is primary; deterministic parser is the backstop).

---

*Generated by speckit — 2026-07-16. Standard mode (bugfix, single-file scope).*
