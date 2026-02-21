# Feature Specification: Worker must pull latest develop before creating feature branch

**Branch**: `210-description-when-orchestrator` | **Date**: 2026-02-21 | **Status**: Draft

## Summary

The orchestrator worker creates feature branches from a stale local copy of the default branch (`develop`), causing avoidable merge conflicts in PRs. The fix ensures the worker always fetches and resets to the latest remote `develop` before creating or resuming a feature branch, and that the speckit `createFeature()` function explicitly bases new branches on the freshly-updated default branch.

## Background

### Observed Behavior

PR #209 had merge conflicts despite no changes being made to `develop` while the issue was being worked on. The feature branch was based on an older commit of `develop`, so it conflicted with code that was already on `develop` before the work started.

### Root Cause Analysis

The bug spans two components in the branch creation flow:

1. **`repo-checkout.ts` — `ensureCheckout()`** (lines 46-63): On first invocation for a worker, this clones the repo with `git clone --branch develop`. On subsequent invocations, `updateRepo()` (lines 173-208) performs `git fetch origin` followed by `git reset --hard origin/<branch>`. The update path correctly syncs to the latest remote, but if the repo was already cloned in a previous worker run and no `updateRepo()` is called before branching, the local `develop` may be stale.

2. **`feature.ts` — `createFeature()`** (lines 359-424 in `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`): When creating a new feature branch (the default case), the code calls `git.checkoutLocalBranch(branchName)` which creates a branch from the current HEAD. It does **not** first ensure the current branch is up to date with the remote. If the working directory's `develop` is behind `origin/develop`, the new feature branch starts from a stale commit.

### Affected Components

- `packages/orchestrator/src/worker/repo-checkout.ts` — Repository clone/update logic
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — Worker orchestration and branch setup flow
- `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` — Feature branch creation (called by Claude CLI during the specify phase)

### References

- PR with merge conflicts caused by this: #209

## User Stories

### US1: Worker creates feature branch from latest develop

**As a** developer using the orchestrator to automate issue processing,
**I want** feature branches to always be created from the latest `develop`,
**So that** PRs don't have avoidable merge conflicts caused by stale base branches.

**Acceptance Criteria**:
- [ ] Before creating a feature branch, the worker ensures the local default branch is synced to the latest remote commit
- [ ] A feature branch created by the worker is based on the tip of `origin/develop` (or the configured default branch)
- [ ] No merge conflicts arise from stale base branches when no concurrent changes were made to `develop`

### US2: Resumed work starts from updated feature branch

**As a** developer resuming an interrupted orchestrator run,
**I want** the worker to fetch the latest remote state before switching to my feature branch,
**So that** resumed work reflects any upstream changes and avoids conflicts.

**Acceptance Criteria**:
- [ ] On resume, the worker fetches from origin before checking out the feature branch
- [ ] The feature branch is reset to its latest remote state via `git reset --hard origin/<branch>`
- [ ] Any remote updates to the feature branch (e.g., from a prior push) are reflected locally

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `repo-checkout.ensureCheckout()` must always run the update path (`git fetch origin` + `git reset --hard origin/<branch>`) even if the repo directory already exists from a prior run | P1 | Currently only runs update if the directory exists; the clone path doesn't fetch latest |
| FR-002 | `feature.ts createFeature()` must fetch and reset to the latest default branch before calling `git.checkoutLocalBranch()` for new branches | P1 | Add `git fetch origin` + `git checkout <default>` + `git reset --hard origin/<default>` before branching |
| FR-003 | When an epic parent branch is specified, `createFeature()` must fetch the latest remote epic branch before branching from it | P2 | Currently does `git pull` which may fail with local conflicts; prefer `git fetch` + `git reset --hard` |
| FR-004 | `claude-cli-worker.ts` must ensure the checkout is fully up-to-date before spawning Claude CLI for the specify phase | P1 | The `ensureCheckout()` call at line 144 must guarantee a fresh state |
| FR-005 | On resume, `switchBranch()` must fetch and reset the feature branch to its remote tracking state | P2 | Currently implemented correctly; verify no regressions |
| FR-006 | Log the commit SHA of the base branch after sync, before creating the feature branch, for debugging | P3 | Aids diagnosis of future stale-branch issues |

## Technical Design

### Fix 1: `repo-checkout.ts` — Ensure `updateRepo()` always runs

In `ensureCheckout()`, after verifying the checkout directory exists, always call `updateRepo()` to sync with the remote before returning the path. This ensures that even if the directory was cloned in a prior worker invocation, the local branch reflects the latest remote state.

```
async ensureCheckout(workerId, owner, repo, branch):
  if directory exists:
    await updateRepo(checkoutPath, branch)  // always sync
  else:
    await cloneRepo(owner, repo, branch, checkoutPath)
  return checkoutPath
```

### Fix 2: `feature.ts` — Sync default branch before creating feature branch

In `createFeature()`, before the `git.checkoutLocalBranch(branchName)` call for new branches, add:

```
await git.fetch(['origin'])
await git.checkout(defaultBranch)
await git.reset(['--hard', `origin/${defaultBranch}`])
await git.checkoutLocalBranch(branchName)
```

This guarantees the new feature branch forks from the tip of the remote default branch.

### Fix 3: Epic branch handling

When branching from an epic parent, replace the current `git pull` with:

```
await git.fetch(['origin'])
await git.checkout(epicBranch)
await git.reset(['--hard', `origin/${epicBranch}`])
await git.checkoutLocalBranch(branchName)
```

This avoids potential merge conflicts during the pull step.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Feature branches based on latest develop | 100% of new branches | Compare feature branch base commit to `origin/develop` HEAD at time of creation — they must match |
| SC-002 | Avoidable merge conflicts from stale base | 0 occurrences | Monitor PRs created by the orchestrator for conflicts that existed before work began |
| SC-003 | Worker sync operations complete without error | 100% success rate | No git fetch/reset failures in worker logs during branch setup |
| SC-004 | Resume correctly syncs feature branch | 100% of resumes | Feature branch matches remote after resume checkout |

## Assumptions

- The orchestrator worker has network access to the git remote (`origin`) at the time of branch creation
- The default branch name is correctly resolved by `getDefaultBranch()` (falls back to `develop`)
- `git reset --hard` is acceptable since the worker operates on isolated checkouts with no uncommitted local changes to preserve
- The `simple-git` library used in `feature.ts` supports the `reset` and `fetch` commands used in the fix
- Workers operate on isolated directory paths (`{workspaceDir}/{workerId}/{owner}/{repo}`) so concurrent workers don't interfere with each other's checkouts

## Out of Scope

- Handling merge conflicts that arise from concurrent changes to `develop` *during* the work period (this fix only addresses stale base branches at the time of branch creation)
- Rebasing feature branches onto updated `develop` mid-workflow
- Changing the branch naming convention or discovery mechanism (`resolveFeatureBranch`)
- Modifying the PR creation or push logic in `pr-manager.ts`
- Adding retry logic for transient network failures during `git fetch`
- Supporting shallow clones or partial fetch for performance optimization

---

*Generated by speckit*
