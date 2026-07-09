# Tasks: Cluster-identity trust + zero-trusted loud retention + dedupe-on-exit for PR-feedback loop

**Input**: Design documents from `/specs/869-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (trust-predicate.md, monitor-decision.md, handler-exit-paths.md)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = request-changes reaches worker; US2 = untrusted-only PR notice)

## Phase 1: Foundation — shared trust predicate (blocks US1 + US2)

- [X] T001 [US1] Extend `CommentTrustContext` with `clusterIdentity?: string` field in `packages/workflow-engine/src/security/comment-trust.ts` (see data-model.md E1, contracts/trust-predicate.md). Field is optional, additive; existing consumers unchanged.
- [X] T002 [US1] Add `'cluster-identity'` variant to `TrustReason` union in `packages/workflow-engine/src/security/comment-trust.ts` (data-model.md E2). Additive to the discriminated union.
- [X] T003 [US1] Insert decision 1.5 in `isTrustedCommentAuthor` in `packages/workflow-engine/src/security/comment-trust.ts` — fires between existing bot-login match (decision 1) and `authorAssociation` unset guard (decision 2); returns `{ trusted: true, reason: 'cluster-identity' }` when `ctx.clusterIdentity && comment.author === ctx.clusterIdentity` (contracts/trust-predicate.md §Reference implementation, Invariants I1-I4).
- [X] T004 [P] [US1] Add unit test cases T1-T6 in `packages/workflow-engine/src/security/__tests__/comment-trust.test.ts` covering: cluster-identity match with `NONE`, tie with `OWNER` (cluster-identity wins on decision-order), unrelated author still untrusted, `clusterIdentity: undefined` unchanged behavior, botLogin-precedes-cluster-identity in both non-collision and collision cases (contracts/trust-predicate.md §Test contract).

## Phase 2: GitHubClient extension (blocks US2)

- [X] T005 [US2] Add `listPrCommentBodies(owner, repo, prNumber): Promise<string[]>` method to `GitHubClient` interface in `packages/workflow-engine/src/actions/github/client/interface.ts` (contracts/monitor-decision.md §New `GitHubClient` methods).
- [X] T006 [US2] Add `postPrComment(owner, repo, prNumber, body): Promise<void>` method to the same interface in `packages/workflow-engine/src/actions/github/client/interface.ts`.
- [X] T007 [US2] Implement `listPrCommentBodies` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — wraps `gh pr view <n> --repo <owner>/<repo> --json comments --jq '.comments[].body'`; splits stdout on newlines; throws on non-zero exit (contracts/monitor-decision.md §`GhCliGitHubClient` implementations).
- [X] T008 [US2] Implement `postPrComment` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — wraps `gh pr comment <n> --repo <owner>/<repo> --body <body>`; throws on non-zero exit (same section).
- [X] T009 [P] [US2] Add unit tests for `listPrCommentBodies` and `postPrComment` in `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.test.ts` — success case (mocked stdout), non-zero-exit case, empty-comments case (empty string → empty array).

## Phase 3: Monitor — trust-aware enqueue + zero-trusted notice (US1 + US2)

- [X] T010 [US1] Add private fields to `PrFeedbackMonitorService` in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`: `lastZeroTrustedState: Map<string, boolean>` (data-model.md E4) and reuse existing `clusterGithubUsername` constructor arg as `clusterIdentity` value in the trust-context call (contracts/monitor-decision.md §Constructor extension — no new arg).
- [X] T011 [US2] Add `UNTRUSTED_NOTICE_MARKER` constant `'<!-- generacy:pr-feedback-untrusted-notice -->'` at module scope in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (data-model.md T1).
- [X] T012 [US1] Modify `processPrReviewEvent()` step 3 in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — stop discarding per-comment fields from `getPRReviewThreads` projection; iterate each unresolved thread's comments, call `isTrustedCommentAuthor(comment, 'pr-feedback', { botLogin, clusterIdentity: this.clusterGithubUsername, logger, config })` per comment; accumulate `trustedUnresolvedThreadIds`, `totalUnresolvedThreads`, `untrustedCommentSkips` (contracts/monitor-decision.md §Decision flow, data-model.md T2).
- [X] T013 [US1] Implement Case A (`trustedUnresolvedThreadIds.length > 0`) in modified step 3: call existing `tryMarkProcessed` → `queueAdapter.enqueue` path; set `lastZeroTrustedState[prKey] = false` (contracts/monitor-decision.md §Decision flow Case A, Invariant I2).
- [X] T014 [US1] Implement Case B (zero-trusted: `trustedUnresolvedThreadIds.length === 0 && totalUnresolvedThreads > 0`) in modified step 3: skip `tryMarkProcessed`/`enqueue`; emit `warn` log with `{ owner, repo, prNumber, issueNumber, totalUnresolvedThreads, untrustedCommentSkips }` and message `'PR has unresolved threads but every comment author is untrusted'` (FR-003, contracts/monitor-decision.md §Case B).
- [X] T015 [US2] Implement transition-edge notice call in Case B: when `lastZeroTrustedState[prKey] !== true`, `await maybePostUntrustedNotice(client, owner, repo, prNumber)`; then `lastZeroTrustedState.set(prKey, true)` (contracts/monitor-decision.md §Case B, Invariant I3).
- [X] T016 [US1] Implement Case C (`totalUnresolvedThreads === 0`): preserve existing state-transition logging; reset `lastZeroTrustedState.set(prKey, false)` (contracts/monitor-decision.md §Case C).
- [X] T017 [US2] Implement `maybePostUntrustedNotice()` private method in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — calls `client.listPrCommentBodies` (swallow errors with `warn`), greps bodies for `UNTRUSTED_NOTICE_MARKER` (skip if found), builds the multi-line notice body from contract template, calls `client.postPrComment` (swallow errors with `warn`) (contracts/monitor-decision.md §`maybePostUntrustedNotice`, Invariant I6).
- [X] T018 [P] [US1] Add monitor unit test cases M1, M2, M4, M5, M6, M7 in `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` — cluster-identity comment enqueued (M1); zero-trusted no prior state warns + skips enqueue (M2); transition-map suppresses re-post (M4); reset on trusted-appears (M5); reset on PR-closed (M6); partial-trust threads treat as Case A (M7) (contracts/monitor-decision.md §Test contract).
- [X] T019 [P] [US2] Add monitor unit test cases M3, M8 in the same test file — marker-grep suppresses re-post when marker present in prior comments (M3); `postPrComment` throw is swallowed and next poll continues (M8) (contracts/monitor-decision.md §Test contract).

## Phase 4: Handler — dedupe-clear invariant + degraded identity (US1)

- [X] T020 [US1] Add `phaseTracker: PhaseTracker` and `clusterIdentity: string | undefined` constructor parameters to `PrFeedbackHandler` in `packages/orchestrator/src/worker/pr-feedback-handler.ts` (data-model.md E5, contracts/handler-exit-paths.md §Constructor extension). Keep `sseEmitter?` optional and last.
- [X] T021 [US1] Add module-top `clearDedupe` closure in `PrFeedbackHandler.handle()` in `packages/orchestrator/src/worker/pr-feedback-handler.ts` — `() => this.phaseTracker.clear(owner, repo, issueNumber, 'address-pr-feedback').catch(err => this.logger.warn({ err: String(err) }, 'Failed to clear dedupe key — non-fatal'))` (contracts/handler-exit-paths.md §Handler exit paths, Invariant I6).
- [X] T022 [US1] Add FR-007 startup log at handler entry in `packages/orchestrator/src/worker/pr-feedback-handler.ts` — when `this.clusterIdentity === undefined`, emit `error` log with `{ triedChain: ['config', 'CLUSTER_GITHUB_USERNAME', 'GH_USERNAME', 'gh api user'], prNumber, owner, repo, issueNumber }` and message noting degraded-mode continuation (contracts/handler-exit-paths.md §Handler exit paths, Invariant I4).
- [X] T023 [US1] Update `trustContext` construction in `PrFeedbackHandler.handle()` in `packages/orchestrator/src/worker/pr-feedback-handler.ts` — add `clusterIdentity: this.clusterIdentity` alongside existing `botLogin`, `logger`, `config` fields (contracts/handler-exit-paths.md §Handler exit paths).
- [X] T024 [US1] Split zero-thread and zero-trusted branches in `PrFeedbackHandler.handle()` in `packages/orchestrator/src/worker/pr-feedback-handler.ts` — replace the current `if (unresolvedComments.length === 0)` branch (line ~196) with Case A (`unresolvedThreads.length === 0` → info log "No unresolved threads found — success" + remove label + `clearDedupe()`) and Case B (`trustedUnresolved.length === 0 && unresolvedThreads.length > 0` → `warn` log with `untrustedSkips` and message per FR-002 + retain label + `clearDedupe()`; NO "No unresolved threads found" wording) (contracts/handler-exit-paths.md §Cases retired, Invariants I1-I3).
- [X] T025 [US1] Insert `clearDedupe()` calls on the two success/failure post-CLI branches (paths 3 and 4) in `packages/orchestrator/src/worker/pr-feedback-handler.ts` — after `removeFeedbackLabel` on success, after CLI-failure branch that keeps the label (contracts/handler-exit-paths.md §Handler exit paths).
- [X] T026 [US1] Insert `clearDedupe()` call in the outer `catch` block in `packages/orchestrator/src/worker/pr-feedback-handler.ts` — before the existing `throw error` re-throw; ensure `error`-level log is still emitted (contracts/handler-exit-paths.md §Handler exit paths path 5, Invariant I5).
- [X] T027 [P] [US1] Add handler unit test cases H1-H9 in `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` — success path clears (H1), zero-trusted retention clears + no "No unresolved threads found" line + label kept (H2), CLI success clears (H3), CLI failure clears + label kept (H4), thread-fetch throws clears then re-throws (H5), commit/push throws clears then re-throws (H6), degraded-identity + cluster's own login → untrusted → path 2 + `error` log (H7), identity resolved + same comment → trusted + path 3 (H8), `phaseTracker.clear` throw is swallowed with `warn` (H9) (contracts/handler-exit-paths.md §Test contract).

## Phase 5: Worker wiring (US1)

- [X] T028 [US1] Thread `clusterIdentity` through `ClaudeCliWorkerDeps` in `packages/orchestrator/src/worker/types.ts` — add `clusterIdentity?: string` field (optional in the type to preserve test injection ergonomics; production wiring guarantees a value or `undefined` from the identity chain).
- [X] T029 [US1] Wire `phaseTracker` and `clusterIdentity` into `new PrFeedbackHandler(...)` construction site in `packages/orchestrator/src/worker/claude-cli-worker.ts` (~line 265) — pass `this.phaseTracker!` (non-null assertion; production-required in worker mode per contracts/handler-exit-paths.md §Constructor extension) and `this.clusterIdentity` in the new positional args before `this.sseEmitter`.
- [X] T030 [US1] Resolve `clusterIdentity` at orchestrator startup and inject into `ClaudeCliWorkerDeps` in `packages/orchestrator/src/server.ts` — reuse the existing `resolveClusterIdentity()` invocation site that populates `LabelMonitorService`'s `clusterGithubUsername` (research.md R1.5); pass the same value as `deps.clusterIdentity`.

## Phase 6: Integration regression harness (US1)

- [X] T031 [P] [US1] Extend `packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts` with a fixture replaying the christrudelpw/sniplink#4 / PR #14 scenario — one unresolved thread, one inline comment authored by the resolved cluster identity, `author_association: NONE`. Assert log sequence: `PR feedback work enqueued` present; `PrFeedbackHandler` claim occurs; no `comment-skipped … reason=none-untrusted` line for the cluster-identity author; `waiting-for:address-pr-feedback` label removed only after a follow-up commit (research.md R4.4, spec.md SC-001).
- [X] T032 [P] [US1] Add SC-005 grep audit test in `packages/orchestrator/src/__tests__/trust-predicate-audit.test.ts` (new file) — reads `pr-feedback-monitor-service.ts` and `pr-feedback-handler.ts`; asserts each contains exactly one `isTrustedCommentAuthor` import from `@generacy-ai/workflow-engine`; asserts neither file contains inline raw-string `authorAssociation === 'OWNER'` (or the analogous MEMBER/COLLABORATOR variants) checks outside the shared predicate (data-model.md V4, spec.md SC-005).

## Dependencies & Execution Order

**Phase order (sequential)**:
- Phase 1 (trust predicate) → Phase 2 (client methods) → Phase 3 (monitor) & Phase 4 (handler) & Phase 5 (worker wiring) → Phase 6 (integration + audit).

**Fine-grained ordering**:
- T001 → T002 → T003 → T004 (T001-T003 touch the same file; T004 is test).
- T005 → T006 → T007 → T008 → T009 (interface then impl then tests; T005/T006 same file, T007/T008 same file).
- T010 → T012 → T013, T014, T016 (monitor structural change first, then per-case logic).
- T011 → T015 → T017 → T019 (marker constant first, then notice call site, then implementation, then US2 tests).
- T020 → T021, T022, T023, T024 → T025, T026 (handler ctor first, then closure/entry logic, then exit paths).
- T028 → T029 → T030 (worker types → worker construction → orchestrator startup wiring).
- Phase 6 tasks depend on all of Phase 3-5 being merged (integration test needs the full wired flow).

**Parallel opportunities (marked with [P])**:
- T004 can be authored in parallel with T009 once T003/T008 are in.
- T018 and T019 can be authored in parallel once T017 lands.
- T027 can be authored in parallel with T018/T019 (different files).
- T031 and T032 can be authored in parallel (different new test files).

**Cross-story parallelism**:
- US1 (T003 core predicate) blocks US2 (T012 monitor filter uses the predicate for trust decisions in the notice path).
- Within US2, T005-T009 (client extension) can proceed in parallel with US1's Phase 1 tasks — no shared files.

---

*Generated by speckit — 32 tasks, 6 phases, 2 user stories, standard mode.*
