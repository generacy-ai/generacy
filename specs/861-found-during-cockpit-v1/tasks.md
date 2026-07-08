# Tasks: Thread-shaped review API fix (#861)

**Input**: Design documents from `/specs/861-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = single primary story (thread-shaped review API); this feature is a bug-fix with one user story
- File paths are absolute from repo root

## Phase 1: Type & interface foundation

Additive type/interface changes that unblock everything else. No behavior change yet.

- [X] T001 [US1] Add `ReviewThread` interface to `packages/workflow-engine/src/types/github.ts` per data-model.md §Types. Fields: `rootCommentId: number`, `isResolved: boolean`, `comments: Comment[]`. Include JSDoc referencing #861 and warning against adding `resolved` to `Comment`.
- [X] T002 [US1] In the same file `packages/workflow-engine/src/types/github.ts`, add `@deprecated` JSDoc to `Comment.resolved` pointing consumers at `ReviewThread.isResolved` / `getPRReviewThreads()`. Do NOT delete the field (see D10).
- [X] T003 [US1] In the same file `packages/workflow-engine/src/types/github.ts:264-266`, rename `PreflightOutput.unresolved_comments` → `unresolved_threads` with JSDoc explaining "matches GitHub UI's 'N unresolved conversations'; renamed in #861". Compilation will now break in `preflight.ts` — fixed in T012.
- [X] T004 [US1] In `packages/workflow-engine/src/actions/github/client/interface.ts`, add `getPRReviewThreads(owner, repo, number): Promise<ReviewThread[]>` to the `GitHubClient` interface per `contracts/getPRReviewThreads.md`. Import `ReviewThread` from `../../types/github.js`.
- [X] T005 [US1] In the same interface file `packages/workflow-engine/src/actions/github/client/interface.ts`, add `@deprecated` JSDoc to `getPRComments()` referencing `getPRReviewThreads()` and #861.

## Phase 2: Client implementation

Implement the new GraphQL-backed method and widen the auth error to cover 403.

- [X] T006 [US1] In `packages/workflow-engine/src/actions/github/client/gh-cli.ts:30-39`, widen `GhAuthError.statusCode` from `401` to `401 | 403`. Update the JSDoc.
- [X] T007 [US1] In the same file `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (around the executeGh guard at ~line 90), extend the throw condition from `if (code === 401)` to `if (code === 401 || code === 403)` so 403s route through `GhAuthError` as well.
- [X] T008 [US1] In the same file `packages/workflow-engine/src/actions/github/client/gh-cli.ts`, implement `GhCliClient.getPRReviewThreads(owner, repo, number)`. Invoke `gh api graphql -f query='...' -F owner=... -F repo=... -F number=...` with the query from `contracts/getPRReviewThreads.md`. Parse the response and map to `ReviewThread[]` per D2 / response-mapping table. Do NOT set `Comment.resolved` on emitted comments. Reuse existing `executeGh` + `tokenProvider` plumbing.
- [X] T009 [P] [US1] Create `packages/workflow-engine/tests/actions/github/client/gh-cli.review-threads.test.ts` (new file). Cover D8 rows: mixed resolved/unresolved mapping, empty `reviewThreads.nodes` → `[]`, 401 → `GhAuthError(401)`, 403 → `GhAuthError(403)`, 5xx → generic `Error`, `replyTo: null` → `in_reply_to_id` undefined, `replyTo: { databaseId: N }` → `in_reply_to_id === N`. Mock `executeGh` (or the underlying `child_process`) as in the existing gh-cli test file.

## Phase 3: Consumer migrations

Each migration is a self-contained edit to a single consumer file. Migrations can proceed in parallel once Phase 2 lands — different files, no shared state.

- [X] T010 [P] [US1] In `packages/workflow-engine/src/actions/github/preflight.ts:209-255`, replace the `getPRComments()` call with `getPRReviewThreads()`. Compute `unresolved_threads = threads.filter(t => !t.isResolved).length`. Rename the local var, update the output field name (matches T003). Preserve today's swallow-and-zero catch behavior at `preflight.ts:214`.
- [X] T011 [P] [US1] In `packages/workflow-engine/src/actions/github/read-pr-feedback.ts:59,90`, replace `getPRComments()` with `getPRReviewThreads()`. Filter by `t.isResolved` at the thread level (not `c.resolved` at the comment level). Derive the flat comment list via `threads.flatMap(t => t.comments)`. Set `has_unresolved` / `unresolved_count` from `threads.filter(t => !t.isResolved).length` (thread count — semantics documented in data-model.md).
- [X] T012 [P] [US1] In `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:166`, replace `getPRComments()` with `getPRReviewThreads()`. Compute `unresolvedThreads = threads.filter(t => !t.isResolved)`. Emit `reviewThreadIds = unresolvedThreads.map(t => t.rootCommentId)` on enqueue. Wrap in try/catch per `contracts/monitor-decision.md` §`#762` auth-health integration: `GhAuthError` → `error` log + `authHealth.recordResult(credId, { ok: false, statusCode })`; generic → `warn` with `{ error, owner, repo, prNumber }`. Do NOT fall back to `getPRComments()`.
- [X] T013 [US1] In the same file `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`, add the `private lastUnresolvedThreadCount: Map<string, number>` field (initialize in constructor). Implement the state-transition logging table from `contracts/monitor-decision.md` §State-transition info logging: zero-unresolved skip → `info` on transition, `debug` on steady-state; update the map on every non-error path; do NOT update on error paths (D6).

## Phase 4: Fixture + consumer tests

Fixture drives the monitor regression test; the two workflow-engine consumers use inline literals per Q5→C.

- [X] T014 [P] [US1] Capture the regression fixture at `packages/orchestrator/src/services/__tests__/fixtures/pr-comments-rest.json` from `christrudelpw/sniplink#15` per quickstart.md §Capturing the regression fixture. Include the `_meta` header (`source`, `capturedAt: "2026-07-08"`, `note`); trim comment bodies to `"placeholder body <id>"`; preserve REST structure verbatim; explicitly OMIT any `resolved` field.
- [X] T015 [P] [US1] Update `packages/workflow-engine/tests/actions/github/preflight.test.ts`: mocks return `ReviewThread[]` (inline object literals); assertions read `output.unresolved_threads` (renamed field). Cover: mixed resolved/unresolved → correct count; no PR number → 0; GraphQL throws → 0 (swallow behavior preserved). Delete or update any prior fixture that used `Comment.resolved` on the input side.
- [X] T016 [P] [US1] Update `packages/workflow-engine/tests/actions/github/read-pr-feedback.test.ts`: mocks return `ReviewThread[]` (inline literals). Cover: `include_resolved = false` → only comments from unresolved threads returned; `include_resolved = true` → all comments returned; `unresolved_count` always = unresolved thread count. Delete or update any prior fixture using `Comment.resolved`.
- [X] T017 [US1] Update `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` to drive the D8 monitor matrix. Load the fixture from T014 at the top of the file, adjacent to a comment: `// DO NOT add a resolved field to this fixture — see #861 / quickstart.md`. Cover: fixture-loaded REST payload + GraphQL mock returns `[]` → no enqueue; GraphQL returns N unresolved → enqueue with `reviewThreadIds = [rootCommentId, ...]`; `GhAuthError(401)` → `error` + `authHealth.recordResult({ ok: false, statusCode: 401 })` + no enqueue; `GhAuthError(403)` → same shape as 401; generic 5xx → `warn` with `{ error, owner, repo, prNumber }` + no auth-health + no enqueue; bootstrap 0 → `info` once, then steady-state 0 → `debug`; unresolved→zero → `info`; zero→unresolved → enqueue + `info`; N→M (both > 0) → enqueue + `info`.

## Phase 5: Verification

Grep checks + test runs. Any remaining hit is a merge blocker.

- [X] T018 [US1] Run `grep -RIn unresolved_comments packages/` — expect zero hits (rename complete).
- [X] T019 [US1] Run `grep -RIn 'c\.resolved\|comment\.resolved' packages/*/src` — expect zero hits in `src/`. Any hits in `tests/` should either be gone or explicitly assert the deprecation.
- [X] T020 [US1] Run `grep -RIn getPRComments packages/*/src` — expect only the deprecated declaration in `interface.ts` and the impl in `gh-cli.ts`; zero call sites.
- [X] T021 [US1] Run the two package test suites: `pnpm --filter @generacy-ai/workflow-engine test` and `pnpm --filter @generacy-ai/orchestrator test`. All new/updated tests pass, no regressions in unrelated tests.
- [ ] T022 [US1] Manual repro against `christrudelpw/sniplink#15` per quickstart.md §Live repro: run the GraphQL query, confirm N unresolved threads returned. In a dev-mode monitor run (or via a targeted unit test using the same PR fixture), confirm enqueue count equals the unresolved thread count and `info` fires on the state transition.

## Dependencies & Execution Order

**Sequential foundations**:
- **Phase 1 → Phase 2**: `getPRReviewThreads` implementation (T008) depends on the interface declaration (T004) and the `ReviewThread` type (T001). `GhAuthError` widening (T006, T007) unblocks the 403 throw path exercised in T009 and consumed by T012.
- **Phase 2 → Phase 3**: consumers (T010–T013) call `getPRReviewThreads`, which must exist and return the mapped shape.
- **Phase 3 → Phase 4**: consumer tests (T015–T017) exercise the migrated consumer code. T014 (fixture) is independent — can run in parallel with T010–T013.
- **Phase 4 → Phase 5**: verification (T018–T022) runs after all code + tests land.

**Parallel opportunities within phases**:
- Phase 2: T009 (gh-cli client test) is parallel with T006/T007/T008 once the interface (T004) is declared — the test can be written against the future signature and will pass once the impl lands.
- Phase 3: T010, T011, T012 touch three different files — full parallel. T013 must land in the same PR as T012 (same file) but is a distinct edit; keep them adjacent, not parallel.
- Phase 4: T014, T015, T016 are fully parallel — three different files, no shared state. T017 depends on T014 (fixture path).
- Phase 5: T018/T019/T020 are grep-only and can run in parallel; T021 and T022 must run after all code lands.

**Critical path** (longest sequential chain):
T001 → T004 → T008 → T012 → T013 → T017 → T021 → T022

**Notes**:
- T013 must NOT be split into a separate PR from T012 — the monitor's state-transition map is behavioral spec for the migrated `getPRReviewThreads` call site.
- The fixture (T014) is load-bearing: without the `_meta` header and body trimming, capturing from live data may accidentally include PII from real reviewer comments. Follow the quickstart.md capture script exactly.

---

*Generated by /tasks*
