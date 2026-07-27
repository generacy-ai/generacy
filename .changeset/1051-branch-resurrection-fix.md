---
"@generacy-ai/workflow-engine": patch
"@generacy-ai/orchestrator": patch
---

Prevent orchestrator worker from resurrecting merged-and-deleted branches and
cross-contaminating issues (#1051).

Bundles four independent, additive fixes that together prevent a re-entering
worker from resurrecting a deleted branch, silently committing another issue's
files onto it, and opening a duplicate PR that claims `Closes #<already-closed>`:

- **FR-001**: adds `--prune` to the multi-ref `git fetch origin` in both
  `RepoCheckout.switchBranch` and `RepoCheckout.updateRepo`. Deleted upstream
  branches are removed from local tracking refs so `reset --hard origin/<branch>`
  no longer silently succeeds against a stale ref. `fetchBase` (single-ref) is
  unchanged (invariant I-3).
- **FR-002/003**: new stateless `push-guard` module + wiring at three sites
  (`pr-feedback-handler.commitAndPushChanges`, `pr-manager.commitAndPush`,
  `phase-loop` entry). Refuses a push when the PR has already merged/closed
  or the remote branch is missing, emitting `event: 'push-refused'` and
  clearing `agent:in-progress` (plus adding `agent:error` on still-open issues).
  Never adds `failed:<phase>` — invites `/cockpit:resume` into a loop.
- **FR-004**: regression test only. Existing `git reset --hard HEAD` +
  `git clean -fd` inside `switchBranch` already provide the cross-issue
  contamination invariant; the new
  `packages/orchestrator/src/__tests__/repo-checkout-cross-issue.test.ts` is
  the regression guard.
- **FR-005**: `LabelMonitorService.processLabelEvent` drops both `process`
  and `resume` events whose target issue is closed at the moment of dispatch,
  emitting one `info` log line with `dropped: 'issue-closed'`. Zero mutations
  on drop. Complements #1049's `PrFeedbackMonitorService` merged-PR gate,
  which covers only the address-pr-feedback entry path.

`workflow-engine` gains one new internal method `findPRForBranchAnyState` on
`GitHubClient` — used only by orchestrator's `push-guard`, not re-exported at
the public boundary. Existing `findPRForBranch` is intentionally unchanged;
five call sites depend on its open-only default (invariant I-2).

No new labels, no new persisted state, no workflow-YAML changes.
