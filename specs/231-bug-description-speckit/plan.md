# Implementation Plan: Branch Safety in Workflow Engine

**Branch**: `231-bug-description-speckit` | **Date**: 2026-02-23

## Summary

This plan addresses a critical bug where the speckit-feature workflow can push commits directly to the default branch (`develop`) instead of a feature branch. The fix requires three coordinated changes:

1. **Part A** — Fix the `createFeature` resume path in `feature.ts` to handle the case where the feature directory exists but neither local nor remote branch exists
2. **Part B** — Add a branch validation guard in the workflow executor after the setup phase
3. **Part C** — Harden the workflow YAML files to fail-fast on branch-related errors

## Technical Context

- **Language**: TypeScript (ES modules with `.js` extension imports)
- **Framework**: Custom workflow engine (`packages/workflow-engine`)
- **Git Library**: `simple-git` (already a dependency)
- **Test Framework**: Vitest with hoisted mocks
- **Key Patterns**: `vi.hoisted()` for mock factories, call-log tracking for git operation ordering

## Architecture Overview

The fix spans three layers:

```
┌──────────────────────────────────────────────────┐
│  Workflow YAML (.generacy/speckit-*.yaml)         │  Layer 3: Fail-fast guards
│  - validate-branch step                           │
│  - Remove continueOnError from create-pr          │
│  - Explicit branch name in push commands          │
├──────────────────────────────────────────────────┤
│  Executor (executor/index.ts)                     │  Layer 2: Branch validation
│  - Post-setup branch validation                   │
│  - Abort workflow if on default branch            │
├──────────────────────────────────────────────────┤
│  Feature Library (speckit/lib/feature.ts)         │  Layer 1: Root cause fix
│  - Fix resume-path missing else clause            │
│  - Add post-checkout branch verification          │
│  - Log git.fetch warnings                         │
└──────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Fix `createFeature` Resume Path (P0)

**Files**:
- `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/types.ts`

**Step 1.1: Add `error` field to `CreateFeatureOutput`**

The type at `types.ts:148-159` currently has no `error` field. Add an optional `error?: string` field so the function can return descriptive error messages on failure.

```typescript
// types.ts — add to CreateFeatureOutput
export interface CreateFeatureOutput {
  success: boolean;
  branch_name: string;
  feature_num: string;
  spec_file: string;
  feature_dir: string;
  git_branch_created: boolean;
  branched_from_epic?: boolean;
  parent_epic_branch?: string;
  base_commit?: string;
  error?: string;           // NEW
}
```

**Step 1.2: Fix the missing else clause in the resume path**

At `feature.ts:346-357`, when the feature directory exists but neither local nor remote branch exists, the code currently falls through silently. Add an else clause that creates the branch from the default branch HEAD (matching the new-creation behavior at lines 427-434):

```typescript
// feature.ts ~line 354 — after the remoteBranchExists check
if (remoteBranchExists) {
  await git.checkout(['-b', branchName, `origin/${branchName}`]);
} else {
  // Branch doesn't exist anywhere — create it from default branch HEAD
  const defaultBranch = await getDefaultBranch(git);
  await git.checkout(defaultBranch);
  await git.reset(['--hard', `origin/${defaultBranch}`]);
  await git.checkoutLocalBranch(branchName);
  gitBranchCreated = true;
}
```

Note: A `let gitBranchCreated = false;` variable must be introduced in the resume path scope (it currently only exists in the new-creation path at line 375).

**Step 1.3: Add post-checkout branch verification**

Before the resume path returns `success: true` (line 360-367), verify the current branch matches the expected branch name:

```typescript
// After all git operations, before return
const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
if (currentBranch !== branchName) {
  return {
    success: false,
    branch_name: branchName,
    feature_num: featureNum,
    spec_file: '',
    feature_dir: featureDir,
    git_branch_created: false,
    error: `Branch checkout failed: expected "${branchName}" but on "${currentBranch}"`,
  };
}
```

Also add the same verification to the new-creation path, after line 445 and before the final return at line 453.

**Step 1.4: Log `git.fetch` failures as warnings**

At lines 333-337 and 385-389, replace silent catch blocks with warning logs. Since `feature.ts` doesn't currently have a logger, use `console.warn` (consistent with the module being a pure library without DI logger):

```typescript
try {
  await git.fetch(['--all', '--prune']);
} catch (err) {
  console.warn(`[createFeature] git fetch failed, continuing with possibly stale refs: ${err}`);
}
```

Apply at both locations (resume path line 334 and new-creation path line 386).

---

### Phase 2: Branch Validation Guard in Executor (P0)

**Files**:
- `packages/workflow-engine/src/executor/index.ts`

**Step 2.1: Add `validateBranchState` private method**

Add a new private method to `WorkflowExecutor` that checks whether the current branch is the default branch. Import `simpleGit` and `getDefaultBranch` at the top of the file.

```typescript
import { simpleGit } from 'simple-git';
import { getDefaultBranch } from '../actions/builtin/speckit/lib/feature.js';
```

```typescript
/**
 * Validate that the working directory is not on the default branch.
 * Called after the setup phase to catch failed branch creation early.
 */
private async validateBranchState(cwd: string): Promise<void> {
  const git = simpleGit(cwd);
  const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  const defaultBranch = await getDefaultBranch(git);

  if (currentBranch === defaultBranch) {
    throw new Error(
      `Branch validation failed: still on default branch "${currentBranch}" after setup phase. ` +
      `The create-feature step likely failed to create/checkout the feature branch.`
    );
  }
}
```

**Step 2.2: Call validation after setup phase**

In the `execute()` method at `executor/index.ts:199-200`, after `phaseResult` is pushed, add branch validation when the setup phase completes successfully:

```typescript
this.currentExecution.phaseResults.push(phaseResult);

// After setup phase, validate we're on a feature branch (not default)
if (phase.name === 'setup' && phaseResult.status === 'completed' && options.cwd) {
  await this.validateBranchState(options.cwd);
}
```

This throws an Error which is caught by the existing try-catch at line 214, setting `status: 'failed'` and emitting an error event.

**Design decision**: Only validate when setup phase completes successfully (`phaseResult.status === 'completed'`). If setup already failed, the phase failure handling at line 203-206 will stop execution.

**Design decision**: The `phase.name === 'setup'` check is intentionally simple. Per the spec's assumptions, the setup phase name is stable across workflow definitions. This avoids over-engineering a step-introspection approach.

---

### Phase 3: Harden Workflow YAML (P1)

**Files**:
- `.generacy/speckit-feature.yaml`
- `.generacy/speckit-bugfix.yaml`

**Step 3.1: Add `validate-branch` step after `create-feature`**

In both YAML files, add a new step to the setup phase that verifies the current branch matches the expected feature branch:

```yaml
- name: validate-branch
  uses: shell
  command: |
    CURRENT=$(git rev-parse --abbrev-ref HEAD)
    EXPECTED="${{ steps.create-feature.output.branch_name }}"
    if [ "$CURRENT" != "$EXPECTED" ]; then
      echo "ERROR: Expected branch '$EXPECTED' but on '$CURRENT'"
      exit 1
    fi
    echo "Branch validated: $CURRENT"
```

No `continueOnError` — failure here stops the workflow.

**Step 3.2: Remove `continueOnError: true` from `create-pr` steps**

- `speckit-feature.yaml:99` — remove `continueOnError: true` from `create-pr`
- `speckit-bugfix.yaml:91` — remove `continueOnError: true` from `create-pr`

PR creation failure is a strong signal of branch problems. If the PR can't be created, subsequent phases should not continue pushing to the wrong branch.

**Step 3.3: Use explicit branch name in push commands**

Replace `origin HEAD` with the explicit branch name from the `create-feature` step output:

```yaml
# Before (speckit-feature.yaml:83):
command: git push --force-with-lease -u origin HEAD

# After:
command: git push --force-with-lease -u origin ${{ steps.create-feature.output.branch_name }}
```

Apply to `push-spec` in both YAML files. The other push steps (`push-clarifications`, `push-plan`, `push-tasks`, `push-implementation`) use plain `git push` which pushes the current tracking branch — these are safer after the first push sets up tracking, but should also be updated for consistency:

```yaml
command: git push origin ${{ steps.create-feature.output.branch_name }}
```

---

### Phase 4: Unit Tests (P0)

**Files**:
- `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts`

**Step 4.1: Add test for resume path with missing branch everywhere**

Add a new test case in the `resume path` describe block that verifies: when the feature directory exists but neither local nor remote branch exists, `createFeature` creates the branch from the default branch HEAD.

```typescript
it('creates branch from default when dir exists but no local or remote branch', async () => {
  existsFor({
    '.git': true,
    'autodev.json': false,
    '042-test-feature': true,
    'spec.md': false,
  });

  // No local branches contain the feature branch
  (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
    all: [],
    current: 'develop',
  });

  // No remote branches contain the feature branch
  (git().branch as ReturnType<typeof vi.fn>).mockResolvedValue({
    all: [],
  });

  const result = await createFeature({
    description: 'test feature',
    number: 42,
    cwd: '/repo',
  });

  expect(result.success).toBe(true);
  expect(result.git_branch_created).toBe(true);

  // Should have synced to default branch and created the feature branch
  expect(git().checkout).toHaveBeenCalledWith('develop');
  expect(git().reset).toHaveBeenCalledWith(['--hard', 'origin/develop']);
  expect(git().checkoutLocalBranch).toHaveBeenCalledWith('042-test-feature');
});
```

**Step 4.2: Add test for post-checkout branch verification failure**

```typescript
it('returns success: false when checkout fails silently (branch mismatch)', async () => {
  existsFor({
    '.git': true,
    'autodev.json': false,
    '042-test-feature': true,
    'spec.md': false,
  });

  (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
    all: ['042-test-feature'],
    current: 'develop',
  });

  // Simulate checkout not actually switching branches
  (git().revparse as ReturnType<typeof vi.fn>).mockResolvedValue('develop');

  const result = await createFeature({
    description: 'test feature',
    number: 42,
    cwd: '/repo',
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain('Branch checkout failed');
});
```

**Step 4.3: Add test for `git_branch_created` accuracy in resume path**

```typescript
it('sets git_branch_created to true when branch is newly created in resume path', async () => {
  existsFor({
    '.git': true,
    'autodev.json': false,
    '042-test-feature': true,
    'spec.md': false,
  });

  (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
    all: [],
    current: 'develop',
  });
  (git().branch as ReturnType<typeof vi.fn>).mockResolvedValue({
    all: [],
  });
  // After branch creation, revparse returns the new branch name
  (git().revparse as ReturnType<typeof vi.fn>).mockResolvedValue('042-test-feature');

  const result = await createFeature({
    description: 'test feature',
    number: 42,
    cwd: '/repo',
  });

  expect(result.success).toBe(true);
  expect(result.git_branch_created).toBe(true);
});
```

**Step 4.4: Add test for git.fetch warning logging**

```typescript
it('logs a warning when git fetch fails in resume path', async () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  existsFor({
    '.git': true,
    'autodev.json': false,
    '042-test-feature': true,
    'spec.md': true,
  });

  (git().branchLocal as ReturnType<typeof vi.fn>).mockResolvedValue({
    all: ['042-test-feature'],
    current: 'develop',
  });
  (git().fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));
  (git().revparse as ReturnType<typeof vi.fn>).mockResolvedValue('042-test-feature');

  const result = await createFeature({
    description: 'test feature',
    number: 42,
    cwd: '/repo',
  });

  expect(result.success).toBe(true);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining('git fetch failed')
  );

  warnSpy.mockRestore();
});
```

**Step 4.5: Add executor branch validation tests**

Create a new test file: `packages/workflow-engine/src/executor/__tests__/branch-validation.test.ts`

Tests to include:
- Executor aborts workflow when still on default branch after setup phase
- Executor continues normally when on a feature branch after setup
- Executor skips validation when `cwd` is not provided
- Executor skips validation when setup phase failed

These tests will mock `simpleGit` and `getDefaultBranch` at the module level, similar to the pattern in `feature.test.ts`.

---

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Use `console.warn` for fetch failures instead of injecting a logger | `feature.ts` is a pure library with no DI logger parameter. Adding one would change the function signature and break callers. `console.warn` is pragmatic and can be upgraded later. |
| Validate branch by phase name (`setup`) not by step inspection | Simpler, less brittle. The setup phase name is a stable convention across all workflow YAMLs. |
| Add `error` field to `CreateFeatureOutput` type | Enables descriptive error messages without breaking the existing boolean `success` pattern. Optional field ensures backward compatibility. |
| Verify branch after checkout via `revparse` | `git.revparse(['--abbrev-ref', 'HEAD'])` is the most reliable way to check the current branch. It works even with detached HEAD (returns `HEAD`). |
| Remove `continueOnError` only from `create-pr`, not from commit/push steps | Commit/push steps legitimately need `continueOnError` for cases like "nothing to commit" or "already up to date". PR creation failure is the unique signal of a branch problem. |
| Apply same fixes to both `speckit-feature.yaml` and `speckit-bugfix.yaml` | Both have identical patterns and the same vulnerability (per FR-011). |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Branch validation blocks workflows without a setup phase | Only validate when `phase.name === 'setup'` — no-op for workflows without a setup phase |
| `getDefaultBranch` returns wrong value | Already has a fallback to `'develop'`; proven by existing tests in `feature.test.ts:362-407` |
| Removing `continueOnError` from `create-pr` causes failures on transient GitHub API errors | The `pr.create` action handler likely has its own retry logic. If not, a follow-up can add a `retry` config to that step. This is acceptable risk — a PR failure should be investigated, not silently ignored. |
| Post-checkout verification adds latency | `git rev-parse --abbrev-ref HEAD` is a local operation taking <10ms. Negligible. |
| Existing tests break | All changes are additive (new else clause, new verification, new tests). The only removal is `continueOnError` from `create-pr` in YAML, which doesn't affect unit tests. |

## Files to Modify (Ordered by Priority)

| # | File | Change | Priority |
|---|------|--------|----------|
| 1 | `packages/workflow-engine/src/actions/builtin/speckit/types.ts` | Add `error?: string` to `CreateFeatureOutput` | P0 |
| 2 | `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` | Fix resume path, add branch verification, log fetch warnings | P0 |
| 3 | `packages/workflow-engine/src/executor/index.ts` | Add `validateBranchState` method + call after setup phase | P0 |
| 4 | `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts` | Add resume-path edge case tests, verification tests, fetch warning test | P0 |
| 5 | `packages/workflow-engine/src/executor/__tests__/branch-validation.test.ts` | New file: executor branch validation tests | P0 |
| 6 | `.generacy/speckit-feature.yaml` | Add validate-branch step, fix create-pr, explicit branch push | P1 |
| 7 | `.generacy/speckit-bugfix.yaml` | Same YAML changes as speckit-feature | P1 |

## Verification Plan

1. **Run existing tests**: `pnpm -C packages/workflow-engine test` — all existing tests must pass
2. **Run new tests**: Verify all new test cases pass
3. **Manual smoke test**: Run `speckit-feature` workflow in dry-run mode to confirm YAML changes parse correctly
4. **Edge case verification**: The resume-path test (dir exists, no branch) specifically covers the root cause scenario from tetrad-development#8
