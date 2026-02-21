# Implementation Plan: Worker must pull latest develop before creating feature branch

## Summary

This fix addresses stale feature branch bases by ensuring two components always sync to the latest remote state before creating branches:

1. **`repo-checkout.ts`** — Already correctly calls `updateRepo()` when the directory exists, but the spec notes a theoretical staleness window. The current code is actually correct for the `ensureCheckout()` path (it always updates if the directory exists). The real gap is in `feature.ts`.

2. **`feature.ts`** — The core bug. When creating a new branch (line 413: `git.checkoutLocalBranch(branchName)`), it branches from whatever HEAD is current. There is no step to fetch and reset the default branch to `origin/<default>` first. The `fetch(['--all', '--prune'])` at line 370 fetches refs but never resets the working tree to the remote default branch HEAD.

3. **Epic branch handling** — Uses `git.pull()` (line 403) which can fail with merge conflicts. Replace with `fetch` + `reset --hard`.

The fix is surgical: add default-branch sync before `checkoutLocalBranch()` in the new-branch code path, replace `pull` with `fetch`+`reset` for epic branches, and add a debug log of the base commit SHA for diagnostics.

## Technical Context

- **Language**: TypeScript (ES modules, `.js` extensions in imports)
- **Runtime**: Node.js
- **Git library**: `simple-git` (in `feature.ts`), raw `execFile('git', ...)` (in `repo-checkout.ts`)
- **Test framework**: Vitest with globals, `vi.mock()` for module mocking
- **Packages affected**:
  - `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
  - `packages/orchestrator/src/worker/repo-checkout.ts`

## Architecture Overview

```
claude-cli-worker.ts
  │
  ├─ repoCheckout.getDefaultBranch()       → resolves "develop"
  ├─ repoCheckout.ensureCheckout()          → clones or updates repo on default branch
  │   └─ updateRepo(): fetch + reset --hard  ← already correct
  │
  ├─ [specify phase] Claude CLI runs →
  │   └─ createFeature()                    ← BUG: branches from stale HEAD
  │       ├─ git.fetch(['--all', '--prune'])  ← fetches refs only
  │       ├─ git.checkoutLocalBranch()        ← creates from current HEAD (stale!)
  │       │
  │       └─ FIX: before checkoutLocalBranch:
  │           ├─ determine default branch
  │           ├─ git.checkout(defaultBranch)
  │           ├─ git.reset(['--hard', `origin/${defaultBranch}`])
  │           └─ git.checkoutLocalBranch(branchName)
  │
  └─ [resume path] repoCheckout.switchBranch()  ← already correct (fetch + reset)
```

## Implementation Phases

### Phase 1: Fix `feature.ts` — Sync default branch before creating feature branch (P1)

**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`

**Requirement**: FR-002

**Changes**:

1. **Add a `getDefaultBranch()` helper** inside `feature.ts` that resolves the default branch from the git remote. Use `git remote show origin` or parse `git symbolic-ref refs/remotes/origin/HEAD` to determine the remote's default branch, with a fallback to `'develop'`.

   ```typescript
   async function getDefaultBranch(git: SimpleGit): Promise<string> {
     try {
       // Parse origin's HEAD reference to find default branch
       const result = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
       // Returns something like "refs/remotes/origin/develop"
       const match = result.trim().replace('refs/remotes/origin/', '');
       if (match) return match;
     } catch {
       // Fallback
     }
     return 'develop';
   }
   ```

2. **Sync default branch before `checkoutLocalBranch()`** in the new-branch creation path (the `else` block at line 412-413). Before creating the feature branch from HEAD, checkout and hard-reset the default branch:

   **Current code** (line 412-413):
   ```typescript
   } else {
     await git.checkoutLocalBranch(branchName);
   }
   ```

   **New code**:
   ```typescript
   } else {
     // Sync to latest default branch before creating feature branch
     const defaultBranch = await getDefaultBranch(git);
     await git.checkout(defaultBranch);
     await git.reset(['--hard', `origin/${defaultBranch}`]);
     await git.checkoutLocalBranch(branchName);
   }
   ```

3. **Log base commit SHA** (FR-006): After resetting to the default branch and before creating the feature branch, log the HEAD commit for debugging:

   ```typescript
   const headSha = await git.revparse(['HEAD']);
   // Log is via console since feature.ts doesn't have a logger injected
   // The calling operation (create-feature.ts) handles logging
   ```

   Since `feature.ts` doesn't have a logger, we'll capture the base SHA in the output. Add `base_commit?: string` to `CreateFeatureOutput` and populate it.

### Phase 2: Fix epic branch handling in `feature.ts` (P2)

**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`

**Requirement**: FR-003

**Changes**:

Replace `git.pull('origin', epicBranch)` (line 402-405) with `git.reset(['--hard', ...])`:

**Current code** (lines 399-406):
```typescript
} else {
  await git.checkout(input.parent_epic_branch);
}
try {
  await git.pull('origin', input.parent_epic_branch);
} catch {
  // Continue even if pull fails
}
```

**New code**:
```typescript
} else {
  await git.checkout(input.parent_epic_branch);
}
await git.reset(['--hard', `origin/${input.parent_epic_branch}`]);
```

This is safe because worker checkouts are isolated with no local uncommitted changes. `reset --hard` is strictly better than `pull` here: it cannot produce merge conflicts and guarantees the branch tip matches the remote.

### Phase 3: Verify `repo-checkout.ts` behavior (P1 — verification only)

**File**: `packages/orchestrator/src/worker/repo-checkout.ts`

**Requirements**: FR-001, FR-004, FR-005

**Analysis**: After re-reading the code, `ensureCheckout()` already handles both paths correctly:
- **Directory exists** → `updateRepo()` → `fetch` + `reset --hard` (correct)
- **Directory does not exist** → `cloneRepo()` with `--branch` flag (clones latest from remote, correct)

The spec's FR-001 mentions "must always run the update path even if the repo directory already exists" — but the current code already does this (line 58-59: `if exists → updateRepo()`). The `cloneRepo` path (line 57) only runs when the directory does not exist, and `git clone` always fetches the latest.

**No code changes needed** for `repo-checkout.ts`. The `ensureCheckout()` call at line 145 of `claude-cli-worker.ts` already guarantees a fresh state before spawning Claude CLI.

`switchBranch()` (FR-005) already implements `fetch` + `reset --hard` correctly.

**Action**: Add a unit test for `RepoCheckout` to document and verify this behavior, preventing regressions.

### Phase 4: Add `base_commit` to output type (P3)

**File**: `packages/workflow-engine/src/actions/builtin/speckit/types.ts`

**Requirement**: FR-006

**Change**: Add optional `base_commit` field to `CreateFeatureOutput`:

```typescript
export interface CreateFeatureOutput {
  success: boolean;
  branch_name: string;
  feature_num: string;
  spec_file: string;
  feature_dir: string;
  git_branch_created: boolean;
  branched_from_epic?: boolean;
  parent_epic_branch?: string;
  base_commit?: string;  // SHA of the commit the feature branch was based on
}
```

### Phase 5: Tests

**5a. Unit test for `createFeature()` default-branch sync**

**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts` (new)

Test cases:
- New branch creation calls `checkout(defaultBranch)` → `reset(['--hard', ...])` → `checkoutLocalBranch(branchName)` in order
- Epic branch creation calls `reset(['--hard', ...])` instead of `pull()`
- Resume path still works (existing directory, existing branch)
- `getDefaultBranch()` fallback to `'develop'` when symbolic-ref fails

Mock `simple-git` and filesystem operations using `vi.mock()`.

**5b. Unit test for `RepoCheckout`**

**File**: `packages/orchestrator/src/worker/__tests__/repo-checkout.test.ts` (new)

Test cases:
- `ensureCheckout()` with existing directory calls `updateRepo()` (fetch + reset)
- `ensureCheckout()` with non-existing directory calls `cloneRepo()`
- `switchBranch()` fetches and resets to remote HEAD
- `getDefaultBranch()` returns API result or falls back to `'develop'`

Mock `execFile` and `fs` operations.

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Use `reset --hard` instead of `pull` | Worker checkouts are isolated; no local changes to preserve. `reset --hard` cannot produce merge conflicts, unlike `pull` (which does a merge). |
| Add `getDefaultBranch()` helper in `feature.ts` | `feature.ts` is a library called by Claude CLI, not the orchestrator. It doesn't have access to `RepoCheckout.getDefaultBranch()`. Using `git symbolic-ref` is self-contained. |
| No changes to `repo-checkout.ts` | After code review, the existing `ensureCheckout()` already always runs `updateRepo()` when the directory exists. The spec's concern was theoretical. |
| `base_commit` in output (not logger) | `feature.ts` has no injected logger. Returning the SHA in the output allows the calling operation to log it. |
| Fallback default branch = `'develop'` | Matches existing convention in `repo-checkout.ts` line 84 and project configuration. |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| `git symbolic-ref` not available (shallow clone, detached HEAD) | Fallback to `'develop'` in the catch block |
| `git.reset(['--hard', ...])` fails if remote branch doesn't exist | The fetch at line 370 already prunes and updates refs; if origin/<branch> doesn't exist, it would have been caught earlier in the remote-branch detection logic |
| Breaking existing resume flows | Resume path (feature directory exists) returns early at line 353 — the new code only affects the new-branch creation path (line 412) |
| Epic branch `reset --hard` discards local epic changes | Workers operate on isolated checkouts with no local work; this is explicitly in the spec's assumptions |

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` | Modified | Add default-branch sync before `checkoutLocalBranch()`; replace epic `pull` with `reset --hard`; add `getDefaultBranch()` helper; return `base_commit` |
| `packages/workflow-engine/src/actions/builtin/speckit/types.ts` | Modified | Add `base_commit?: string` to `CreateFeatureOutput` |
| `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts` | New | Unit tests for branch sync behavior |
| `packages/orchestrator/src/worker/__tests__/repo-checkout.test.ts` | New | Unit tests for RepoCheckout (regression guard) |

## Out of Scope (per spec)

- Retry logic for transient `git fetch` failures
- Rebasing feature branches mid-workflow
- Changes to PR creation/push logic
- Shallow clone optimization
