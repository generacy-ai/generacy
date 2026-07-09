# Tasks: PR-feedback loop terminates on its own trigger (#883)

**Input**: Design documents from `/specs/883-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Implemented (all tasks completed 2026-07-09)

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = terminating fix cycle; US2 = cockpit surfacing)

---

## Phase 1: Type + Label Shape Changes

Foundational shape changes that every downstream task depends on. Must land before handler/monitor/cockpit work.

- [X] T001 [P] [US1] Extend `ReviewThread` interface with required `id: string` (GraphQL node ID) in `packages/workflow-engine/src/types/github.ts` (~line 112). JSDoc must reference #883 and `resolveReviewThread`. See data-model.md §1.
- [X] T002 [P] [US1] Append `blocked:stuck-feedback-loop` entry to `WORKFLOW_LABELS` in `packages/workflow-engine/src/actions/github/label-definitions.ts` with color `D73A4A` and description from data-model.md §4.

## Phase 2: GitHub Client Method (US1)

New client capability that the handler will call. Depends on T001.

- [X] T010 [US1] Add `resolveReviewThread(threadId: string): Promise<void>` to `GitHubClient` interface in `packages/workflow-engine/src/actions/github/client/interface.ts`. JSDoc must document 3× retry, 1s/2s/4s backoff, `GhAuthError` passthrough. See contracts/resolve-review-thread.md.
- [X] T011 [US1] Extend `getPRReviewThreads` GraphQL query in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (~line 479) to select `id` on `reviewThreads.nodes`, and populate `ReviewThread.id` in the mapping (~lines 550-579).
- [X] T012 [US1] Implement `GhCliGitHubClient.resolveReviewThread` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts`. Wire shape: `gh api graphql -f query='mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }' -F id=<threadId>`. Retry loop: attempt → wait 1000ms → attempt → wait 2000ms → attempt → wait 4000ms → throw. `GhAuthError` rethrown immediately (no retry). GraphQL-level `errors[]` on 200 = terminal (no retry). See contracts/resolve-review-thread.md.
- [X] T013 [US1] Unit tests for `resolveReviewThread` in `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.test.ts` (or colocated). Cases: happy path (assert wire args), transient retry (2 fails then success), persistent transient (3 fails, throws with last stderr), `GhAuthError` passthrough (1 call, no retry), GraphQL-level error (1 call, throws). See contracts/resolve-review-thread.md §Test surface.

## Phase 3: Handler Restructure (US1)

Core rewrite of the post-CLI batch. Depends on T001, T010-T012.

- [X] T020 [US1] Add `PerThreadOutcome` and `OutcomeResult` types (handler-internal, not exported) at the top of `packages/orchestrator/src/worker/pr-feedback-handler.ts`. See data-model.md §3.
- [X] T021 [US1] Add `tryPostReply` and `tryResolveReviewThread` helpers in `packages/orchestrator/src/worker/pr-feedback-handler.ts`. Both return `{ ok: true } | { ok: false; error: string }`. `tryResolveReviewThread` delegates to `github.resolveReviewThread` (the retry lives in the client).
- [X] T022 [US1] Add `getHeadShortSha(checkoutPath)` helper (or verify existing) — thin wrapper over `git rev-parse --short HEAD`. Returns `string | null`; caller falls back to `<unknown>` string.
- [X] T023 [US1] Delete the existing `replyToThreads` method (~line 596) in `packages/orchestrator/src/worker/pr-feedback-handler.ts`. The per-comment iteration is replaced by the per-thread inline loop in T024.
- [X] T024 [US1] Rewrite `PrFeedbackHandler.handle` post-CLI section (~line 262 onward) in `packages/orchestrator/src/worker/pr-feedback-handler.ts` per plan.md §Handler restructure. Sequence: commitAndPushChanges → (if !success || !hasChanges) → warn + addLabels(blocked:stuck-feedback-loop) + return → else shortSha resolve → for each trustedUnresolvedThread: tryPostReply(rootCommentId, "Addressed in <sha> — please review, and re-open this thread if it still falls short.") then tryResolveReviewThread(thread.id) → aggregate `outcomes` → resolveSuccesses = outcomes.filter(o => o.resolveResult.ok).length → if 0: FR-006-tail warn + addLabels(blocked:*) + return → else: one warn per failed resolve → removeFeedbackLabel → success log. See contracts/handler-fix-cycle.md.
- [X] T025 [US1] Import `BLOCKED_STUCK_FEEDBACK_LOOP_LABEL` constant (or use string literal `'blocked:stuck-feedback-loop'` sourced from `WORKFLOW_LABELS`) in `packages/orchestrator/src/worker/pr-feedback-handler.ts`.
- [X] T026 [US1] Update or add handler unit tests in `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` covering: (a) all-resolve success — success log fires, `waiting-for:address-pr-feedback` removed, no warns; (b) partial resolve — success log fires + N-R FR-010 warns + label removed; (c) zero resolves after commit — FR-006-tail warn + `blocked:*` added + label kept; (d) no-diff (hasChanges=false) — FR-003/FR-004 warn + `blocked:*` added + no replies; (e) CLI failure — short-circuits to blocked disposition; (f) reply granularity — thread with root + 2 replies → exactly 1 new reply targeting `rootCommentId`. See contracts/handler-fix-cycle.md §Outcome matrix.

## Phase 4: Monitor Pre-Enqueue Skip (US1)

Depends on T002 (label defined). Independent of Phase 3 (handler and monitor are separate processes).

- [X] T030 [US1] Add `getIssueLabels(owner, repo, issueNumber)` to `GitHubClient` interface + `GhCliGitHubClient` implementation in `packages/workflow-engine/src/actions/github/client/interface.ts` and `gh-cli.ts` (if not already present). Returns `Promise<string[]>`.
- [X] T031 [US1] Insert `blocked:*` skip check in `PrFeedbackMonitorService.processPrReviewEvent` in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (~between line 308 trust-live check and line 328 `addLabels(waiting-for:address-pr-feedback)`). Fetch issue labels; if any label starts with `blocked:`, emit structured info log (`msg: 'Skipping PR-feedback enqueue while blocked:* label is present'`, `reason: 'blocked-label-present'`), update `lastUnresolvedThreadCount`, return without enqueue. See contracts/monitor-blocked-skip.md.
- [X] T032 [US1] Update monitor unit tests in `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` per contracts/monitor-blocked-skip.md §Test surface: (a) SC-003 skip with `blocked:stuck-feedback-loop`; (b) prefix generality with `blocked:something-else`; (c) no-blocked passthrough (existing enqueue path unchanged); (d) trust-filter precedence (zero-trusted + blocked → untrusted-notice path still runs); (e) idempotent-state hygiene (`lastUnresolvedThreadCount` updated on skip).

## Phase 5: Cockpit Classifier (US2)

Depends on T002 (label defined in `WORKFLOW_LABELS`). Independent of Phase 3/4.

- [X] T040 [P] [US2] Extend `classifyByPattern` in `packages/cockpit/src/state/label-map.ts` (~line 29): add `|| label.startsWith('blocked:')` to the `'waiting'` return branch. See data-model.md §6.
- [X] T041 [P] [US2] Prepend `'blocked:stuck-feedback-loop'` to `WAITING_PIPELINE_ORDER` array in `packages/cockpit/src/state/precedence.ts` (~line 26). See data-model.md §7.
- [X] T042 [P] [US2] Update cockpit classifier tests to cover: (a) `blocked:stuck-feedback-loop` alone classifies as `waiting`; (b) `blocked:foo` (arbitrary future prefix sibling) also classifies as `waiting`; (c) `blocked:stuck-feedback-loop` + `waiting-for:address-pr-feedback` → `sourceLabel === 'blocked:stuck-feedback-loop'`; (d) `LABEL_TO_STATE` map now includes the new label. Add tests to whichever file already covers `classifyByPattern` / `WAITING_PIPELINE_ORDER` behavior.

## Phase 6: Integration + Polish

- [X] T050 [US1] Manual dry-run: run the updated handler against a test PR fixture (or the vitest integration test) with 3 unresolved trusted threads, verify (a) exactly 3 replies posted (one per root), (b) 3 threads resolved on GitHub, (c) `waiting-for:address-pr-feedback` removed, (d) success log line present. (Covered by vitest integration + unit tests; live dry-run is manual.)
- [X] T051 [US1] Verify no other in-tree callers of `getPRReviewThreads` broke by the `ReviewThread.id` addition. Grep: `grep -rn "getPRReviewThreads\|ReviewThread\b" packages/`. Update any test fixtures that construct `ReviewThread` objects to include `id`.
- [X] T052 [US1, US2] Update or verify quickstart.md matches implemented behavior. Run through §"What you'll see on a normal cycle" and §"What you'll see on a stuck cycle" against the code.

---

## Dependencies & Execution Order

**Sequential dependencies:**

1. **Phase 1** (T001, T002) blocks everything downstream — shapes must exist before use.
2. **Phase 2** (T010-T013) depends on T001 (needs `ReviewThread.id`). Blocks Phase 3.
3. **Phase 3** (T020-T026) depends on Phase 1 + Phase 2. Handler needs both the type and the client method.
4. **Phase 4** (T030-T032) depends on T002 only (needs label). Monitor does not consume `resolveReviewThread` or `ReviewThread.id`, so it does NOT depend on Phase 2 or Phase 3.
5. **Phase 5** (T040-T042) depends on T002 only. Fully independent of Phases 2-4.
6. **Phase 6** (T050-T052) depends on all prior phases.

**Parallel opportunities:**

- **Within Phase 1:** T001 || T002 (different files, no shared state).
- **Across Phases 4 + 5:** Once T002 lands, Phase 4 (monitor) and Phase 5 (cockpit) can run in parallel — independent packages, no shared files.
- **Within Phase 5:** T040 || T041 || T042 (three different files).
- **Not parallel:** Phase 3 tasks (T020-T026) all sit in `pr-feedback-handler.ts` — must serialize.
- **Not parallel:** Phase 2 tasks (T010-T013) all sit in `gh-cli.ts` / `interface.ts` — must serialize (T010 → T011/T012 → T013).

**Critical path:**

T001 → T010 → T011 → T012 → T013 → T020 → T021 → T022 → T023 → T024 → T025 → T026 → T050 → T052

Phase 4 and Phase 5 run in parallel with the tail of Phase 3 once T002 lands.

---

## User Story Coverage

- **US1** (PR-feedback loop terminates): T001, T002, T010-T013, T020-T026, T030-T032, T050-T052.
- **US2** (Cockpit surfaces the blocked state): T002, T040-T042, T052.

## Suggested Next Step

`/speckit:implement` to begin execution.
