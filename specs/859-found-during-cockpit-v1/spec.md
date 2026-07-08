# Feature Specification: `cockpit merge` deletes the head branch after squash

**Branch**: `859-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft
**Issue**: [generacy-ai/generacy#859](https://github.com/generacy-ai/generacy/issues/859)

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88, finding #24) on the first successful cockpit squash-merge (christrudelpw/sniplink PR #16). After the squash, the head branch (e.g. `002-phase-1-foundation-part`) is left behind — GitHub shows the "branch can be safely deleted" prompt and the manual playbook's hygiene step comes back. Stale speckit branches accumulate one-per-child-issue on an epic and confuse later branch listings and the workers' checkout logic.

`cockpit merge` should delete the head branch after a successful squash-merge as part of the verb, with graceful handling for repos where the branch was already auto-deleted, cross-fork PRs where the caller lacks delete permission, and unexpected delete failures. The merge result line surfaces the deletion outcome so operators see what happened without inspecting GitHub.

## User Stories

### US1: Cockpit-driven epics leave no branch litter

**As a** cockpit operator merging speckit-feature PRs across an epic,
**I want** `cockpit merge` to delete the head branch as part of a successful squash,
**So that** the branch list stays clean without a manual `gh api -X DELETE` hygiene pass and later branch listings / worker checkout logic aren't polluted by stale refs.

**Acceptance Criteria**:
- [ ] After a successful `cockpit merge` against a same-repo PR, the head branch no longer exists on the remote.
- [ ] The stdout line reports "branch deleted" so the operator can confirm the outcome without a follow-up GitHub check.
- [ ] The verb succeeds without the operator running any additional command.

### US2: Repos with auto-delete enabled don't produce spurious errors

**As a** cockpit operator merging PRs in a repo where GitHub's "Automatically delete head branches" is enabled,
**I want** the delete step to recognize an already-deleted branch as a non-error outcome,
**So that** the verb still exits 0 and the stdout distinguishes "we deleted it" from "it was already gone".

**Acceptance Criteria**:
- [ ] A 404 on the ref-delete API is classified as "already deleted" (not "delete failed").
- [ ] Exit code is 0.
- [ ] Stdout says `merged (branch was already deleted)` so the operator understands the repo setting handled it.

### US3: Cross-fork PRs skip the delete without failing

**As a** cockpit operator merging a PR whose head branch lives in a fork,
**I want** the delete step to be skipped with an informational note,
**So that** the merge itself still succeeds and the fork-owner's branch is left alone (we lack permission and shouldn't).

**Acceptance Criteria**:
- [ ] Cross-fork PRs are detected deterministically from `PullRequestDetail.headRepositoryOwner` before the delete API is called.
- [ ] No delete API call is made for cross-fork PRs.
- [ ] Stdout says `merged (branch delete skipped: cross-fork PR)` and the verb exits 0.

### US4: Unexpected delete failures don't fail the merge

**As a** cockpit operator whose merge just succeeded,
**I want** an unexpected delete failure (permission denied, transient API error) to be surfaced as a warning rather than a hard error,
**So that** the merge — the load-bearing action the verb performed — isn't reported as failed because of a cosmetic post-step.

**Acceptance Criteria**:
- [ ] A non-404 delete failure surfaces the wrapped `gh` stderr in the stdout line.
- [ ] The verb still exits 0 (merge succeeded, delete is post-hoc hygiene).
- [ ] Stdout uses the canonical prefix `merged (branch delete failed: ` followed by the underlying gh error text.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `cockpit merge` MUST delete the head branch after a successful squash-merge via an explicit `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/{head}` call, invoked after merge confirmation. | P1 | Clarification Q1→B. Distinct API response codes (404 vs 422/403) are what make FR-003/FR-004/FR-005 implementable as distinct stdout variants. |
| FR-002 | On successful delete, stdout MUST include the canonical string `merged and branch deleted`. On the vacuous-green path this appends to the existing line; on the classify-passing path it is emitted as the sole stdout line. | P1 | Clarification Q4→C canonical wording. |
| FR-003 | When the delete API returns 404 (branch already gone — e.g. GitHub repo-level auto-delete), stdout MUST say `merged (branch was already deleted)` and the verb MUST exit 0. | P1 | Clarification Q4→C canonical wording. |
| FR-004 | When `PullRequestDetail.headRepositoryOwner` ≠ base repo owner (cross-fork PR), the delete step MUST be skipped without calling the delete API. Stdout MUST say `merged (branch delete skipped: cross-fork PR)`. | P1 | Clarification Q2→A. Pre-check deterministic — no stderr pattern-matching. |
| FR-005 | Any non-404 delete failure (permission denied, transient API error) MUST NOT fail the verb; stdout MUST include `merged (branch delete failed: <gh stderr>)` where the prefix is canonical and `<gh stderr>` is free-form. Verb exits 0. | P1 | Clarification Q4→C prefix canonical, tail free-form. |
| FR-006 | The wrapper (`packages/generacy/src/cli/commands/cockpit/wrapper.ts`) MUST expose two new primitives: a `deleteHeadRef(repo, headRef)` method returning a classified outcome, and a `headRepositoryOwner` field on `PullRequestDetail` returned by `getPullRequestDetail`. The wrapper MUST NOT own outcome classification for stdout composition. | P1 | Clarification Q3→C slimmed. Wrapper is plumbing; classification lives in the caller. |
| FR-007 | The runner (`packages/generacy/src/cli/commands/cockpit/merge.ts`) MUST orchestrate the sequence: `mergePullRequest` (still with `--delete-branch=false`) → if merge succeeded and PR is same-repo, call `deleteHeadRef` → classify outcome → compose canonical stdout. | P1 | Clarification Q3→C. |
| FR-008 | There MUST NOT be a per-invocation `--keep-branch` / `--no-delete-branch` opt-out flag in this iteration. | P2 | Clarification Q5→C — defer until a real workflow requests it. |
| FR-009 | `mergePullRequest` MUST continue to pass `--delete-branch=false` to `gh pr merge`. All delete behavior MUST be driven by the explicit ref-delete step, not by gh's built-in flag. | P1 | Clarification Q1→B. Preserves the classification power that Q1's Option A folds away. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Head branch deletion on successful same-repo merge | 100% of successful same-repo `cockpit merge` invocations remove the head ref from the remote (subject to FR-003/FR-004/FR-005 outcomes) | Automated regression test against a fixture PR asserts `git ls-remote --heads origin <head>` returns empty after merge; integration smoke run against a live cockpit-merged PR shows the "branch can be safely deleted" prompt absent. |
| SC-002 | Stdout wording lock | 4/4 canonical variants (FR-002, FR-003, FR-004, and FR-005's prefix) exactly matched by test assertions | Unit tests on the runner assert byte-exact stdout for the four deterministic strings and the canonical `merged (branch delete failed: ` prefix. |
| SC-003 | No regressions on merge exit code | 0 non-zero exit codes attributable to the delete step across the test matrix | All FR-003/FR-004/FR-005 branches assert exit code 0; only pre-merge failures produce non-zero exit codes. |
| SC-004 | Cross-fork safety | 0 delete API calls issued for cross-fork PRs across the test matrix | Wrapper mock asserts `deleteHeadRef` is never invoked when `headRepositoryOwner ≠ baseOwner`. |
| SC-005 | Stale-branch accumulation on epic runs | 0 stale head branches left behind after a full epic run through cockpit | Post-epic `gh api repos/{owner}/{repo}/branches` matches only the base branch plus in-flight branches; no `NNN-*` speckit branches remain post-merge. |

## Assumptions

- The runner already receives (or can obtain via `getPullRequestDetail`) the base and head ref names and the base repo owner for stdout composition and cross-fork detection.
- `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/{head}` returns 404 on already-deleted branches (verified against current GitHub API behavior).
- The wrapper's `PullRequestDetail` type is stable enough to accept a new `headRepositoryOwner` field without cascading refactors.
- Operators who want to preserve a head branch post-merge can restore it via GitHub's "Restore branch" button; per-invocation opt-out is not needed in this iteration (Q5→C).
- The vacuous-green stdout path (`no checks configured and none required — proceeding on completed:validate\n`, per #857) is preserved and the branch-outcome line appends to it; the classify-passing path emits the branch-outcome line as its sole stdout content.

## Out of Scope

- Retroactive cleanup of existing stale branches on repos that adopted cockpit before this fix.
- Flipping the repo-level "Automatically delete head branches" setting at project-scaffold time (worth considering separately in the project-creation flow, but this verb MUST NOT depend on the setting being on).
- Adding an operator opt-out flag (`--keep-branch` / `--no-delete-branch`) — deferred per Q5→C until a real workflow requests it.
- Changing `mergePullRequest` to call `gh pr merge --delete-branch` directly (Q1→A rejected — folds classification into gh's opaque success path).
- Stderr pattern-matching for cross-fork detection (Q2→B rejected — brittle across `gh` versions, #855-class fragility).
- Owning outcome classification inside the wrapper's `MergeResult` (Q3→A rejected — pushes policy into plumbing).

---

*Generated by speckit*
