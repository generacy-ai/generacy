# Feature Specification: `cockpit merge` deletes the head branch after squash

**Branch**: `859-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft
**Source**: [generacy-ai/generacy#859](https://github.com/generacy-ai/generacy/issues/859)

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #24 — observed on the first successful cockpit squash-merge (christrudelpw/sniplink PR #16).

After the squash, the head branch (`002-phase-1-foundation-part`) is left behind — GitHub shows the "branch can be safely deleted" prompt and the manual playbook's hygiene step comes back. Stale speckit branches accumulate fast on an epic (one per child issue) and confuse later branch listings and the workers' checkout logic.

Fix: `cockpit merge` deletes the head branch after a successful squash — either `--delete-branch` on the underlying `gh pr merge` call or an explicit ref delete after merge confirmation. Handle gracefully (info log, not error): branch already deleted (repo has auto-delete enabled), and cross-fork PRs (no delete permission — skip with a note). The merge result line should mention the deletion (`"merged and branch deleted"`) so the outcome is visible. Out of scope: retroactive cleanup of existing stale branches, and flipping the repo-level auto-delete setting at scaffold time — worth considering separately in the project-creation flow, but the verb should not depend on a repo setting being present.

## Current State

`packages/cockpit/src/gh/wrapper.ts:799-812` — `mergePullRequest` explicitly passes `--delete-branch=false` to `gh pr merge`:

```ts
await this.runner('gh', [
  'pr', 'merge', String(prNumber),
  '--repo', repo,
  '--squash',
  '--delete-branch=false',
]);
```

The head ref name is already carried on `PullRequestDetail.head` (`wrapper.ts:53`) — no extra API round-trip needed to know what to delete.

`packages/generacy/src/cli/commands/cockpit/merge.ts:154, 181` — the two success paths (`noActual && noRequired` vacuous-green from #857, and the classify-passing path) both terminate with `logger.info({ pr }, 'PR merged')` and return without touching the head branch.

## User Stories

### US1: Operator running `cockpit merge` finishes with a clean branch list

**As a** cockpit operator squash-merging a child issue's PR,
**I want** the head branch to be deleted as part of the same verb,
**So that** I don't need to run a separate `git push --delete` (or click GitHub's prompt), and stale speckit branches don't pile up across an epic.

**Acceptance Criteria**:
- [ ] After `cockpit merge <N>` succeeds against a same-repo PR, the head ref no longer exists on GitHub.
- [ ] Terminal output for the successful merge names the deletion (e.g., trailing `merged and branch deleted`).
- [ ] Exit code remains `0` on merge success even when branch deletion is skipped due to permissions or a race with GitHub auto-delete.

### US2: Cross-fork or auto-delete-enabled PRs don't fail the verb

**As a** cockpit operator merging a PR from a fork, or against a repo that has GitHub's auto-delete-head-branches setting turned on,
**I want** the delete step to be best-effort,
**So that** the merge itself is never marked as failed just because the branch couldn't be (or was already) removed.

**Acceptance Criteria**:
- [ ] Cross-fork PR: merge succeeds; branch deletion is skipped with an info-level log naming the reason; exit code `0`.
- [ ] Auto-delete race (branch already gone at delete time): merge succeeds; a distinct info-level log records the already-deleted case; exit code `0`.
- [ ] Non-permission, non-already-deleted failures during delete surface a warning but still return exit `0` (the merge itself succeeded) — the operator can retry the ref delete manually.

### US3: Worker checkout logic sees fewer stale branches

**As a** speckit worker that lists refs to find the next issue's working branch,
**I want** merged speckit branches gone as soon as their merge verb completes,
**So that** branch enumeration is smaller and the checkout logic doesn't collide with a stale head from a prior issue.

**Acceptance Criteria**:
- [ ] Across an epic with N child issues merged one at a time via `cockpit merge`, the count of speckit-named branches on the remote after the last merge is 0 (modulo any that legitimately failed to merge).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On a successful squash-merge of a same-repo PR, `cockpit merge` MUST delete the PR's head ref on the remote as part of the same verb. | P1 | Either flip `mergePullRequest`'s existing `--delete-branch=false` to `--delete-branch`, or add an explicit `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/{head}` after merge confirmation. |
| FR-002 | The successful merge stdout MUST include a human-readable indication that the branch was deleted (e.g., `merged and branch deleted`). | P1 | Appended to `RunMergeResult.stdout` in the pattern established by #857's vacuous-green note. |
| FR-003 | If the branch delete fails because the branch is already gone (GitHub auto-delete race, HTTP 422/404), `cockpit merge` MUST NOT treat that as an error — log at `info`, note the condition in the merge result line (e.g., `merged (branch was already deleted)`), exit `0`. | P1 | Distinguish this case from FR-004 so the operator can tell "we deleted it" from "it was already gone." |
| FR-004 | If the branch delete fails because the PR is cross-fork and the current token lacks delete permission on the head repo, `cockpit merge` MUST skip deletion gracefully — log at `info` (naming the cross-fork condition), note it in the merge result line, exit `0`. | P1 | Detect via `PullRequestDetail`: head repo owner ≠ base repo owner, OR the gh error message clearly indicates permission denial. |
| FR-005 | If the branch delete fails for any other reason (network hiccup, transient GitHub error), `cockpit merge` MUST log a `warn` including the underlying gh stderr and still exit `0`. | P1 | The merge itself succeeded — the operator can retry the ref delete manually. |
| FR-006 | The verb MUST NOT depend on any repo-level "auto-delete head branches" setting being present or absent. | P1 | Repos with the setting on: branch is deleted by GitHub before or during our attempt — FR-003 covers it. Repos with it off: our delete is the mechanism. |
| FR-007 | Both success paths in `runMerge` (vacuous-green from #857 and the classify-passing path) MUST attempt the delete and honor FR-001 through FR-005 identically. | P1 | Merge-succeeded is the trigger, not which branch of the pre-merge logic ran. |
| FR-008 | Failed-merge paths (missing `completed:validate`, failing checks, unresolved PR, closed issue, non-open PR) MUST NOT attempt a branch delete. | P1 | Delete happens after `mergePullRequest` returns `merged: true`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | After `cockpit merge` succeeds on a same-repo, single-remote PR, the PR's head ref exists on GitHub. | 0% (deleted) | Verify with `gh api repos/{owner}/{repo}/git/refs/heads/{head}` returning 404 after the verb exits. |
| SC-002 | After running `cockpit merge` on every child issue of a completed epic of ≥5 issues, the remote branch count for that epic's speckit-named branches drops. | 0 remaining | `gh api repos/{owner}/{repo}/branches --paginate | jq '[.[] | select(.name | test("^\d{3}-"))] | length'` before and after — after the final merge should return 0. |
| SC-003 | Cross-fork PR: `cockpit merge` returns exit `0` and the merge is applied even when the head branch cannot be deleted. | 100% | Regression test: PR whose head is `outside-owner:branch` — verify merge succeeds, delete is skipped, exit `0`, stdout mentions cross-fork skip. |
| SC-004 | Auto-delete-enabled repo: `cockpit merge` returns exit `0` and stdout distinguishes the "already deleted" case from "we deleted it." | 100% | Regression test: mock `gh pr merge --delete-branch` succeeding + the follow-up ref delete returning 404 (or the initial `gh pr merge` reporting it deleted). |
| SC-005 | Regression: none of the existing failure paths from `merge.test.ts` (missing label, failing checks, unresolved PR, closed issue, non-open PR) start attempting a ref delete. | 0 unintended API calls | Existing test suite continues to pass with a spy on the delete path asserting it's untouched on those branches. |

## Assumptions

- The gh CLI is authenticated with a token that has push (delete-ref) permission on same-repo PRs — same permission the workers already assume for `git push`.
- `PullRequestDetail.head` (already populated by `getPullRequestDetail`) is the correct head ref name to pass into the delete call.
- Cross-fork detection can be inferred from the PR detail rather than requiring a new gh call — e.g., `PullRequestRef`/`PullRequestDetail` already surface enough (headRefName + whether head owner matches base owner). If not, a small extension to the wrapper is acceptable within scope.
- The `gh pr merge --delete-branch` flag delegates to a ref delete under the hood — if that behavior differs from an explicit `gh api -X DELETE …/refs/heads/…` (e.g., in error semantics), the implementation chooses whichever gives us the sharpest distinction between FR-003 and FR-004.
- `RunMergeResult.stdout` is the correct surface for the deletion note — same channel `#857` used for its `no checks configured` note.

## Out of Scope

- Retroactive cleanup of existing stale branches (would need a separate `cockpit cleanup` verb or one-shot script; explicitly deferred).
- Flipping the repo-level "automatically delete head branches" setting during project scaffolding (worth considering separately in the project-creation flow; the verb intentionally does not depend on that setting being present).
- Deleting local git branches (workers/operators own local branch hygiene; the verb only touches the remote).
- Any change to the merge decision itself — `completed:validate` gate and required-checks classification remain unchanged.
- Behavior for merge strategies other than squash (`cockpit merge` only invokes `--squash` today; if we add `--merge`/`--rebase` later, deletion semantics get re-examined then).

## Risks

- **Race with GitHub auto-delete**: repos with auto-delete on may delete the branch before our follow-up. FR-003 makes this a first-class success case, but the implementation must handle both orderings (gh returns already-gone vs. our attempt succeeds and gh silently no-ops).
- **Fork detection sharpness**: getting cross-fork detection wrong could either fail a merge (bad) or attempt a delete that returns a confusing permission error (also bad — collapses into the warn bucket via FR-005). Prefer conservative fork detection with FR-005 as the safety net.
- **Ambient gh permission drift**: if the token's permission changes across a session (e.g., installation-token refresh), the delete may start failing in a way we haven't seen before. FR-005 is the catch-all; the merge itself is unaffected.

---

*Generated by speckit*
