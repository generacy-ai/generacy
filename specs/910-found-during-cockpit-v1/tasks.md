# Tasks: answer-scanner + clarify-resume `viewerDidAuthor` migration

**Input**: Design documents from `/specs/910-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/get-issue-comments-with-viewer-auth.contract.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = answer-scanner, US2 = clarify-resume)

## Phase 1: Pre-flight audit (FR-007, FR-008)

- [X] T001 Grep-audit call sites of `getIssueComments(` across `packages/workflow-engine/src/` and `packages/orchestrator/src/`. Expected callers: (a) `packages/orchestrator/src/worker/clarification-poster.ts` [migrated in T009], (b) `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` [migrated in T012], (c) `packages/workflow-engine/src/actions/epic/update-status.ts` [KEEP on REST — no trust eval], (d) `packages/workflow-engine/src/actions/workflow/update-stage.ts` [KEEP on REST — no trust eval]. Record findings in the PR description. Per FR-008 / Q5 → B: if the audit surfaces any additional caller that passes results through `isTrustedCommentAuthor`, do NOT bundle — file a per-surface follow-up issue cross-linked to #869 → #874 → #878 → #910.
- [X] T002 [US1] Verify #51 dependency: confirm `isQuestionComment` is exported from the codebase (grep for `export.*isQuestionComment`) and identify its call site in `packages/orchestrator/src/worker/clarification-poster.ts` (currently near line 643, before `parseAnswersFromComments`). If missing, this feature blocks — do not proceed to Phase 4. Record the pre-parse line number so T013 can assert the ordering invariant.

## Phase 2: New client method (FR-001)

- [X] T003 [P] [US1, US2] Add `getIssueCommentsWithViewerAuth(owner, repo, number): Promise<Comment[]>` method signature to the `GitHubClient` interface in `packages/workflow-engine/src/actions/github/client/interface.ts`. Include the JSDoc block from `data-model.md` §"New client method" verbatim, naming both migrated callers (`integrateClarificationAnswers`, `buildTrustedIssueCommentsBlock`).
- [X] T004 [US1, US2] Implement `getIssueCommentsWithViewerAuth` in `GhCliGitHubClient` at `packages/workflow-engine/src/actions/github/client/gh-cli.ts`. Mirror the `getPRReviewThreads()` implementation shape (currently at gh-cli.ts:499-604). Use the exact GraphQL query from `contracts/get-issue-comments-with-viewer-auth.contract.md` §"GraphQL query". Execute via `this.executeGh(['api', 'graphql', '-f', 'query=…', '-F', 'owner=…', '-F', 'repo=…', '-F', 'number=…'])`. Response mapping per the contract's mapping table: `databaseId → id`, `body → body`, `author.login → author` (fallback `''`), `authorAssociation → authorAssociation` (copied when non-null), `createdAt → created_at`, `updatedAt → updated_at`, `viewerDidAuthor → viewerDidAuthor` (copied when non-null). No-data-node → return `[]`. HTTP 401/403 → `GhAuthError` (via `executeGh`). Non-zero exit → `throw new Error('Failed to get issue comments for issue #${number}: ${result.stderr}')`. First page only (`first: 100`).
- [X] T005 [P] [US1, US2] Add unit test file `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli-get-issue-comments-with-viewer-auth.test.ts`. Assertions per `contracts/get-issue-comments-with-viewer-auth.contract.md` §"Test contract": (i) `executeGh` invoked with `'api'`, `'graphql'`, and a `-f query=…` argument whose value contains the case-sensitive substring `viewerDidAuthor`; (ii) response mapping copies `databaseId → id`, `viewerDidAuthor: true → viewerDidAuthor: true`, `viewerDidAuthor: null → field absent`; (iii) non-zero exit surfaces `result.stderr` in the thrown `Error.message`; (iv) HTTP 401 stderr shape → `GhAuthError`; (v) no-data-node response → `[]`.

## Phase 3: Trust helper warn-scope extension (FR-004)

- [X] T006 [US1, US2] Extend the `viewerDidAuthor` shape-drift warn at `packages/workflow-engine/src/security/comment-trust.ts` line ~111 to fire on `answer-scanner` and `clarify-resume` in addition to `pr-feedback`. Change per `contracts/get-issue-comments-with-viewer-auth.contract.md` §"comment-trust.ts warn-scope contract": guard becomes `(surface === 'pr-feedback' || surface === 'answer-scanner' || surface === 'clarify-resume') && comment.viewerDidAuthor !== false`. Include `surface` in the warn payload (per SC-006 log-audit assertion). A `MIGRATED_SURFACES: ReadonlySet<TrustSurface>` module constant is acceptable if preferred. Update the adjacent code comment to name `#878` and `#910` and to name the migrated surfaces.
- [X] T007 [P] [US1, US2] Extend `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts`: add fixtures asserting (i) the warn fires on `answer-scanner` and `clarify-resume` when `viewerDidAuthor` is absent or non-boolean (SC-006 injected-drift case); (ii) the warn does NOT fire on the healthy path where `viewerDidAuthor` is populated (SC-006 healthy case); (iii) existing `pr-feedback` behavior is unchanged.

## Phase 4: Migrate answer-scanner (FR-002, FR-010)

- [X] T008 [US1] Introduce a `getIssueCommentsWithRetry(github, owner, repo, issueNumber, logger)` local helper implementing FR-010 (retry once against GraphQL, fail closed on second failure, no REST fallback). Body verbatim from `contracts/get-issue-comments-with-viewer-auth.contract.md` §"Caller contract" — two log messages: `getIssueCommentsWithViewerAuth failed; retrying once` (first failure) and `getIssueCommentsWithViewerAuth failed twice; failing closed (no REST fallback)` (second failure, then re-throw). Place in `packages/orchestrator/src/worker/clarification-poster.ts` as a module-local function (mirror the same helper in T011 or share via a small util if the reviewer prefers — implement decides).
- [X] T009 [US1] Migrate `integrateClarificationAnswers` in `packages/orchestrator/src/worker/clarification-poster.ts` (currently line ~603) from `github.getIssueComments(owner, repo, issueNumber)` to `getIssueCommentsWithRetry(github, owner, repo, issueNumber, logger)` (from T008). Preserve the outer `try/catch` that routes to `{ integrated: 0, reason: 'no-answers' }` on failure — no additional gate-pause logic. Keep `postUntrustedAnswerExplainers` using the SAME already-fetched comment list (do NOT issue a second fetch). Verify `isQuestionComment()` invocation still precedes `parseAnswersFromComments` on this fetch path (FR-007 ordering — asserted by T013).
- [X] T010 [P] [US1] Add `packages/orchestrator/src/worker/__tests__/clarification-poster-viewer-auth.test.ts` covering SC-001..SC-005 + SC-009. Fixtures: (a) App-auth (no env, GraphQL comment with `viewerDidAuthor: true`, `authorAssociation: 'NONE'`) → `integrated >= 1`, trust reason `'self-authored'` (SC-001, SC-002); (b) personal-auth (`GH_USERNAME` set, GraphQL comment with `viewerDidAuthor: false`, author matches botLogin) → still trusted via `reason: 'bot'`, no new warns (SC-004); (c) third-party (`viewerDidAuthor: false`, `authorAssociation: 'NONE'`, stranger login) → still `{ trusted: false }` with an `untrusted` reason (SC-003); (d) question-marker regression (self-authored comment carrying `<!-- generacy-clarifications:<id> -->` marker + a separate self-authored answers comment) → only the answers comment reaches `parseAnswersFromComments`, `integrated == 0` on a marker-only-fixture variant (SC-005, SC-009 — the FR-007 permanent regression fixture).
- [X] T011 [P] [US1] Add `packages/orchestrator/src/worker/__tests__/clarification-poster-graphql-failure.test.ts` covering SC-008. Fixtures: (a) mock `getIssueCommentsWithViewerAuth` throws once then resolves → answers still ingested on the retry, one `warn` log with `retrying once`, no `getIssueComments` (REST) call issued; (b) mock throws twice → `integrated == 0`, warn logged with the GraphQL error (`failing closed`), no REST call issued (assert `github.getIssueComments` was never invoked — proves no silent REST fallback).

## Phase 5: Migrate clarify-resume (FR-003)

- [X] T012 [US2] Migrate `buildTrustedIssueCommentsBlock` in `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` (currently line ~137) from `client.getIssueComments(repoInfo.owner, repoInfo.repo, issueNumber)` to a retry-wrapped `client.getIssueCommentsWithViewerAuth(...)` call. Retry-once + fail-closed shape identical to T008 (implement decides whether to inline a local helper or import a shared util — behavior must match: two log messages, no REST fallback). Preserve the existing swallow-and-return-`(no comments available)` posture on final failure (the retry adds a chance to succeed; final failure still lands on the same fallback string).
- [X] T013 [P] [US2] Add `packages/workflow-engine/src/actions/builtin/speckit/operations/__tests__/clarify-trust-viewer-auth.test.ts`. Fixtures: (a) App-auth (no env, GraphQL comment with `viewerDidAuthor: true`, `authorAssociation: 'NONE'`) → cluster comment included in the trusted block with reason `'self-authored'` (US2 acceptance criterion 2); (b) third-party (`viewerDidAuthor: false`, `authorAssociation: 'NONE'`) → excluded and skip-logged (US2 acceptance criterion 3); (c) transient GraphQL failure absorbed by retry → block still populated; two consecutive failures → block returns `(no comments available)` and NO REST call is issued.

## Phase 6: Ordering + regression enforcement (FR-007)

- [X] T014 [US1] Explicit ordering-invariant test: within the T010 test file (or as a sibling test), assert that on the migrated `integrateClarificationAnswers` path, `isQuestionComment` is invoked (with the marker-carrying trusted comment) BEFORE `parseAnswersFromComments` receives its input list. A minimal form: spy on both `isQuestionComment` and `parseAnswersFromComments` (via mock/vi.spyOn) and assert on call ordering, or assert on filtered input to `parseAnswersFromComments` (marker comment excluded). This test must FAIL if a future refactor moves `isQuestionComment` after `parseAnswersFromComments` OR removes it entirely (SC-009 — the FR-007 permanent regression check that survives #51 reverts).
- [X] T015 Run the four filtered test commands from `quickstart.md` §"Test suite" and confirm they all pass:
  - `pnpm --filter=@generacy-ai/workflow-engine test` (covers T007 + T013 + T005)
  - `pnpm --filter=@generacy-ai/workflow-engine test client` (subset — T005)
  - `pnpm --filter=@generacy-ai/workflow-engine test clarify-trust` (subset — T013)
  - `pnpm --filter=@generacy-ai/orchestrator test clarification-poster` (covers T010 + T011 + T014)
  Also confirm the repo-wide typecheck passes (`pnpm -r typecheck` or equivalent) so the new client method's interface + implementation stay in sync.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 → T002 (audit + dependency check) → all downstream phases.
- T003 (interface signature) → T004 (implementation) → T005 (unit test can be sketched in parallel with T003 but requires T003's signature to type-check).
- T004 (client method exists) → T008 → T009 (migrate answer-scanner) and T012 (migrate clarify-resume).
- T006 (warn scope) is independent of T003/T004 mechanically but should land in the same PR (FR-009 atomic PR).
- T009 → T010 + T011 + T014 (test files exercise the migrated path).
- T012 → T013 (test file exercises the migrated clarify-resume path).
- All → T015 (final verification).

**Parallel opportunities**:
- T003 (interface signature) and T006 (warn scope) touch different files with no code dependency — [P] within Phase 2/3 boundary.
- T005 (client unit test) and T007 (comment-trust test) touch different test files — can be written in parallel once T003 + T006 land.
- T010 (regression fixtures), T011 (GraphQL failure fixtures), and T013 (clarify-resume fixtures) touch different test files — [P] once T009 + T012 land.
- T014 (ordering invariant) can be written in parallel with T010/T011 as a sibling test.

**Blocking merge-order (external)**:
- #51 (question-marker exclusion, `isQuestionComment`) MUST be merged before this PR. T002 verifies presence at implement time; T014 makes future reverts fail CI forever (per FR-007 / Q3 → B).

**Files NOT touched** (verified by T001 audit):
- `packages/workflow-engine/src/actions/epic/update-status.ts` (no trust eval → keeps REST `getIssueComments()`)
- `packages/workflow-engine/src/actions/workflow/update-stage.ts` (no trust eval → keeps REST `getIssueComments()`)

**Ship shape**: single atomic PR per FR-009 — (i) client method, (ii) warn scope, (iii) both surface migrations, (iv) all regression fixtures land together.
