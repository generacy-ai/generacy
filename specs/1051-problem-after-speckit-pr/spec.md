# Feature Specification: Prevent worker from resurrecting deleted branches and cross-contaminating issues after PR merge

**Branch**: `1051-problem-after-speckit-pr` | **Date**: 2026-07-27 | **Status**: Draft | **Issue**: [#1051](https://github.com/generacy-ai/generacy/issues/1051)

## Summary

After a speckit PR merges and its head branch is deleted, the orchestrator worker re-enters on a stale reused checkout, resurrects the deleted remote branch, commits work belonging to a **different** issue onto it, and opens a duplicate PR that claims to close the already-closed issue. Nothing lands incorrectly on `develop`, but the operator sees a stranded branch, orphan commits (in the observed case, nine), and a misleading duplicate PR that looks legitimate at a glance.

Two independent in-tree contributors compose to produce this outcome:

1. `packages/orchestrator/src/worker/repo-checkout.ts:110` runs `git fetch origin` **without `--prune`**, so a branch deleted upstream remains locally resolvable.
2. `packages/orchestrator/src/worker/pr-feedback-handler.ts:127-138` checks out `pr.head.ref` unconditionally and pushes at `:670` with no check that the PR is still open or the remote branch still exists — the push silently recreates the branch.
3. The checkout is reused across issues within a repo and was not clean when re-entered (`repo-checkout.ts:14,:35`) — the working tree still held #880's files when #879's phase job ran.

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
- [ ] The fetch invocation in `repo-checkout.ts` (line ~110) uses `--prune` (or an equivalent stale-ref cleanup).
- [ ] After a PR merges with `--delete-branch`, a subsequent worker re-entry in the same checkout does NOT recreate the remote branch (SC-001).

### US2 — Pushes to a merged/closed PR's branch are refused loudly

**As an** operator triaging an unexpected PR,
**I want** any attempt to push to a branch whose PR is merged or closed to fail with a `warn`-or-above log line naming the PR state,
**So that** a resurrected branch is distinguishable from normal operation in the logs and cannot silently produce a duplicate PR.

**Acceptance Criteria**:
- [ ] Before `commitAndPushChanges` (called from `pr-feedback-handler.ts:670` and the phase-commit path), the worker verifies the PR is still open **and** the remote branch still exists.
- [ ] If either check fails, the push is refused, the job exits without opening a duplicate PR, and one `warn` (or `error`) log line is emitted naming the failing check and the PR number (SC-002).

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
- [ ] If the issue is closed, the job is dropped with an `info` log line naming the issue number and reason (`issue closed`).
- [ ] The drop is silent from a mutation standpoint: no branch checkout, no push, no PR creation (SC-004).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `git fetch` in `repo-checkout.ts` MUST use `--prune` (or equivalent). | P1 | US1. One-line change; sits on the critical path so must not regress the checkout perf. |
| FR-002 | Before any push in `pr-feedback-handler.ts` and the phase-commit path, the worker MUST verify (a) the PR is still open and (b) the remote branch still exists at the origin. | P1 | US2. Both checks required — one alone leaves a race window. |
| FR-003 | If FR-002 checks fail, the push MUST be refused; the job MUST exit without opening a new PR; one `warn`-or-above log line MUST name the failing check, the PR number, and the branch. | P1 | US2. Silent skip is the current defect; loud refusal is the corrective posture. |
| FR-004 | On checkout reuse, the working tree MUST be guaranteed to contain only files scoped to the target issue at the moment the phase step begins. | P1 | US3. Implementation choice (hard-reset vs. per-issue checkout) is a `plan.md` decision. |
| FR-005 | A phase job whose target issue is closed MUST be dropped at dispatch with an `info` log line naming the issue number and the reason `issue closed`. | P1 | US4. Defense-in-depth. |
| FR-006 | Applies uniformly to `workflow:speckit-feature` and `workflow:speckit-bugfix`; must not require workflow-specific branching in the fix sites. | P2 | Both workflows use the same commit/push code paths — a per-workflow gate would be a bug. |
| FR-007 | No new persisted state (Redis key, file, or PR/issue marker) is introduced. All checks are stateless queries against GitHub or the local git repo. | P2 | Mirrors #1043's Q1=A rationale — avoids the stale-key/TTL class of bugs that #849 fixed. |
| FR-008 | The prune, PR-state check, and dispatch gate MUST NOT slow the happy path measurably (target: no new synchronous GitHub calls on cold cache above the one already made per phase entry; the PR-state check can piggyback on the existing PR lookup where one occurs). | P3 | Non-functional; call this out in `plan.md`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | After a PR merges with branch deletion, worker re-entry on the same checkout does NOT recreate the remote branch. | 0 recreations across 20 simulated merge→re-enter cycles in integration test. | New integration test: seed a merged-and-deleted PR, invoke phase-commit path, assert `git ls-remote origin <branch>` returns empty and no new PR exists. |
| SC-002 | A push targeting a branch whose PR is merged/closed is refused; the refusal is logged at `warn` or above. | 100% of attempted pushes to a merged-PR branch are refused; every refusal emits exactly one `warn`-or-above line. | Unit test on the pre-push guard covering `{PR merged, PR closed, remote branch missing, PR open + branch present}` matrix. |
| SC-003 | Files belonging to issue B cannot land in a commit on issue A's branch. | 0 cross-issue file contaminations in the regression test that runs two issues through one reused checkout. | New regression test in `packages/orchestrator/src/__tests__/repo-checkout-cross-issue.test.ts` (or equivalent): seed the checkout with issue B's staged files, run the phase-commit path for issue A, assert issue A's HEAD commit contains only issue-A-scoped files (path prefix + spec dir check). |
| SC-004 | A phase job for a closed issue is dropped at dispatch with an `info` log line naming the reason. | 100% of dispatched phase jobs whose target issue is closed exit with 0 mutations (no checkout, no push, no PR). | Integration test on the dispatch path: enqueue a phase job for a pre-closed issue, assert no git operations occurred and the log line is present with fields `{ issueNumber, reason: 'issue closed' }`. |
| SC-005 | `git fetch` in `repo-checkout.ts` uses `--prune`. | grep of `packages/orchestrator/src/worker/repo-checkout.ts` shows exactly one `git fetch` invocation, and it includes `--prune`. | Static check; also asserted by the SC-001 integration test as a side effect. |
| SC-006 | Zero regression in normal (non-merged-PR) speckit workflow completion. | Existing speckit end-to-end tests (`speckit-feature` and `speckit-bugfix` happy paths) continue to pass unchanged. | Existing test suite. |

## Assumptions

- The PR-state check in FR-002 can be satisfied with the existing `GitHubClient` methods (`getPullRequest` or equivalent — the `PullRequest` type already carries `state` and `merged`); no new client methods required.
- The remote-branch-existence check in FR-002 can be satisfied with `git ls-remote --heads origin <branch>` (already used elsewhere) or via `GET /repos/{owner}/{repo}/branches/{branch}` — implementation-time choice.
- The dispatch gate in FR-005 has access to `github.getIssue()` (which returns `state`) or the label state already loaded by `label-monitor-service.ts`; no new query surface needed.
- The regression test for SC-003 can construct a two-issue reused-checkout scenario without needing real GitHub — the file-contamination mechanism is purely local (working tree state at commit time).
- The `--prune` flag is safe to apply unconditionally; there is no in-tree caller that relies on a locally-cached but upstream-deleted ref surviving.

## Out of Scope

- Cleaning up already-stranded duplicate PRs (e.g., generacy-cloud#883). This spec prevents new occurrences; existing PRs are a manual cleanup.
- Changes to `PrFeedbackMonitorService`'s merged-PR gate — that is #1049 and has already shipped.
- Per-issue checkout isolation as a new subsystem: FR-004 permits either hard-reset OR per-issue isolation; a full workspace-isolation redesign is a separate future spec.
- Any change to workflow YAMLs (`speckit-feature.yaml`, `speckit-bugfix.yaml`) — the fixes are all in the orchestrator worker.
- Cross-repo scenarios (multi-repo workflows introduced by #687/#690/#692): the same principle applies but the primary/sibling checkout topology may need its own gates in a follow-up.
- Telemetry / relay events for resurrection attempts (e.g., a new `cluster.orchestrator` event). Warn-log is sufficient for v1; a structured event can follow if operators find they need it.

---

*Generated by speckit*
