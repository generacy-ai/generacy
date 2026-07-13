# Tasks: Author-trust gating for workflow-ingested GitHub comments

**Input**: Design documents from `/specs/842-motivated-live-incident-during/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete
**Issue**: [#842](https://github.com/generacy-ai/generacy/issues/842)
**Workflow**: `speckit-bugfix`

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 / US2 / US3 / US4)

---

## Phase 1: Foundational — Wire `author_association` end-to-end

These tasks are prerequisites for every downstream surface. Nothing else can trust-gate until the field flows from `gh` through `Comment` to the helper.

- [X] T001 [P] [US1] Extend `Comment` type with optional `authorAssociation?: string` field in `packages/workflow-engine/src/types/github.ts` (per data-model.md §Entity Extensions). Field is nullable for fixture / cache / older-response compatibility (FR-002, FR-011).

- [X] T002 [P] [US1] Extend `ReadPRFeedbackOutput` type with optional `skippedComments?: Array<{commentId, author, authorAssociation?, reason}>` field in `packages/workflow-engine/src/types/github.ts` (per data-model.md §Modified Entities). Backwards-compat: field is optional (FR-006).

- [X] T003 [US1] Extend `getIssueComments()` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts:256` to project `author_association` in the outbound response mapping. Purely additive on the outbound side (FR-001, P1).

- [X] T004 [US1] Extend `getPRComments()` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts:437` to project `author_association` in the `jq` selector. Purely additive on the outbound side (FR-001, P1).

- [X] T005 [P] [US1] Add gh-cli unit tests asserting `authorAssociation` field is populated from a mock GitHub REST response for both `getIssueComments` and `getPRComments` in `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.test.ts` (or nearest existing test file). Foundational for SC-004.

---

## Phase 2: Trust helper + config loader + fence helper (with tests)

Central logic — one helper serves all three ingestion surfaces (SC-002).

- [X] T010 [P] [US1] Create `packages/workflow-engine/src/security/comment-trust.ts` implementing:
  - Exports: `TrustSurface`, `TrustReason`, `TrustDecision`, `CommentTrustContext`, `isTrustedCommentAuthor()` (per data-model.md §New Entities and research.md §P2).
  - Constants: `DEFAULT_TRUSTED_TIERS = ['OWNER', 'MEMBER', 'COLLABORATOR']`, `KNOWN_UNTRUSTED_TIERS = ['NONE', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'CONTRIBUTOR']`.
  - Behavior (D5): bot-login short-circuit → default-tier → widen-config (skipped for `answer-scanner` surface) → known-untrusted → unknown-tier (with one `warn` log). Fail-closed on unset `authorAssociation` with reason `'author-association-unset'` (no warn).
  - Pure function; only side effect is `logger.warn` on unknown tiers (FR-011, SC-008).

- [X] T011 [P] [US1] Create `packages/workflow-engine/src/security/comment-trust-config.ts` implementing:
  - `CommentTrustConfigSchema` (Zod, `.strict()` — extra keys rejected).
  - `tryLoadCommentTrustConfig(workspaceDir): CommentTrustConfig | undefined` — reads `<workspaceDir>/.agency/comment-trust.yaml`, returns `undefined` for missing/malformed/schema-invalid (warn-logs on malformed/invalid, no throw).
  - Uses `yaml` + `zod` (already deps). Per data-model.md §CommentTrustConfig and research.md §P4.

- [X] T012 [P] [US4] Create `packages/workflow-engine/src/security/untrusted-data-fence.ts` implementing:
  - `wrapUntrustedData(content: string, sourceLabel: string): string` — returns a `<untrusted-data source="...">` fence with the leading instruction from research.md §D6.
  - Pure function, no side effects (FR-007, SC-006).

- [X] T013 [P] [US1] Create `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts` — table-driven tests covering the matrix in data-model.md §Validation Rules Summary:
  - Trusted: `OWNER`, `MEMBER`, `COLLABORATOR`, bot-login (short-circuit before tier check).
  - Untrusted with normal reason: `NONE`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `CONTRIBUTOR`.
  - Fail-closed: `undefined` `authorAssociation` → `'author-association-unset'`, no warn log.
  - SC-008: `'FUTURE_TIER'` → `trusted: false`, `reason: 'unknown-tier'`, exactly one warn log naming the tier.
  - SC-009: `CONTRIBUTOR` with widen-config → trusted on `clarify-resume` / `pr-feedback`, still untrusted on `answer-scanner`.
  - Widen-login: specific login is trusted on context surfaces even at tier `NONE`; still untrusted on `answer-scanner`.
  - Config cannot narrow: even if widen were somehow negative, `OWNER`/`MEMBER`/`COLLABORATOR` remain trusted.

- [X] T014 [P] [US3] Create `packages/workflow-engine/src/security/__tests__/comment-trust-config.test.ts` covering:
  - Missing file → `undefined`, no throw, no warn.
  - Malformed YAML → `undefined`, one warn log, no throw.
  - Schema violation (e.g., `widen.tiers` is a string not array) → `undefined`, warn naming failed field, no throw.
  - Extra top-level key (`wide:` typo) → schema violation via `.strict()`, `undefined`, warn.
  - Empty `{}` → equivalent to default posture (widen tiers/logins both empty).
  - Valid config → parsed shape matches expectation.

- [X] T015 [P] [US4] Create `packages/workflow-engine/src/security/__tests__/untrusted-data-fence.test.ts` — asserts fence format matches research.md §D6, source label is interpolated safely (no HTML/prompt-injection via source), and inner content is emitted verbatim (not sanitized — this is a data fence, not a filter).

---

## Phase 3: Wire the three ingestion surfaces

Depends on Phase 1 (`authorAssociation` in `Comment`) and Phase 2 (helper + fence). Each surface is independently editable.

- [X] T020 [US1] [US2] Modify `packages/orchestrator/src/worker/clarification-poster.ts:437` (`integrateClarificationAnswers`) to filter every comment through `isTrustedCommentAuthor(comment, 'answer-scanner', ctx)` before `parseAnswersFromComments`. For each skip, emit one structured info log matching the FR-010 shape (`{ event: 'comment-skipped', surface: 'answer-scanner', commentId, author, authorAssociation, reason }`). Body MUST NOT appear in the log (SC-003). Wire `botLogin` in via the existing `identity.ts` resolution and `config` via `tryLoadCommentTrustConfig(workspaceDir)` (note: config is loaded but has no effect on `answer-scanner`, per FR-008 / SC-009). (FR-004, US1 AC, US2 AC.)

- [X] T021 [US1] [US2] In `packages/orchestrator/src/worker/clarification-poster.ts`, when a comment that MATCHED the `Q<N>:` answer pattern is skipped, post one bot explainer comment on the issue (FR-013 / D7):
  - Text: `> Answers from @<author> were not applied (association tier: <TIER>). A trusted member (OWNER/MEMBER/COLLABORATOR) must post or confirm the answers.` Metadata only; comment body MUST NOT be included (SC-007).
  - Idempotence: prefix with hidden marker `<!-- generacy-untrusted-answer:<commentId> -->`. Skip posting if a comment with the same marker already exists on the issue.
  - Generic scanner skips (comments that did not match `Q<N>:`) do NOT post a bot comment — cluster logs only.

- [X] T022 [US1] [US4] Modify `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts:61` (`buildResumePrompt`) to drop the raw `gh issue view <n> --comments` pass-through. Instead:
  - Fetch comments via `github.getIssueComments()` action-side.
  - Partition via `isTrustedCommentAuthor(..., 'clarify-resume', ctx)`.
  - Emit info skip-log per FR-010 for each skipped comment (surface: `'clarify-resume'`).
  - Wrap trusted comment content into the prompt via `wrapUntrustedData(rendered, 'issue #<n> comments')` (FR-005, FR-007, US4).

- [X] T023 [US1] [US2] Modify `packages/workflow-engine/src/actions/github/read-pr-feedback.ts:31` (`ReadPRFeedbackAction.executeInternal`) to partition unresolved comments into `{ comments (trusted only), skippedComments }`. Only trusted comments are forwarded to the agent prompt via the existing return shape. `skippedComments` carries only `{ commentId, author, authorAssociation?, reason }` — no body. (FR-006.)

- [X] T024 [US2] Modify `packages/orchestrator/src/worker/pr-feedback-handler.ts` to consume `ReadPRFeedbackOutput.skippedComments` and emit one info-level structured log per entry (surface: `'pr-feedback'`), matching the FR-010 shape. Body MUST NOT appear.

- [X] T025 [US4] Audit every prompt template that ingests issue/PR-thread content (`specify`, `plan`, `clarify`, `implement`, `tasks`, `address-pr-feedback`) and wrap thread content in `wrapUntrustedData()` per FR-007 / SC-006. Add a prompt-template unit test asserting each ingesting template routes through `wrapUntrustedData` (grep-shaped audit or template-registry loop).

---

## Phase 4: Integration tests + surface-level assertions

Depends on Phase 3.

- [X] T030 [P] [US1] [US2] Create `packages/orchestrator/src/worker/__tests__/clarification-poster-trust.test.ts` covering (FR-004 / SC-001 / SC-003):
  - `NONE`-authored `Q1: answer` comment is dropped from `integrateClarificationAnswers` output.
  - Exactly one skip-log per skipped comment; no `body` field, no body substring, correct `surface`/`commentId`/`author`/`authorAssociation`/`reason`.
  - `OWNER` / `MEMBER` / `COLLABORATOR` / bot-login `Q1: A` answers pass through unmodified (SC-005).
  - Widen-config adding `CONTRIBUTOR` does NOT trust `CONTRIBUTOR` on this surface (SC-009 — answer-scanner pinned).

- [X] T031 [P] [US1] [US2] Extend the same file with FR-013 / SC-007 tests:
  - `NONE`-authored `Q1: A` comment → exactly one bot explainer comment posted on the issue; metadata only (no body substring in the posted body); marker `<!-- generacy-untrusted-answer:<commentId> -->` present.
  - Second scan of same skipped comment → no duplicate posting (idempotence).
  - `NONE`-authored comment that did NOT match `Q<N>:` → no bot comment (generic skips are log-only).

- [X] T032 [P] [US1] [US2] Create `packages/orchestrator/src/worker/__tests__/pr-feedback-trust.test.ts` covering FR-006 / SC-001 / SC-003:
  - `NONE`-authored PR review comment is placed in `skippedComments`, not `comments`.
  - Skip-log line shape verified; no body substring.
  - Trusted-tier comments pass through untouched.

- [X] T033 [P] [US1] [US4] Create a clarify-resume integration test (colocate with existing `clarify.ts` tests) covering FR-005:
  - `gh issue view --comments` no longer appears in the produced resume prompt (grep the prompt string).
  - Trusted comments are rendered inside a `<untrusted-data>` fence.
  - `NONE`-authored comments do not appear anywhere in the prompt.

---

## Phase 5: Polish — audit, smoke, documentation

- [X] T040 [P] [US1] SC-002 grep audit: verify every `getIssueComments` / `getPRComments` / `--comments` call site is adjacent to an `isTrustedCommentAuthor` call OR carries an explicit whitelist code comment naming the reason. Command from quickstart.md §Testing locally:
  ```
  rg -n "getIssueComments|getPRComments|--comments" packages/
  ```
  Add whitelist comments to any legitimate remaining sites (e.g., non-agent-facing CLI helpers) so future audits stay clean.

- [X] T041 [P] [US1] SC-004 smoke test: run the workflow-engine against a real public repo (or fixture-replayed live gh output) and assert `Comment.authorAssociation` is non-null on every returned comment for both `getIssueComments` and `getPRComments`. Log capture attached to the smoke test artifact.

- [X] T042 [P] [US1] SC-005 backfill test: pull ≥20 recent maintainer comments across the `generacy-ai` org (metadata only — no bodies committed to repo), assert the trust helper returns `trusted: true` for every one. Fixture file lives in `packages/workflow-engine/src/security/__tests__/fixtures/` and is metadata-only.

- [X] T043 [P] [US3] Add a fixture-based test covering SC-005 for the widen config path: a `.agency/comment-trust.yaml` with `widen.tiers: [CONTRIBUTOR]` and `widen.logins: [external-triage-bot]` produces the expected decision for context surfaces and does not affect the answer-scanner.

- [X] T044 [P] [US1] Verify quickstart.md instructions work end-to-end by following them manually: enable default posture (no config), verify a `NONE` comment is skipped; add `.agency/comment-trust.yaml` with `widen.tiers: [CONTRIBUTOR]`, verify a `CONTRIBUTOR` comment is trusted on context surfaces only.

---

## Dependencies & Execution Order

### Sequential dependencies (must complete first)

1. **Phase 1 → Phase 2**: The trust helper (`isTrustedCommentAuthor`) reads `Comment.authorAssociation`. T010 (helper) depends on T001 (type extension). Similarly, gh-cli tests (T005) depend on the field flowing through T003 / T004.
2. **Phase 2 → Phase 3**: Every surface wire-up (T020–T025) imports the helper, fence, and config loader from Phase 2.
3. **Phase 3 → Phase 4**: Integration tests exercise the wired surfaces.
4. **Phase 4 → Phase 5**: Audit / smoke / backfill can only run once wiring is stable.

### Parallel opportunities

- **Phase 1**: T001, T002, T005 can run in parallel (different files). T003 and T004 are sequential-safe (same file, `gh-cli.ts`) — do them in one commit.
- **Phase 2**: T010, T011, T012 are three different new files (no shared state), can be authored in parallel. T013, T014, T015 (their test files) can be authored in parallel and depend on their respective src file.
- **Phase 3**: T020+T021 are the same file (`clarification-poster.ts`) — sequential. T022, T023+T024, T025 are all independent files — parallel-eligible. T024 depends on T023's `skippedComments` field shape.
- **Phase 4**: All four test files (T030, T031, T032, T033) are independent — full parallel.
- **Phase 5**: All polish tasks are independent audits — full parallel.

### Task count summary

| Phase | Tasks | Parallel-eligible |
|-------|-------|-------------------|
| Phase 1 — Foundational | 5 | T001, T002, T005 |
| Phase 2 — Helper + config + fence + tests | 6 | T010, T011, T012 (src); T013, T014, T015 (tests) |
| Phase 3 — Wire surfaces | 6 | T022, T023, T025 (T024 after T023, T021 after T020) |
| Phase 4 — Integration tests | 4 | All parallel |
| Phase 5 — Polish | 5 | All parallel |
| **Total** | **26** | ~17 parallel-eligible |

### User story coverage

- **US1** (default-safe posture): T001–T005, T010, T013, T020, T022, T023, T030–T033, T040–T042, T044
- **US2** (skip logging): T020, T024, T030, T031, T032
- **US3** (widen config): T011, T014, T043
- **US4** (data-not-instructions fence): T012, T015, T022, T025, T033

### Suggested execution order

Full serial (safest): T001 → T002 → T003 → T004 → T005 → T010 → T011 → T012 → T013 → T014 → T015 → T020 → T021 → T022 → T023 → T024 → T025 → T030 → T031 → T032 → T033 → T040 → T041 → T042 → T043 → T044.

Fastest (parallel-max):
- Wave 1 (Phase 1): [T001, T002] in parallel → T003 → T004 → T005.
- Wave 2 (Phase 2): [T010, T011, T012] in parallel → [T013, T014, T015] in parallel.
- Wave 3 (Phase 3): T020 → T021 (same file); [T022, T023, T025] in parallel; T024 after T023.
- Wave 4 (Phase 4): [T030, T031, T032, T033] all in parallel.
- Wave 5 (Phase 5): [T040, T041, T042, T043, T044] all in parallel.

---

*Generated by speckit tasks (standard mode)*
