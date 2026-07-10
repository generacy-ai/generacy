# Tasks: `waiting-for:merge-conflicts` engine-side handler + self-describing pause

**Input**: Design documents from `/specs/898-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (handler-contract.md, monitor-contract.md, pause-comment-schema.md), quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Ship 1 — Self-describing pause (P0 unblocker, lands first in commit history)

- [ ] T001 [US3] Add `MERGE_CONFLICT_REMEDY` module-level constant and `MergeConflictRemedy` interface at `packages/orchestrator/src/worker/merge-conflict-remedy.ts` (new file). Steps tuple + warning string per `data-model.md` §"`MergeConflictRemedy`". Use TypeScript literal string types so the constant is test-provable.

- [ ] T002 [P] [US3] Add unit test `packages/orchestrator/src/worker/__tests__/merge-conflict-remedy.test.ts` asserting the constant literal-string types match the shape in `data-model.md` (3 steps, non-empty warning, warning contains substring `re-pause`).

- [ ] T003 [US3] Extend `errorEvidence.mergeConflict` payload construction at `packages/orchestrator/src/worker/phase-loop.ts:929-941`: after the existing `baseRef` + `conflictedPaths` fields, add a `manualRemedy` sub-field. Substitute `<branch>` (from `context.branch`), `<base>` (from `mergeResult.baseRef.replace(/^origin\//, '')`), and `<owner>/<repo>#<issue>` (from `context.item.owner/repo/issueNumber`) into the `MERGE_CONFLICT_REMEDY.steps` template before passing to `stageCommentManager.updateStageComment`.

- [ ] T004 [US3] Extend `StageCommentManager` renderer to emit the `## ⚠️ Merge conflict on base-merge` markdown section per `contracts/pause-comment-schema.md` when `errorEvidence.mergeConflict.manualRemedy` is present. Format: conflicted paths as bullets, 3-step numbered list, warning as blockquote callout. Keep `manualRemedy` optional at the type level so pre-Ship-1 evidence blobs still render.

- [ ] T005 [US3, US4] Extend `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` (existing test at line 177): assert `errorEvidence.mergeConflict.manualRemedy` present in the `updateStageComment` call; `manualRemedy.steps` length is 3; `steps[1]` contains substrings `generacy cockpit advance` and `--gate merge-conflicts`; `warning` contains `re-pause`; `conflictedPaths` matches `mergeResult.conflictedPaths`. Add a second pass simulating advance-without-resolve → re-pause and assert the second stage comment contains the same/similar path list (SC-005).

- [ ] T006 [P] [US3] Update `waiting-for:merge-conflicts` `description` at `packages/workflow-engine/src/actions/github/label-definitions.ts:43` to the 62-char form: `'Base-merge conflict. See stage comment for the manual remedy.'` (per `contracts/pause-comment-schema.md` §"Label description update"). This is the FR-013 docs half.

## Phase 2: Ship 2 — Foundational types (P1)
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [ ] T007 [P] [US1] Insert `blocked:stuck-merge-conflicts` label definition at `packages/workflow-engine/src/actions/github/label-definitions.ts` after line 111 (next to `blocked:stuck-feedback-loop` at :101 and `blocked:stuck-validate-fix` at :107). Color `D73A4A`, description mirroring the two existing entries.

- [ ] T008 [US1, US2] Extend `QueueItem.command` discriminated union at `packages/orchestrator/src/types/monitor.ts:22` to add `'resolve-merge-conflicts'` as the fourth discriminant: `command: 'process' | 'continue' | 'address-pr-feedback' | 'resolve-merge-conflicts'`. Add and export `ResolveMergeConflictsMetadata` next to `PrFeedbackMetadata` per `data-model.md` §"`ResolveMergeConflictsMetadata`" (fields `conflictedPathsAtPause?`, `prNumber?`, both optional).

- [ ] T009 [P] [US1] Add `MergeConflictIntent` interface at `packages/generacy-plugin-claude-code/src/launch/types.ts` after `PrFeedbackIntent` (line 26): `{ kind: 'merge-conflict'; issueNumber: number; prompt: string }`. Update the `ClaudeCodeIntent` union at line 80 to add `| MergeConflictIntent`.

- [ ] T010 [US1] Create bounded conflict-resolution prompt builder at `packages/orchestrator/src/worker/merge-conflict-prompt.ts` (new file). Pure function `buildMergeConflictPrompt(input: { conflictedPaths: string[]; siblingOwnedPaths: string[]; baseRef: string; branch: string }): string`. Emits structured prompt with: conflicted-path list, sibling-owned tagging paragraph (per `handler-contract.md` §"Sibling-owned path constraint"), explicit prohibition on `git checkout --theirs`/`--ours` for sibling-owned paths, and success predicate (must produce conflict-free committed merge).

## Phase 3: Ship 2 — Handler implementation (P1)
<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

- [ ] T011 [US1, US2] Create `MergeConflictHandler` class at `packages/orchestrator/src/worker/merge-conflict-handler.ts` (new file). Shape mirrors `pr-feedback-handler.ts:55`. Constructor signature per `handler-contract.md` §"Public surface". Implements the 17-step flow from `handler-contract.md` §"Flow":
  - Steps 1-3: parse item, create GitHubClient, resolve PR via `PrLinker` (mirror `pr-feedback-handler.ts:94-106`); on no PR → apply `blocked:stuck-merge-conflicts` + `no-linked-PR` evidence and return.
  - Step 4: `switchBranch(checkoutPath, branchName)` with 3× retry (250ms/500ms/1000ms backoff).
  - Step 5: reuse `resolveBaseBranch()` from `base-merge.ts:67`.
  - Steps 6-7: `git fetch origin` + `git merge origin/<base>` via `execFile`; 3× retry on `ECONNRESET`/`ETIMEDOUT`/`index.lock`/`RPC failed`. Clean-merge exit code 0 → jump to step 15 (no-op success guard).
  - Step 8: enumerate conflicted paths via `git diff --name-only --diff-filter=U`.
  - Steps 9-10: call `GhCliGitHubClient.listOpenPullRequests(owner, repo)` (workflow-engine `gh-cli.ts:680`), filter by `pr.base.ref === baseRef.replace(/^origin\//, '')`; for each: `gh pr view <number> --json files`; cache the sibling file map.
  - Step 11: build `MergeConflictIntent.prompt` via `buildMergeConflictPrompt`, tagging sibling-owned paths.
  - Step 12: `agentLauncher.launch({ intent })` **exactly once** (FR-004 / Q4→D).
  - Step 13: success predicate — `fs.existsSync('.git/MERGE_HEAD')` absent, `git diff --name-only --diff-filter=U` empty, no `<<<<<<< ` sentinel in staged files.
  - Step 14: `git push origin <branch>` with 3× retry on network errors only; non-fast-forward rejection does NOT retry.
  - Step 15 (success): `addLabels(['completed:merge-conflicts'])`, `removeLabels(['waiting-for:merge-conflicts', 'agent:paused'])`, one info log summary, return.
  - Step 17 (blocked): compute `unresolvedPaths` + `partiallyResolvedPaths`, define + populate `BlockedStuckMergeConflictsEvidence` per `data-model.md`, emit evidence into stage comment, `addLabels(['blocked:stuck-merge-conflicts'])`, leave `waiting-for:merge-conflicts` + `agent:paused` in place, one warn log summary.
  Handler must not throw on valid blocked dispositions — return normally after label mutation + evidence emission.

- [ ] T012 [US1] Add `MergeConflictIntent` dispatch branch at `packages/generacy-plugin-claude-code/src/claude-code-launch-plugin.ts` (peer of the `PrFeedbackIntent` branch). Reuse the same launcher plumbing — different prompt content only.

- [ ] T013 [US1, US2] Unit tests at `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.test.ts` covering T1-T8 from `handler-contract.md` §"Test coverage":
  - **T1**: happy path — synthetic single-file `CLAUDE.md` conflict in scratch git repo (`os.tmpdir()`); mock `AgentLauncher.launch` writes resolved file + commits → assert `git push` called, `completed:merge-conflicts` added, `waiting-for:merge-conflicts` + `agent:paused` removed.
  - **T2**: agent produces no resolution → assert `.git/MERGE_HEAD` still present → `blocked:stuck-merge-conflicts` added, `BlockedStuckMergeConflictsEvidence` emitted, `waiting-for:merge-conflicts` preserved.
  - **T3**: sibling-owned enumeration — mock `listOpenPullRequests` returns 2 open siblings, one touching the conflicted path → assert prompt string contains `sibling-owned` and forbids `--theirs`/`--ours` on that path.
  - **T4**: pre-agent fetch retry — mock `git fetch` fails 2× with `ECONNRESET`, then succeeds → assert 3 fetch calls, agent invoked once (attempt not spent).
  - **T5**: post-agent push retry — mock `git push` fails 2× with `ECONNRESET`, then succeeds → assert 3 push calls, success labels applied.
  - **T6**: non-fast-forward rejection — mock `git push` returns `! [rejected] non-fast-forward` → assert NO retry, `blocked:stuck-merge-conflicts` disposition.
  - **T7**: no-op merge (branch already up-to-date with base) → assert immediate success without `AgentLauncher.launch` invocation, `completed:merge-conflicts` applied.
  - **T8**: unlinked issue (no PR found) → assert `blocked:stuck-merge-conflicts` + evidence `"no linked PR"`.

## Phase 4: Ship 2 — Monitor implementation (P1)
<!-- Phase boundary: Can run in parallel with Phase 3 (different files, no dep) -->

- [ ] T014 [P] [US1] Create `MergeConflictMonitorService` class at `packages/orchestrator/src/services/merge-conflict-monitor-service.ts` (new file). Shape mirrors `pr-feedback-monitor-service.ts:50`. Constructor signature per `monitor-contract.md` §"Public surface". Implements the 7-step flow from `monitor-contract.md` §"Flow":
  - Poll cycle: for each `RepositoryConfig`, call `GitHubClient.listIssuesWithLabel(owner, repo, 'waiting-for:merge-conflicts')`, filter via `filterByAssignee` (`identity.ts`, matches `label-monitor-service.ts:493`), build `MergeConflictEvent` per issue.
  - `processMergeConflictEvent`: precondition — MUST have both `waiting-for:merge-conflicts` AND `agent:paused` (drop debug on missing `agent:paused`).
  - Blocked-label skip: if any label starts with `blocked:` → skip, info log with `reason: 'blocked-label-present'`, return `false` (mirrors `pr-feedback-monitor-service.ts:317-346`).
  - Resolve `workflowName` from `workflow:<name>` label; default `'speckit-feature'` (mirrors `label-monitor-service.ts:294-303`).
  - Build `QueueItem` with `command: 'resolve-merge-conflicts'`, empty `metadata`, `queueReason: 'resume'`, `priority: Date.now()`.
  - Call `queueManager.enqueueIfAbsent(item)` (sole dedupe per Q2). On `true` → info log `Merge-conflict resolution enqueued`. On `false` → info log with `reason: 'in-flight'`.
  - Adaptive polling: reuse `ADAPTIVE_DIVISOR = 2` (same as PR-feedback monitor).
  - Error handling: `JitTokenError` → skip cycle; `GhAuthError` → `authHealth.recordResult({ ok: false, statusCode: 401 })`, skip cycle; any other → warn log, continue.
  - No thread-count state maps, no `waiting-for` pre-emptive add, no untrusted-notice.

- [ ] T015 [P] [US1] Unit tests at `packages/orchestrator/src/services/__tests__/merge-conflict-monitor-service.test.ts` covering T1-T6 from `monitor-contract.md` §"Test coverage":
  - **T1**: poll finds one paused issue → `enqueueIfAbsent` returns `true` → info log emitted.
  - **T2**: paused issue with `blocked:stuck-merge-conflicts` present → skip, log `reason: 'blocked-label-present'`, no `enqueueIfAbsent` call.
  - **T3**: assignee ≠ cluster user → skip via `filterByAssignee`.
  - **T4**: two consecutive polls with same paused issue → first `enqueueIfAbsent` → `true`; second → `false` with `reason: 'in-flight'`.
  - **T5**: paused issue missing `agent:paused` label → precondition drop with debug log.
  - **T6**: `GhAuthError` on `listIssuesWithLabel` → `authHealth.recordResult` called, cycle skipped, no throw.

## Phase 5: Ship 2 — Wiring (P1)
<!-- Phase boundary: Complete Phases 3 + 4 before starting Phase 5 (needs handler + monitor + intent to exist) -->

- [ ] T016 [US1] Add `'resolve-merge-conflicts'` dispatch branch at `packages/orchestrator/src/worker/claude-cli-worker.ts:285` (peer of the `'address-pr-feedback'` case). Route to `MergeConflictHandler.handle(item, checkoutPath)`. Ensure existing exhaustive-switch checks accommodate the new discriminant.

- [ ] T017 [US1] Wire `MergeConflictMonitorService` construction and `startPolling()` in `packages/orchestrator/src/server.ts` alongside `PrFeedbackMonitorService`. Reuse `config.monitor.prFeedback` for now (per `monitor-contract.md` §"Wiring"). Register `stopPolling()` in the graceful shutdown block used by other monitors.

## Phase 6: Integration polish (P1)
<!-- Phase boundary: Complete Phase 5 before starting Phase 6 (integration lands only after wiring compiles) -->

- [ ] T018 [P] [US1, US2] Regression fixture in `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.test.ts` for SC-002 (tractable auto-resolve): scratch git repo, synthetic single-file `CLAUDE.md` conflict shape from #6/#7/#8 replay; mock `AgentLauncher.launch` applies a real resolution; assert full pipeline (fetch → merge → agent → push → labels) runs green.

- [ ] T019 [P] [US2] Regression fixture in the same file for SC-003 (irreconcilable conflict): scratch git repo with same-line incompatible edits; mock `AgentLauncher.launch` exits without producing a merge commit; assert `blocked:stuck-merge-conflicts` applied exactly once, `BlockedStuckMergeConflictsEvidence.unresolvedPaths` non-empty, no retry, `waiting-for:merge-conflicts` preserved.

## Dependencies & Execution Order

**Sequential ship ordering** (per `plan.md` §"Sequencing"):
- Phase 1 (Ship 1) lands first in commit history so the interim pause remedy is live even if Ship 2 finds late blockers.
- Phase 2 (types) is prerequisite for Phases 3+4 (need `QueueItem.command`, `ResolveMergeConflictsMetadata`, `MergeConflictIntent`, `MergeConflictRemedy`, and the two new labels to exist).
- Phase 3 (handler) and Phase 4 (monitor) can be built in parallel — different files, no cross-file dependencies.
- Phase 5 (wiring) depends on Phase 3 + Phase 4 both compiling (worker imports handler; server imports monitor).
- Phase 6 (regression fixtures) depends on Phase 5 (handler must be wired to run end-to-end in the fixture).

**Parallel opportunities within phases**:
- **Phase 1**: T002 (test) and T006 (label-definitions) are `[P]` — independent files.
  - T001 → T003 → T004 → T005 are sequential (constant → phase-loop call site → renderer → tests).
- **Phase 2**: T007, T009 are `[P]` (different files); T008 has no sibling in this phase.
  - T010 depends on nothing else in Phase 2 (pure prompt builder, no local deps).
- **Phase 3**: T011 → T012 → T013 sequential (handler → intent branch → tests) — T013 imports T011.
- **Phase 4**: T014 → T015 sequential (monitor → tests).
- **Phase 5**: T016 and T017 both depend on Phases 3+4 but touch different files; can run `[P]` after handler + monitor land.
- **Phase 6**: T018 and T019 are `[P]` — both extend the same file but different describe blocks; safe to author independently.

**FR → Task mapping**:
- FR-011, FR-012 (US3): T001, T003, T004, T005
- FR-013 (US3): T006
- FR-014 (interim path load-bearing): T001-T006 (Ship 1 complete)
- FR-001 (US1 — monitor detects pause + enqueue): T014
- FR-002 (US1 — checkout + fetch + merge with 3× retry): T011 (steps 4-7)
- FR-003 (US1 — bounded agent-CLI prompt): T010, T011 (step 11), T012
- FR-004 (US1 — one-attempt discipline scoped to agent-CLI invocation): T011 (step 12)
- FR-005 (US1 — same-base-in-repo sibling scope guard): T010, T011 (steps 9-10)
- FR-006 (US1 — post-agent push with 3× retry): T011 (step 14)
- FR-007 (US1 — success label triple): T011 (step 15)
- FR-008 (US2 — blocked disposition preserves `waiting-for`): T011 (step 17)
- FR-009 (US2 — evidence block): T011 (step 17), T013 T2, T019
- FR-010 (US1 — blocked-label skip in monitor): T014
- FR-015 (both ships single PR): satisfied by delivering all tasks in this branch's PR.

**SC → Task mapping**:
- SC-001 (0 stalled issues > 30 min): satisfied by T014 + T011 end-to-end; verified operationally post-deploy.
- SC-002 (≥ 80% tractable auto-resolve): T013 T1 + T018 fixture.
- SC-003 (100% unresolvable → blocked, no retry): T013 T2 + T019 fixture.
- SC-004 (100% self-describing pause): T005 assertions on rendered stage comment.
- SC-005 (advance-without-resolve re-pause names paths): T005 second-pass assertion.
