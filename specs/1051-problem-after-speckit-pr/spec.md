# Feature Specification: Prevent worker from resurrecting deleted branches and cross-contaminating issues after PR merge

**Branch**: `1051-problem-after-speckit-pr` | **Date**: 2026-07-27 | **Status**: Draft | **Issue**: [#1051](https://github.com/generacy-ai/generacy/issues/1051)

## Summary

After a speckit PR merges and its head branch is deleted, the orchestrator worker re-enters on a stale reused checkout, resurrects the deleted remote branch, commits work belonging to a **different** issue onto it, and opens a duplicate PR that claims to close the already-closed issue. Nothing lands incorrectly on `develop`, but the operator sees a stranded branch, orphan commits (in the observed case, nine), and a misleading duplicate PR that looks legitimate at a glance.

Two independent in-tree contributors compose to produce this outcome:

1. `packages/orchestrator/src/worker/repo-checkout.ts` runs `git fetch origin` **without `--prune`** at **two** sites — `switchBranch:109` and `updateRepo:224` — both followed by `reset --hard origin/<branch>`. A branch deleted upstream remains locally resolvable via either site. (`fetchBase:143` is a single-ref fetch and is unaffected.)
2. `packages/orchestrator/src/worker/pr-feedback-handler.ts:127-138` checks out `pr.head.ref` unconditionally and pushes at `:670` with no check that the PR is still open or the remote branch still exists — the push silently recreates the branch.
3. The checkout is reused across issues within a repo and was not clean when re-entered (`repo-checkout.ts:14,:35`) — the working tree still held #880's files when #879's phase job ran.

Related invisibility: `git checkout <branch>` at `repo-checkout.ts:112` / `:228` succeeds silently against a stale local branch, so the "Local branch not found" fallback at `:114` / `:230` never fires and the worker never learns the branch is gone upstream. Pruning first would cause the fallback to fire and the tracking-branch create from `origin/<branch>` to fail loudly on a merged-and-deleted branch.

This spec bundles four independent fixes that eliminate each contributor plus a dispatch-time gate that stops the doomed job before it runs.

## Observed instance (evidence)

`generacy-ai/generacy-cloud#883`:

| Time (UTC) | Event |
|---|---|
| 12:52:23 | PR #882 (`Closes #879`) squash-merged with `--delete-branch`; branch `879-problem-any-4xx-from` deleted; issue #879 closed |
| 12:53:26 | commit `d8e392ca` authored — `chore(speckit): complete validate phase for #879`, **parent `c3cbe0e4`** (the pre-merge branch tip) |
| 12:53:32 | PR **#883** opened on the **resurrected** `879-problem-any-4xx-from`, body `Closes #879` |

`git compare develop...d8e392ca` → `diverged, ahead_by=9, behind_by=1`. Nine commits that can never land.

The commit `d8e392ca` is titled "complete validate phase for #879" but every file in it belongs to **#880** (four `packages/web/**` files + six `specs/880-problem-usenotifications/**` files). It is a single-parent commit, not a merge — the working tree was contaminated, not "develop got merged in". #880's own work had already merged via PR #881 nine hours earlier, so nothing was permanently lost — but the same mechanism could just as easily have stranded unmerged work.

## Relationship to #1049

#1049 landed a merged-PR gate in `PrFeedbackMonitorService` so review feedback is not enqueued on a merged PR. That is necessary but **not sufficient** for this issue:

- #1049's gate covers only the PR-feedback entry path. The observed commit was `chore(speckit): complete validate phase` — a **phase** re-entry, not a feedback cycle.
- The two defects compose: as long as the checkout can resolve a deleted branch and push to it, any re-entry on a merged issue resurrects it.

This spec must ship even after #1049. Conversely, #1049 is not a fix for this.

## User Stories

### US1 — Deleted upstream branches stop being locally resolvable

**As an** operator reviewing a repository,
**I want** a worker that re-enters after a merge to find the deleted branch gone from local refs,
**So that** it cannot `git reset --hard` to the pre-merge tip and resurrect the branch on push.

**Acceptance Criteria**:
- [ ] **Both** `git fetch origin` invocations in `repo-checkout.ts` — `switchBranch:109` and `updateRepo:224` — use `--prune` (or equivalent stale-ref cleanup). Patching only one leaves the other path live. (`fetchBase:143` is single-ref and out of scope.)
- [ ] After a PR merges with `--delete-branch`, a subsequent worker re-entry in the same checkout does NOT recreate the remote branch (SC-001).

### US2 — Pushes to a merged/closed PR's branch are refused loudly

**As an** operator triaging an unexpected PR,
**I want** any attempt to push to a branch whose PR is merged or closed to fail with a `warn`-or-above log line naming the PR state,
**So that** a resurrected branch is distinguishable from normal operation in the logs and cannot silently produce a duplicate PR.

**Acceptance Criteria**:
- [ ] Before `commitAndPushChanges` (called from `pr-feedback-handler.ts:670` and the phase-commit path), the worker verifies (a) whether a PR exists in **any** state for the current branch, and (b) whether the remote branch still exists at origin. Per Q2 clarification: the PR lookup MUST query `--state all` — the existing `findPRForBranch` defaults to open-only via `gh pr list` and would fail open on a merged-but-branch-still-present case. Do NOT change `findPRForBranch`'s default (five other call sites depend on open-only); introduce a `state` parameter or a dedicated helper.
- [ ] Decision matrix on the PR-lookup result:
  - `null` (no PR in any state) → **allow** (first-push case, no false positive)
  - `OPEN` → **allow**
  - `MERGED` → **refuse** with `reason: 'pr-merged'`
  - `CLOSED` → **refuse** with `reason: 'pr-closed'`
  - remote branch missing (independent of PR state) → **refuse** with `reason: 'branch-missing'`
- [ ] Per Q5 clarification: the PR/branch existence check runs **twice** — once immediately after `switchBranch` at phase start (covers the `hasChanges: false` no-op-phase hole), and once immediately before `commitAndPushChanges`. Two API calls per phase; phases are minutes long so cost is acceptable.
- [ ] If any check fails, the push is refused, the job exits without opening a duplicate PR, and exactly one `warn`-or-above log line is emitted (SC-002) with the shape defined in FR-003a.

### US3 — Checkout reuse never carries another issue's working-tree state

**As an** operator running two speckit issues through the same worker,
**I want** the working tree to be scoped strictly to the current issue at the moment phase work begins,
**So that** files from issue B cannot be committed onto issue A's branch.

**Acceptance Criteria**:
- [ ] The checkout path either resets hard to the target ref before phase work OR isolates checkouts per issue (whichever `plan.md` selects — this is a design decision, not a spec-level constraint).
- [ ] A commit made on issue A's branch never contains files whose contents were introduced by work on any other issue (SC-003 — enforced by regression test that runs two issues through one reused checkout).

### US4 — Phase jobs for closed issues are dropped at dispatch

**As an** operator,
**I want** a `complete validate phase for #N` job to be dropped at dispatch when issue #N is already closed,
**So that** the doomed job never reaches the git layer at all — defense in depth, not the primary fix.

**Acceptance Criteria**:
- [ ] At the point where the worker picks up a phase job, issue state is queried (or the already-loaded state is consulted).
- [ ] Per Q1 clarification: the drop applies to **both** `type === 'process'` and `type === 'resume'` events emitted by `LabelMonitorService.processLabelEvent()`. The observed repro was a resume event, so a process-only gate would miss the field failure mode entirely.
- [ ] If the issue is closed, the job is dropped with an `info` log line whose structured payload includes `dropped: 'issue-closed'`, the issue number, the event type (`process` | `resume`), and the phase name.
- [ ] The drop is silent from a mutation standpoint: no branch checkout, no push, no PR creation, no `agent:error` label, no comment (SC-004). A drop here is expected steady-state behaviour, not an error.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `git fetch origin` in `repo-checkout.ts` MUST use `--prune` (or equivalent) at **both** call sites: `switchBranch:109` and `updateRepo:224`. | P1 | US1. Two-line change; sits on the critical path so must not regress checkout perf. `fetchBase:143` is single-ref and unaffected. |
| FR-002 | Before any push in `pr-feedback-handler.ts` and the phase-commit path, the worker MUST verify (a) whether a PR exists in **any** state (open/merged/closed) for the current branch, and (b) whether the remote branch still exists at origin. The lookup MUST NOT filter by state (Q2 clarification — `findPRForBranch` defaults to open-only and would fail open on merged-but-branch-present). Do NOT change `findPRForBranch`'s default; add a `state` parameter or dedicated helper. Additionally, run the same PR/branch check once at phase start immediately after `switchBranch` (Q5 clarification — covers the `hasChanges: false` no-op-phase hole where no push fires). | P1 | US2. Two invocation sites per phase: post-`switchBranch` and pre-`commitAndPushChanges`. |
| FR-003 | If FR-002 checks fail, the push MUST be refused; the job MUST exit without opening a new PR; the disposition is per FR-003a (log event) and FR-003b (label state). | P1 | US2. Silent skip is the current defect; loud refusal is the corrective posture. |
| FR-003a | The refusal log line MUST be structured with `event: 'push-refused'` and fields `{ reason: 'pr-merged' \| 'pr-closed' \| 'branch-missing', prNumber, branch, owner, repo, issueNumber }` at `warn` level. `prNumber` MAY be null when reason is `branch-missing` with no known PR. Exactly one such line per refusal (SC-002). | P1 | Q4 clarification. Neutral name so future push-refusal paths can share the event. |
| FR-003b | After refusal, `agent:in-progress` MUST be cleared. Label state MUST split on issue state at refusal time: issue **closed** → clear `agent:in-progress` only, no `agent:error`, no comment; issue **open** → clear `agent:in-progress` **and** add `agent:error` (open issue + merged/missing branch is a genuine anomaly and requires a visible signal). MUST NOT add `failed:<phase>` — that would invite `/cockpit:resume` to re-attempt the refused push, making the fix a loop. | P1 | Q3 clarification. |
| FR-004 | On checkout reuse, the working tree MUST be guaranteed to contain only files scoped to the target issue at the moment the phase step begins. | P1 | US3. Implementation choice (hard-reset vs. per-issue checkout) is a `plan.md` decision. |
| FR-005 | A phase job whose target issue is closed MUST be dropped at dispatch. This applies to **both** `type === 'process'` and `type === 'resume'` events in `LabelMonitorService.processLabelEvent()` (Q1 clarification — observed repro was a resume event). The drop emits one `info` log line with structured field `dropped: 'issue-closed'` plus `{ issueNumber, eventType, phase }`. Drop is silent from a mutation standpoint: no checkout, no push, no PR, no `agent:error`. | P1 | US4. Defense-in-depth. |
| FR-006 | Applies uniformly to `workflow:speckit-feature` and `workflow:speckit-bugfix`; must not require workflow-specific branching in the fix sites. | P2 | Both workflows use the same commit/push code paths — a per-workflow gate would be a bug. |
| FR-007 | No new persisted state (Redis key, file, or PR/issue marker) is introduced. All checks are stateless queries against GitHub or the local git repo. | P2 | Mirrors #1043's Q1=A rationale — avoids the stale-key/TTL class of bugs that #849 fixed. |
| FR-008 | The prune, PR-state check, and dispatch gate MUST NOT slow the happy path measurably. Budget: **two** GitHub calls per phase (one after `switchBranch`, one before push) — categorically different from per-commit or per-poll-cycle burn. FR-005 dispatch gate SHOULD consult already-loaded issue state where available before issuing a new `getIssue` call. | P3 | Non-functional; call this out in `plan.md`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | After a PR merges with branch deletion, worker re-entry on the same checkout does NOT recreate the remote branch. | 0 recreations across 20 simulated merge→re-enter cycles in integration test. | New integration test: seed a merged-and-deleted PR, invoke phase-commit path, assert `git ls-remote origin <branch>` returns empty and no new PR exists. |
| SC-002 | A push targeting a branch whose PR is merged/closed is refused; the refusal is logged at `warn` or above with the FR-003a event shape. | 100% of attempted pushes to a merged-PR branch are refused; every refusal emits exactly one `warn`-or-above line matching `event: 'push-refused'` with a valid `reason` enum value. | Unit test on the pre-push guard covering `{PR merged + branch present, PR closed + branch present, PR merged + branch missing, PR open + branch missing, PR open + branch present (allow), no PR + branch present (allow — first-push case), no PR + branch missing (refuse: branch-missing)}` matrix. |
| SC-003 | Files belonging to issue B cannot land in a commit on issue A's branch. | 0 cross-issue file contaminations in the regression test that runs two issues through one reused checkout. | New regression test in `packages/orchestrator/src/__tests__/repo-checkout-cross-issue.test.ts` (or equivalent): seed the checkout with issue B's staged files, run the phase-commit path for issue A, assert issue A's HEAD commit contains only issue-A-scoped files (path prefix + spec dir check). |
| SC-004 | A phase job for a closed issue is dropped at dispatch with an `info` log line naming the reason. Applies to **both** process and resume events. | 100% of dispatched phase jobs whose target issue is closed exit with 0 mutations (no checkout, no push, no PR, no label mutation). | Integration test on the dispatch path: enqueue a phase job for a pre-closed issue for each of (a) `type: 'process'` and (b) `type: 'resume'`, assert no git operations occurred and the log line is present with fields `{ dropped: 'issue-closed', issueNumber, eventType, phase }`. |
| SC-005 | `git fetch origin` in `repo-checkout.ts` uses `--prune` at **both** call sites. | grep of `packages/orchestrator/src/worker/repo-checkout.ts` shows exactly two multi-ref `git fetch origin` invocations (in `switchBranch` and `updateRepo`), both including `--prune`. `fetchBase`'s single-ref `git fetch origin <baseBranch>` is exempt. | Static check; also asserted by the SC-001 integration test which runs the merge→re-enter cycle through both `switchBranch` and `updateRepo` code paths. |
| SC-006 | Zero regression in normal (non-merged-PR) speckit workflow completion. | Existing speckit end-to-end tests (`speckit-feature` and `speckit-bugfix` happy paths) continue to pass unchanged. | Existing test suite. |

## Assumptions

- The PR-state check in FR-002 **cannot** be satisfied with `findPRForBranch` as written (Q2 clarification): it calls `gh pr list --head <branch>` with no `--state` flag, and `gh pr list` defaults to open-only. A new `state` parameter on `findPRForBranch` or a dedicated helper is required. `findPRForBranch`'s existing default MUST NOT change — five other call sites (`pr-manager.ts` × 2, `sibling-fanout.ts` × 2, and mocks in tests) depend on open-only behaviour.
- The remote-branch-existence check in FR-002 can be satisfied with `git ls-remote --heads origin <branch>` (already used elsewhere) or via `GET /repos/{owner}/{repo}/branches/{branch}` — implementation-time choice.
- The dispatch gate in FR-005 has access to `github.getIssue()` (which returns `state`) or the label state already loaded by `label-monitor-service.ts`; no new query surface needed. `LabelMonitorService.processLabelEvent()` is the correct hook site — it already knows the issue number for both `process` and `resume` paths.
- The FR-003b "issue state at refusal time" check can piggyback on the FR-002 PR lookup where the same request returns issue linkage, or a small `github.getIssue()` call — either is acceptable within the FR-008 budget.
- The regression test for SC-003 can construct a two-issue reused-checkout scenario without needing real GitHub — the file-contamination mechanism is purely local (working tree state at commit time).
- The `--prune` flag is safe to apply unconditionally at both `switchBranch` and `updateRepo` fetch sites; there is no in-tree caller that relies on a locally-cached but upstream-deleted ref surviving. `fetchBase`'s single-ref fetch is out of scope for `--prune`.

## Out of Scope

- Cleaning up already-stranded duplicate PRs (e.g., generacy-cloud#883). This spec prevents new occurrences; existing PRs are a manual cleanup.
- Changes to `PrFeedbackMonitorService`'s merged-PR gate — that is #1049 and has already shipped.
- Per-issue checkout isolation as a new subsystem: FR-004 permits either hard-reset OR per-issue isolation; a full workspace-isolation redesign is a separate future spec.
- Any change to workflow YAMLs (`speckit-feature.yaml`, `speckit-bugfix.yaml`) — the fixes are all in the orchestrator worker.
- Cross-repo scenarios (multi-repo workflows introduced by #687/#690/#692): the same principle applies but the primary/sibling checkout topology may need its own gates in a follow-up.
- Telemetry / relay events for resurrection attempts (e.g., a new `cluster.orchestrator` event). Warn-log is sufficient for v1; a structured event can follow if operators find they need it.

---

*Generated by speckit*
