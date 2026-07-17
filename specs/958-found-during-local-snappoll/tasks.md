# Tasks: Authorship-gated clarification answer scanner, quote-safe parser, and reply-only resume monitor (#958)

**Input**: Design documents from `/specs/958-found-during-local-snappoll/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/*.md
**Status**: Complete — all tasks implemented (T008 deferred to agency companion PR — noted below).

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- File paths are absolute from repo root

## Phase 1: Shared foundations (no story — prerequisites for every US)

- [X] T001 [P] Add `packages/workflow-engine/src/actions/builtin/speckit/pending-literal.ts` exporting `PENDING_ANSWER_LITERAL = '*Pending*'` and `isPendingAnswerValue(v)`. Recognise empty / whitespace-only / any single `[…]`-bracketed placeholder / literal `*Pending*` as pending; anything else returns `false`. Per data-model.md §"New constants" invariants. Per data-model.md D1: home is workflow-engine (orchestrator already depends on workflow-engine — reverse would form a cycle). Companion unit test at `packages/workflow-engine/src/actions/builtin/speckit/__tests__/pending-literal.test.ts`.

- [X] T002 [P] Extend `packages/orchestrator/src/worker/clarification-markers.ts` with `CLARIFICATION_ANSWER_MARKERS = ['<!-- generacy-clarification-answers:'] as const`, `matchClarificationAnswerMarker(body)`, and `commentCarriesAnswerMarker(body)`. Reuse the existing column-0 rule verbatim (mirror `commentCarriesQuestionMarker`). Companion unit test extended in `packages/orchestrator/src/worker/__tests__/clarification-markers.test.ts` proving: column-0 match, quoted-marker miss, non-overlap with `CLARIFICATION_QUESTION_MARKERS`.

- [X] T003 [P] Re-exported `PENDING_ANSWER_LITERAL` + `isPendingAnswerValue` from `packages/workflow-engine/src/index.ts` (the package public entry). Home moved from orchestrator to workflow-engine per data-model.md D1 fallback to avoid the workflow-engine → orchestrator dependency cycle.

## Phase 2: Cockpit-side deterministic answer stamping (US1 — FR-003 prerequisite)
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 (needs PENDING_ANSWER_LITERAL + CLARIFICATION_ANSWER_MARKERS) -->

- [X] T004 [P] [US1] Added `packages/generacy/src/cli/commands/cockpit/clarification-answer-marker.ts` exporting `formatClarificationAnswerComment(marker)`. Mirrors `manual-advance-marker.ts` for regex-gated validation. Companion unit test at `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-answer-marker.test.ts` covers round-trip with `commentCarriesAnswerMarker`, all invalid inputs, and ascending-key emission.

- [X] T005 [US1] Added `packages/generacy/src/cli/commands/cockpit/clarify-relay.ts` exporting `runClarifyRelay(input, deps)`. Reuses `resolveIssueContext`, `CockpitExit`, `resolveCockpitIdentity`. Posts marker-stamped comment, then applies `completed:clarification`. Idempotent: prior-batch marker detection returns `action: 'already-relayed'` without re-posting.

- [X] T006 [US1] Added `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_relay_clarify_answers.ts` — new MCP tool. Zod input schema `CockpitRelayClarifyAnswersInputSchema` in `mcp/schemas.ts`. Delegates to `runClarifyRelay`. Returns `ToolResult<CockpitRelayClarifyAnswersData>`. Envelope matches `cockpit_advance`.

- [X] T007 [US1] Registered `cockpit_relay_clarify_answers` in `packages/generacy/src/cli/commands/cockpit/mcp/server.ts`.

- [ ] T008 [US1] **Companion — deferred to agency repo.** The cockpit-clarify skill lives in `/workspaces/agency/packages/claude-plugin-cockpit/commands/clarify.md` (a separate repo). Update deferred to a follow-up PR in agency: the skill's step 6 currently writes the answer body via `gh issue comment --body-file`; that step must be replaced with an invocation of `cockpit_relay_clarify_answers({ issue, batch, answers: { [n]: text } })`. Tracked outside this PR since generacy and agency ship independently — the tool is available on the MCP server the moment this PR ships; the skill can adopt it in a subsequent agency release without a co-deploy handshake.

## Phase 3: Core parser + hasPendingClarifications rewrite (US1 + US2)
<!-- Phase boundary: Complete Phase 1 before starting Phase 3 -->

- [X] T009 [US1] [US2] Rewrote `packages/orchestrator/src/worker/clarification-poster.ts`:
  1. Import `PENDING_ANSWER_LITERAL` + `isPendingAnswerValue` from `./pending-literal.js`; replace L303 `answerText !== '*Pending*'` and L502 `answer !== '*Pending*'` with `!isPendingAnswerValue(...)`; use `PENDING_ANSWER_LITERAL` in the L738 write-back regex builder.
  2. Import `matchClarificationAnswerMarker` + `commentCarriesAnswerMarker` from `./clarification-markers.js`.
  3. Add `stripQuotedLines(body)` helper (drop lines whose first non-EOL char is `>`) and integrate as a pre-parse pass in `parseAnswersFromComments`. Per research.md D4: return `{ headBeforeFirstQuote, remainder }` so FR-006 keeps the leading answer when trailing quoted noise would otherwise fail the capture.
  4. Rewrite the `Q<n>:` regex bounding to stop at first `> `-quoted `Q<n>:` OR unquoted `Q<n>:` at column 0 (FR-005).
  5. **Delete** the L488 `.includes('**Question**:') || .includes('**Context**:')` sniff (FR-001 removes it as an authorship signal).
  6. Add author-classification branch: `viewerDidAuthor === true` → require `matchClarificationAnswerMarker(body)`; `false`/`undefined` → parse permissively (FR-002).
  7. Rewrite `TRANSITION_WITH_QUESTION_HEADINGS` handling to fail-closed per FR-004 (research.md D5): human-authored → skip only the offending comment (surviving humans in the same poll integrate); `viewerDidAuthor === true` → abort the entire poll's integration and leave the gate armed. Emit structured warn identifying the offender in both branches. Use the new `IntegrationResult.reason: 'aborted-cluster-self-detector'` for the cluster-self path.
  8. Rewrite `hasPendingClarifications` per FR-007 + research.md D6: `try/catch` around `readFileSync` → catch returns `true`; missing spec dir → `true`; non-empty content + zero parsed questions → `true`; content whose `.trim() === ''` → `false` (legit empty).
  9. Extend `IntegrationResult` type per data-model.md §"IntegrationResult extension" — add `pendingAfter?: number` and `parseFailures?: Array<{ questionNumber, reason }>` for FR-010; add the new `aborted-cluster-self-detector` reason to the union.

- [X] T010 [P] [US2] Updated `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` L55 prompt template — replaced literal `[Leave empty for now]` with `${PENDING_ANSWER_LITERAL}` template interpolation, imported from `../pending-literal.js`. FR-012 prompt/parser convergence complete.

## Phase 4: Phase-loop wiring (US1 gate ordering, US4 observability)
<!-- Phase boundary: Complete Phase 3 before starting Phase 4 (needs the extended IntegrationResult) -->

- [X] T011 [US1] [US4] Edited `packages/orchestrator/src/worker/phase-loop.ts`:
  1. **FR-008**: Move `labelManager.onPhaseComplete(phase)` from L723 to AFTER the gate-check block (below L810). `completed:clarify` is granted only if no gate activated.
  2. **FR-009**: Hoist the `postClarifications()` safety-net call above the `if (!gateActive) continue` guard at L771. It runs on any clarify-phase completion, not only when the gate is active.
  3. **FR-010**: After `integrateClarificationAnswers`, if `IntegrationResult.parseFailures.length > 0`, post a parse-failure comment on the issue enumerating question indices AND emit a relay event on the same channel the existing progress relay uses.

- [X] T012 [P] [US1] Edited `packages/orchestrator/src/worker/label-manager.ts` — dropped `completedLabel` from the `removeLabels` list in `onGateHit`. In-code comment explains the FR-008 dependency so a future reader doesn't re-add the dead retract branch.

## Phase 5: Reply-only resume monitor (US3)
<!-- Phase boundary: Complete Phase 3 before starting Phase 5 (needs clarification-poster changes for identity/auth signalling) -->

- [X] T013 [US3] Added `packages/orchestrator/src/services/clarification-answer-monitor-service.ts`. Mirrors `merge-conflict-monitor-service.ts` verbatim with the documented divergences:
  - Precondition label constant: `WAITING_FOR_CLARIFICATION_LABEL = 'waiting-for:clarification'`.
  - Requires `agent:paused` co-present (per plan §"Existing constraints observed").
  - Event detection: after label match, fetch comments via `getIssueCommentsWithViewerAuth`; require ≥1 comment with `viewerDidAuthor === false`. Author-trust gating via `isTrustedCommentAuthor('answer-scanner', ...)` — same helper the phase-loop scanner uses.
  - Queue command: `command: 'continue', queueReason: 'resume'` via `enqueueIfAbsent`. **MUST NOT** apply `completed:clarification` (per FR-011 + research.md D7).
  - Same `AuthHealthSink` + `JitTokenError` + `GhAuthError` branches as merge-conflict monitor (verbatim).
  - Export the class + `ClarificationAnswerEvent` + `ClarificationAnswerMonitorOptions` interfaces per data-model.md.

- [X] T014 [US3] Added export to `packages/orchestrator/src/services/index.ts`.

- [X] T015 [US3] Wired `ClarificationAnswerMonitorService` in `packages/orchestrator/src/server.ts`: instantiated alongside `MergeConflictMonitorService` with identical DI, `startPolling()` fire-and-forget after listen, `stopPolling()` in cleanup.

## Phase 6: Integration + regression tests
<!-- Phase boundary: Complete Phase 3–5 before starting Phase 6 -->

- [X] T016 [P] [US1] Added `packages/orchestrator/src/worker/__tests__/clarification-self-answer.test.ts` — snappoll#7 replay + FR-003 reject/accept pairs (SC-001).

- [X] T017 [P] [US2] Added `packages/orchestrator/src/worker/__tests__/clarification-quote-reply.test.ts` — table-driven test covering the four required rows from spec §"Observed B" (SC-002).

- [X] T018 [P] [US1] Added `packages/orchestrator/src/worker/__tests__/has-pending-clarifications.test.ts` — covers all FR-007 branches + FR-012 bracketed placeholder (SC-006).

- [X] T019 [P] [US3] Added `packages/orchestrator/src/services/__tests__/clarification-answer-monitor-service.test.ts` — precondition filtering, viewerDidAuthor gate, cluster-self-with-marker exclusion, in-flight dedupe, MUST-NOT completed:clarification assertion.

- [X] T020 [P] [US1] Added `packages/orchestrator/src/worker/__tests__/authorship-not-marker.test.ts` — grep-based structural assertion (SC-003 + SC-007): the L488 sniff is gone; `*Pending*` / `[Leave empty for now]` appear only in `pending-literal.ts`.

## Phase 7: Release plumbing
<!-- Phase boundary: Complete every earlier phase before starting Phase 7 -->

- [X] T021 Added `.changeset/958-authorship-gated-clarification-scanner.md`: minor on orchestrator + generacy (new capabilities), patch on workflow-engine (prompt-template imports shared constant, no public API change). Body summarizes spec §Summary and links #958.

## Dependencies & Execution Order

**Phase graph** (sequential):

```
Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 6 ──▶ Phase 7
        └──▶ Phase 3 ──▶ Phase 5 ─────────────▶ Phase 6 ┘
```

- Phase 1 (T001–T003) is the prerequisite for **all** downstream work — the shared constant + marker family must exist first.
- Phase 2 (cockpit stamping, T004–T008) blocks the FR-003 side of US1; it must land in the same PR as the parser rewrite (spec §Assumptions, research D9).
- Phase 3 (parser + hasPendingClarifications, T009–T010) can run in parallel with Phase 2 once Phase 1 completes.
- Phase 4 (phase-loop wiring, T011–T012) needs Phase 3's extended `IntegrationResult` type.
- Phase 5 (monitor, T013–T015) can run in parallel with Phase 4 once Phase 3 lands.
- Phase 6 (tests, T016–T020) needs Phases 3–5 for the code under test.
- Phase 7 (changeset, T021) is a paperwork step at the end.

**Parallel opportunities**:

- Within Phase 1: T001, T002, T003 are all independent files → run in parallel.
- Within Phase 2: T004 is independent of T005/T006/T007 (formatter has no deps on tool wiring); T005→T006→T007→T008 is a linear chain thereafter.
- Within Phase 3: T009 and T010 are independent files → run in parallel.
- Within Phase 4: T011 and T012 are independent files → run in parallel.
- Within Phase 5: T013→T014→T015 is a linear chain.
- Within Phase 6: T016, T017, T018, T019, T020 are all independent test files → run in parallel.

**Critical path** (fewest-parallelism ordering):
T001 → T004 → T005 → T006 → T007 → T008 → T009 → T011 → T013 → T014 → T015 → T016 → T021.

## Coverage matrix (functional requirements → tasks)

| FR    | Tasks              |
|-------|--------------------|
| FR-001 | T009 (delete L488 sniff, add `viewerDidAuthor` branch) |
| FR-002 | T009 (permissive human parse), T017 |
| FR-003 | T002, T004, T005, T006, T007, T008, T009 (marker requirement on cluster-self) |
| FR-004 | T009 (asymmetric fail-close), T016 |
| FR-005 | T009 (`stripQuotedLines` + regex bounding), T017 |
| FR-006 | T009 (`headBeforeFirstQuote` split), T017 |
| FR-007 | T009 (rewrite `hasPendingClarifications`), T018 |
| FR-008 | T011 (`onPhaseComplete` reorder), T012 (dead-code drop) |
| FR-009 | T011 (safety-net hoist) |
| FR-010 | T009 (extend `IntegrationResult`), T011 (report to issue + relay) |
| FR-011 | T013, T014, T015, T019 |
| FR-012 | T001, T003, T009, T010 |

## Success criteria mapping

- SC-001 (bot self-answer = 0): T016.
- SC-002 (quote-reply integration = 100%): T017.
- SC-003 (marker-allowlist not sole authorship signal): T020.
- SC-004 (reply-only resume latency <2× poll interval): T013 (instrumented via existing monitor metrics); manual verification via quickstart.md.
- SC-005 (0 silent partial advances): T011 (report on parse-failures) + T016 assertion tail.
- SC-006 (`hasPendingClarifications` fail-closed): T018.
- SC-007 (0 divergent placeholder literals): T001, T003, T009, T010 (all import from single constant); enforcement via T020's grep pattern extension.

---

*Generated by /speckit:tasks*
