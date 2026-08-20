# Tasks: PR review posting (COMMENT-event) + draft/ready lifecycle

**Input**: Design documents from `/specs/1125-context-findings-need-human/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [X] T001 Add the changeset `.changeset/1125-pr-review-posting.md` — `@generacy-ai/workflow-engine` **minor** (new public `GitHubClient` methods `createReview`/`convertPullRequestToDraft`/`listPullRequestFiles`) + `@generacy-ai/orchestrator` **patch** (internal `ReviewPoster`/`PrManager`/phase-loop wiring, no new public exports). Single file, both bumps. This is a CI gate — add it now, not as an afterthought.

## Phase 2: GitHub client capabilities (`@generacy-ai/workflow-engine`)

Foundational for the orchestrator work — `ReviewPoster` and `PrManager` consume these methods.

- [X] T002 [US1] Add GitHub wire types in `packages/workflow-engine/src/types/github.ts`: `ReviewEvent` (`'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'`), `CreateReviewComment` (`path`, `line`, optional `side` default `RIGHT`, `body`), `CreateReviewInput` (`event`, `body`, optional `comments[]`), and `PullRequestFile` (`filename`, `status`, optional `patch`). See data-model.md §2a/§2b. `Review`/`ReviewThread`/`Comment`/`PullRequest.draft` already exist — do not touch.
- [X] T003 [US1] Declare the three new methods on the `GitHubClient` interface in `packages/workflow-engine/src/actions/github/client/interface.ts`: `createReview(owner, repo, prNumber, input): Promise<Review>`, `convertPullRequestToDraft(owner, repo, prNumber): Promise<void>`, `listPullRequestFiles(owner, repo, prNumber): Promise<PullRequestFile[]>`. Depends on T002.
- [X] T004 [US1] Implement `createReview` in `GhCliGitHubClient` (`packages/workflow-engine/src/actions/github/client/gh-cli.ts`): REST `POST /repos/{owner}/{repo}/pulls/{prNumber}/reviews` via `executeGh(['api','--method','POST', path, '--input','-'])`, writing JSON `{ event, body, comments: [{ path, line, side, body }] }` to stdin. Parse and return the created `Review`. Throw with stderr on non-zero exit. NO internal retry for 422 (caller payload bug). See contracts/github-client-methods.md §createReview. Depends on T003.
- [X] T005 [US3] Implement `convertPullRequestToDraft` in `gh-cli.ts`: GraphQL two-step — (1) query `repository(owner,name){ pullRequest(number){ id isDraft } }`, short-circuit `return` if `isDraft === true`; (2) run the `convertPullRequestToDraft(input:{pullRequestId:$id})` mutation. Mirror `resolveReviewThread` (`gh-cli.ts:769`): 3× backoff `[1000,2000,4000]`, rethrow `GhAuthError`, terminal on GraphQL `errors[]`. Returns `void`. See contracts §convertPullRequestToDraft. Depends on T003.
- [X] T006 [US1] Implement `listPullRequestFiles` in `gh-cli.ts`: REST `GET /repos/{owner}/{repo}/pulls/{prNumber}/files?per_page=100 --paginate`, return `{ filename, status, patch? }[]` (tolerate missing `patch` for binary/too-large files). Throw with stderr on non-zero exit. See contracts §listPullRequestFiles. Depends on T003.
- [X] T007 [P] [US1] Add `packages/workflow-engine/src/__tests__/gh-cli.create-review.test.ts` (mock `executeCommand`/`executeGh`): correct REST path; JSON stdin carries `event`/`body`/`comments[]`; returns parsed `Review`; non-zero exit throws. Depends on T004.
- [X] T008 [P] [US3] Add `packages/workflow-engine/src/__tests__/gh-cli.convert-to-draft.test.ts`: `isDraft:true` short-circuits (no mutation call); `isDraft:false` runs the mutation; GraphQL `errors[]` throws terminally; `GhAuthError` rethrown; transient failure retried. Depends on T005.
- [X] T009 [P] [US1] Add `packages/workflow-engine/src/__tests__/gh-cli.list-pr-files.test.ts`: paginated path; parses `patch`; missing `patch` tolerated. Depends on T006.

## Phase 3: Orchestrator core — artifact type, ReviewPoster, PrManager

<!-- Phase boundary: complete Phase 2 (client methods exist) before Phase 3 -->

- [X] T010 [US1] Create `packages/orchestrator/src/worker/review-findings-artifact.ts`: the local consuming contract for #1124 — `FindingSeverity`, `ReviewVerdict`, `FindingAnchor`, `ReviewFinding`, `FindingsArtifact` types plus the matching Zod schemas (`FindingAnchorSchema`, `ReviewFindingSchema`, `FindingsArtifactSchema`). Include the header comment noting this is a temporary local copy to be swapped for a `@generacy-ai/workflow-engine` import once #1124 lands. See data-model.md §1.
- [X] T011 [US1] Create `packages/orchestrator/src/worker/review-poster.ts` — pure helpers first: `computeDiffableLines(files): Map<string, Set<number>>` (parse `@@ -a,b +c,d @@` hunk headers → RIGHT-side commentable line set per file); `partitionFindings(findings, diffable): { inline, body }` (inline iff `anchor` present AND `diffable.get(file)?.has(line)`); `buildReviewBody(bodyFindings, round)` (body marker `<!-- generacy-engine-review round=<N> -->` + `Round <N>` header + advisory/blocking-distinct rendering, body-fallback findings reference intended `file:line`); `buildInlineComment(finding): CreateReviewComment` (per-finding marker `<!-- generacy-finding:<marker> -->` + text + severity tag); `isRoundAlreadyPosted(reviews, round): boolean`. Depends on T002, T010.
- [X] T012 [US1] In `review-poster.ts` implement `ReviewPoster` class + `ReviewPosterDeps` (`github`, `owner`, `repo`, `prNumber`, `logger`). `postRound(artifact, round)`: dedupe via `listReviews` + `isRoundAlreadyPosted` (FR-010); `listPullRequestFiles` → `computeDiffableLines` (FR-002a); partition; build ONE `CreateReviewInput` with `event: 'COMMENT'` hardcoded (SC-001); `createReview` exactly once (US1 AC5). See contracts/review-poster.md. Depends on T011.
- [X] T013 [US4] In `review-poster.ts` implement `ReviewPoster.resolveResolvedThreads(artifact)` (round ≥ 2 only): `getPRReviewThreads`; for each finding with `resolved === true`, match the thread whose comment body contains `<!-- generacy-finding:<marker> -->`; if matched and not already `isResolved`, call `resolveReviewThread(thread.id)`. Independent + best-effort per thread (one failure warns, does not block others). Depends on T012.
- [X] T014 [US3] Modify `packages/orchestrator/src/worker/pr-manager.ts`: add in-memory `markedReadyByEngine = false` flag; set it `true` on the primary success path inside the existing `markReadyForReview`; add `convertToDraftIfEngineMarkedReady(linkedPRs?)` — no-op when flag false, else best-effort `github.convertPullRequestToDraft` for primary + each parsed sibling, set flag `false` on primary success, all failures warn (never throw). See data-model.md §4 + research.md Decision 6.

## Phase 4: Phase-loop wiring

<!-- Phase boundary: complete Phase 3 (ReviewPoster + PrManager ready) before Phase 4 -->

- [X] T015 [US2] Add the injectable seam `readFindingsArtifact?: (context: WorkerContext, round: number) => Promise<FindingsArtifact | null>` to `PhaseLoopDeps` in `packages/orchestrator/src/worker/types.ts` (default `undefined` → production-inert). Depends on T010.
- [X] T016 [US2] Wire the review side effects in `packages/orchestrator/src/worker/phase-loop.ts`: add a local `reviewRound` counter to `executeLoop` (starts `1`, increments on each remediate→review `i--` backtrack). After `runStubPhase('review')` succeeds AND `deps.readFindingsArtifact` is defined: read the artifact; if present → `reviewPoster.postRound(artifact, reviewRound)`; if `reviewRound >= 2` → `reviewPoster.resolveResolvedThreads(artifact)`; if `artifact.verdict === 'clean'` → `prManager.markReadyForReview(context.linkedPRs)` (FR-005, before validate by linear order). All best-effort. See contracts/review-poster.md §Phase-loop wiring. Depends on T012, T013, T015.
- [X] T017 [US3] In `phase-loop.ts`, inside the existing `remediateTrigger` block (`:1154`), before `runStubPhase('remediate')`, call `await prManager.convertToDraftIfEngineMarkedReady(context.linkedPRs)` (FR-006). Preserve the inertness invariant — this stays gated by the flag so it is a no-op until the engine has marked ready. Depends on T014, T016.
- [X] T018 [US1] Modify `packages/orchestrator/src/worker/claude-cli-worker.ts`: construct `ReviewPoster` (from PR owner/repo/number + github + logger) and thread it into `PhaseLoopDeps`; leave `readFindingsArtifact` defaulting to `undefined` so production stays inert. Depends on T012, T016.

## Phase 5: Verification (tests)

<!-- Phase boundary: complete Phase 4 (wiring done) before Phase 5 -->

- [X] T019 [P] [US1] Add `packages/orchestrator/src/worker/__tests__/review-poster.test.ts` (mock `GitHubClient`, fake artifact): SC-001 submitted review `event === 'COMMENT'` (never `REQUEST_CHANGES`); exactly one `createReview` per `postRound` (US1 AC5); diffable anchor → inline, undiffable/absent → body reference, no finding dropped (FR-002/002a); body carries `<!-- generacy-engine-review round=<N> -->` (SC-004) + round N (SC-006); advisory visually distinct (FR-004); FR-010 second `postRound` for an already-posted round makes no `createReview`; FR-009 only `resolved` findings' threads resolved by marker (SC-005), one resolve failure does not block others. Depends on T012, T013.
- [X] T020 [P] [US3] Add `packages/orchestrator/src/worker/__tests__/pr-manager.draft.test.ts`: `convertToDraftIfEngineMarkedReady` no-ops when flag false; converts + clears flag when true; failure is best-effort (warn, no throw); siblings covered. Depends on T014.
- [X] T021 [P] [US2] Add `packages/orchestrator/src/worker/__tests__/phase-loop.review-side-effects.integration.test.ts` driving the review-side-effect block through the loop against a mock client: SC-002 clean verdict → PR marked ready before validate; SC-003 remediate-entry-after-ready → PR converted to draft; inertness — when `readFindingsArtifact` is `undefined` the loop behaviour is byte-identical (no poster/PR calls). Depends on T016, T017, T018.

## Dependencies & Execution Order

**Phase order (sequential)**: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5.

**Within Phase 2**: T002 → T003 → {T004, T005, T006} (all in the same `gh-cli.ts` file, so serialize the edits) → unit tests {T007, T008, T009} run in parallel.

**Within Phase 3**: T010 first (types). T011 → T012 → T013 are sequential (same file `review-poster.ts`). T014 (`pr-manager.ts`) is independent of the ReviewPoster chain and can run in parallel with T011–T013.

**Within Phase 4**: T015 (types) → T016 → T017 → T018 (T016–T018 all touch `phase-loop.ts`/wiring, serialize).

**Within Phase 5**: T019, T020, T021 are all different test files → fully parallel `[P]`.

**Parallel opportunities**:
- T007 / T008 / T009 (Phase 2 unit tests, distinct files).
- T014 in parallel with T011–T013 (distinct files, no shared state).
- T019 / T020 / T021 (Phase 5 test files).

**Production-inertness invariant** (must hold after every phase): with `readFindingsArtifact` undefined, feature/bugfix/epic runs are byte-identical to pre-change. T021 pins this.
