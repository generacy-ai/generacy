# Tasks: Same-account clarification answers (#976)

**Input**: Design documents from `/specs/976-summary-clarification-answers/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/machine-markers.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: `SC-001` (same-account plain reply auto-resumes & integrates), `SC-002` (machine comments still excluded), `FR-007` (failure surfacing)

## Phase 1: Marker Vocabulary (shared foundation)

- [X] T001 [SC-001][SC-002] Add `MACHINE_MARKERS`, `commentCarriesMachineMarker`, `matchMachineMarker` to
      `packages/orchestrator/src/worker/clarification-markers.ts`.
      - Define `MACHINE_MARKERS` as the exact inventory in `contracts/machine-markers.md` §Inventory,
        using `...CLARIFICATION_QUESTION_MARKERS` spread at the top to enforce the superset invariant.
      - `matchMachineMarker` is a byte-for-byte copy of `matchClarificationQuestionMarker` with the
        constant name swapped (line-anchored, column-0, case-sensitive, `> `-quoted excluded).
      - `commentCarriesMachineMarker` is `matchMachineMarker(body) !== undefined`.
      - Keep `CLARIFICATION_QUESTION_MARKERS` / `commentCarriesQuestionMarker` /
        `matchClarificationQuestionMarker` and `CLARIFICATION_ANSWER_MARKERS` /
        `commentCarriesAnswerMarker` / `matchClarificationAnswerMarker` untouched at the export level
        (research §Decision 6, R-6).
      - Add a one-line `Why:` comment on `MACHINE_MARKERS` noting the `CLARIFICATION_ANSWER_MARKERS`
        lockstep duplication (data-model §Duplication note).

## Phase 2: Structural Marker Tests

- [X] T010 [P][SC-001][SC-002] New file
      `packages/orchestrator/src/worker/__tests__/clarification-machine-markers.test.ts`
      asserting the six coverage points in `contracts/machine-markers.md` §Structural test coverage:
      1. Every entry in `MACHINE_MARKERS` positively matches (parameterized loop).
      2. `> `-quoted marker returns `undefined`.
      3. Leading-whitespace marker returns `undefined`.
      4. Marker-shaped prose without `<!--` wrapper returns `undefined`.
      5. `CLARIFICATION_QUESTION_MARKERS.every(m => MACHINE_MARKERS.includes(m))`.
      6. No entry is a prefix of another entry (I-M6 guard).
      Include an explicit positive assertion that `'<!-- generacy-clarification-answers:'` is IN
      `MACHINE_MARKERS` (locks in the marker-relay deprecation, research §Decision 3).

- [X] T011 [P] MOD `packages/orchestrator/src/worker/__tests__/clarification-markers.test.ts` — no
      new assertions required. Verify the existing "unrelated marker family" negative case at ~L36
      (using `generacy-untrusted-answer:` as a negative for `commentCarriesQuestionMarker`) still
      passes as-is; add a code comment noting the question-marker predicate stays narrow post-#976.

## Phase 3: Monitor Call-Site

- [X] T020 [SC-001] Modify
      `packages/orchestrator/src/services/clarification-answer-monitor-service.ts`:
      - Import at L42: swap `commentCarriesAnswerMarker` → `commentCarriesMachineMarker`.
      - Loop body at L198-209: delete `if (c.viewerDidAuthor === true) continue;`; replace
        `if (commentCarriesAnswerMarker(c.body)) continue;` with
        `if (commentCarriesMachineMarker(c.body)) continue;`.
      - Do NOT touch anything else in this file (contract I-Mon3 — no other side effects).
      Depends on T001.

- [X] T021 [SC-001][SC-002] MOD
      `packages/orchestrator/src/services/__tests__/clarification-answer-monitor-service.test.ts`:
      - Delete/rewrite the existing case at L199-232 ("cluster-self comment only → no enqueue").
      - Add case (a): parameterized over every prefix in `MACHINE_MARKERS` — cluster-self comment
        carrying that prefix at column 0 → `enqueueIfAbsent` NOT called.
      - Add case (b) (SC-001 positive): `viewerDidAuthor: true`, body `"Q1: OAuth\nQ2: JWT"`,
        no marker → `enqueueIfAbsent` called once with `command: 'continue'`,
        `queueReason: 'resume'` (contract I-Mon4).
      - Existing cases (human-authored L87-121, precondition/blocked L123-198, dedupe/no-labels
        L234-308) — UNCHANGED.
      Depends on T020.

## Phase 4: Phase-Loop Scanner Call-Site

- [X] T030 [SC-001][SC-002] Modify `packages/orchestrator/src/worker/clarification-poster.ts`:
      - Imports (L11-23 group): drop `matchClarificationQuestionMarker` and
        `commentCarriesAnswerMarker`; add `matchMachineMarker`. Keep `commentCarriesQuestionMarker`
        (still used by `isQuestionComment`). Grep-verify no other references to the dropped
        symbols remain in this file before removal.
      - Pre-filter at L853-870: swap `matchClarificationQuestionMarker` for `matchMachineMarker`.
        Update the `logger.debug` message from `'Excluded from answer-scanner via question marker'`
        to `'Excluded from answer-scanner via machine marker'`. Keep the `event` name
        (`clarification-answer-scanner-marker-excluded`) and the `markerPrefix` meta field
        (contract I-Post5).
      - Answer-comment assembly at L916-936: replace the entire
        `if (c.viewerDidAuthor === true) { … } else { … }` disjunction with a single
        `const answerComments: TrustComment[] = trustedComments;`. Delete the
        `clarification-answer-scanner-self-unmarked` structured log at L922-930
        (contract I-Post4 — zero grep hits after this PR).
      - FR-004 fail-close block at L951-988 — UNCHANGED (keyed off
        `parsed.sourceViewerDidAuthor`, not on candidacy).
      Depends on T001.

- [X] T031 [SC-001] MOD `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`:
      Add one positive case under the existing "answer integration" describe block mirroring the
      existing different-account case, but with `viewerDidAuthor: true`:
      cluster-self plain `"Q1: OAuth 2.0"` reply → `integrated: 1`, `mockWriteFileSync` invoked
      with a body containing `**Answer**: OAuth 2.0`.
      Depends on T030.

- [X] T032 [SC-001][SC-002] MOD
      `packages/orchestrator/src/worker/__tests__/clarification-self-answer.test.ts`:
      - Case at ~L120-160 ("questions comment + no human reply → zero integrated") — UNCHANGED
        (questions-marker filter still fires via the broader `MACHINE_MARKERS`).
      - Case at ~L163 ("cluster-self answer WITHOUT engine marker → zero integrated"):
        INVERT to `integrated: 1`. Assert `writeFileSync` was called with a body carrying
        `**Answer**: OAuth 2.0` … `**Answer**: info` (matching the case's input `Q<n>:` shape).
        Rename to "cluster-self plain Q<n>: reply → integrated (#976 SC-001)".
      - Case at ~L185 ("cluster-self answer WITH engine marker → integrated"):
        INVERT to `integrated: 0` (marker-relay comment excluded via `MACHINE_MARKERS`).
        Rename to "cluster-self marker-relay comment → excluded (#976 Q2=A deprecates
        marker-relay integration)". Add a docstring line noting this codifies the deprecation.
      Depends on T030.

## Phase 5: Regression Guard

- [X] T040 Verify the following test files require NO changes (grep + spot-read):
      - `clarification-poster-trust.test.ts` — trust-tier gating for untrusted authors +
        `postUntrustedAnswerExplainers`. Both call sites' trust behavior unchanged.
      - `clarification-quote-reply.test.ts` — `> `-prefix column-0 rule unchanged.
      - `clarification-poster-viewer-auth.test.ts` — `viewerDidAuthor` field wiring unchanged
        (still consumed by `parseAnswersFromComments` for FR-004 fail-close).
      - `clarification-poster-graphql-failure.test.ts` — retry semantics unchanged.
      If any of these break during the run (T060), fix the test to reflect the new contract —
      do NOT weaken assertions.

- [X] T041 Grep the whole tree for references to the deleted log event
      `clarification-answer-scanner-self-unmarked`. Expected: zero hits (contract I-Post4).
      If any hit exists outside the deleted lines, resolve it in this PR.

## Phase 6: Ship prerequisites

- [X] T050 Add changeset `.changeset/976-same-account-clarification-answers.md`:
      - `bump`: `patch` for `@generacy-ai/orchestrator` (behavior change; no public API surface
        change; internal only).
      - Summary line: "Same-account plain `Q<n>:` replies on paused clarify issues now
        auto-resume and integrate."
      - REQUIRED by `.github/workflows/changeset-bot.yml` — diff touches non-test files under
        `packages/orchestrator/src/`. Test-only edits are exempt, but this PR modifies
        `clarification-markers.ts`, `clarification-answer-monitor-service.ts`, and
        `clarification-poster.ts` (all non-test), so the gate WILL block without this file.

## Phase 7: Verification

- [X] T060 Run the full orchestrator test suite:
      `pnpm --filter @generacy-ai/orchestrator test`.
      Verify (a) all new/modified tests from T010, T011, T021, T031, T032 pass and (b) the
      regression files listed in T040 continue to pass unchanged.

- [X] T061 Run repo-wide lint / typecheck to catch any straggler references from the dropped
      imports in T020 and T030:
      `pnpm -w typecheck && pnpm -w lint` (or the project's equivalent gate).

- [X] T062 [FR-007] Manual trace-through of the three failure surfacing paths documented in
      `contracts/machine-markers.md` §FR-007 surfacing contract:
      1. Trusted same-account, malformed body, no `Q<n>:` shape → `IntegrationResult
         { integrated: 0, reason: 'no-answers' }`.
      2. Trusted same-account, `Q<n>:` shape, `sourceHadQuestionHeadings === true` →
         whole-poll abort, `logger.warn`, `reason: 'aborted-cluster-self-detector'`.
      3. Trusted same-account, `Q<n>:` shape, per-question parse failure → `parseFailures[]`
         populated; phase-loop's `renderClarificationParseFailuresComment` at
         `phase-loop.ts:1168` posts `<!-- generacy-clarification-parse-failures:<issue> -->`.
      Confirm all three paths remain reachable post-fix; no code changes expected. Document any
      deviation in the PR description.

## Dependencies & Execution Order

**Sequential**: T001 → (T020, T030 in parallel) → (T021, T031, T032 in parallel) → T040 → T041
→ T050 → T060 → T061 → T062.

**Parallel opportunities**:
- T010 and T011 can run in parallel with each other (different test files) once T001 is in.
- T020 (monitor code) and T030 (phase-loop code) can run in parallel — different files, both
  depend only on T001's `MACHINE_MARKERS` export.
- T021, T031, T032 can run in parallel with each other — different test files, each depends
  on its paired code change.

**Critical invariant** (per contract): T020 and T030 MUST both land — divergence
(one call site fixed, the other not) reintroduces the exact agency#433 bug. If splitting the
work across sessions, land them in the same PR.
