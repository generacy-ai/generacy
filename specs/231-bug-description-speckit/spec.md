# Bug Fix: Workflow engine does not validate feature branch after setup phase

**Branch**: `231-bug-description-speckit` | **Date**: 2026-02-23 | **Status**: Draft

## Summary

The speckit-feature workflow can push spec and implementation commits directly to the default branch (`develop`) instead of a feature branch. This occurs when the `createFeature` resume path silently fails to check out a feature branch but still returns `success: true`. The workflow executor has no branch validation, and every commit/push step uses `continueOnError: true`, so the workflow proceeds to push ~20+ commits directly to the default branch — bypassing code review entirely.

This is a **critical severity** bug. The fix requires three coordinated changes: fixing the silent failure in `createFeature`, adding a branch validation guard in the workflow executor, and hardening the workflow YAML to fail-fast on branch-related errors.

## Bug Analysis

### Observed Behavior (tetrad-development#8)

1. Agent-3 picked up `generacy-ai/tetrad-development#8` ("Restructure dev containers and docker-compose files")
2. The `create-feature` step returned `success: true` with `git_branch_created: false` — the feature directory existed but the branch did not
3. All subsequent phases (specification, clarification, planning, task-generation, implementation) committed and pushed to `develop`
4. PR creation failed: `head branch "develop" is the same as base branch "develop"`
5. The workflow continued past the PR failure and pushed ~20 implementation tasks of changes directly to `develop`

### Root Cause Chain

| # | Cause | Location | Severity |
|---|-------|----------|----------|
| 1 | **Missing else case in resume path** — when feature directory exists but branch does not exist locally or on remote, `createFeature` silently stays on the current branch and returns `success: true` | `feature.ts:354` | Root cause |
| 2 | **`git.fetch` errors silently swallowed** — stale remote refs cause incorrect `remoteBranchExists` checks | `feature.ts:334, 386` | Contributing |
| 3 | **No branch validation in executor** — the workflow executor never verifies the working branch matches the expected feature branch | `executor/index.ts` | Amplifier |
| 4 | **All commit/push steps use `continueOnError: true`** — even the PR creation failure (which signals the branch problem) doesn't stop the workflow | `speckit-feature.yaml` | Amplifier |
| 5 | **Push commands use `HEAD` not branch name** — `git push --force-with-lease -u origin HEAD` pushes whatever branch is checked out | `speckit-feature.yaml:83` | Amplifier |

## User Stories

### US1: Branch Safety in Feature Workflows

**As a** workflow operator,
**I want** the workflow engine to guarantee that commits only go to the intended feature branch,
**So that** the default branch is never polluted with unreviewed spec/implementation commits.

**Acceptance Criteria**:
- [ ] When `createFeature` cannot check out or create the feature branch, it returns `success: false` with a descriptive error
- [ ] The workflow executor validates the current branch after the setup phase completes
- [ ] If the current branch is the default branch after setup, the workflow aborts immediately with a clear error
- [ ] No commits or pushes occur on the default branch as a result of a workflow execution

### US2: Reliable Feature Branch Creation on Resume

**As a** workflow operator,
**I want** the `createFeature` action to reliably create or check out the feature branch even when resuming a previously started feature,
**So that** resumed/requeued workflows operate on the correct branch.

**Acceptance Criteria**:
- [ ] When the feature directory exists but neither local nor remote branch exists, `createFeature` creates the branch from the default branch HEAD (matching new-creation behavior)
- [ ] When `git.fetch` fails, the error is logged as a warning and the function still attempts to create the branch rather than relying on stale remote refs
- [ ] The `git_branch_created` output field accurately reflects whether the branch was created or checked out
- [ ] After `createFeature` returns `success: true`, the working directory is always on the feature branch

### US3: Fail-Fast on Branch-Critical Errors

**As a** workflow operator,
**I want** branch-related failures (PR creation, push to wrong branch) to immediately halt the workflow,
**So that** a single failure doesn't cascade into dozens of commits on the wrong branch.

**Acceptance Criteria**:
- [ ] The `create-pr` step failure halts the workflow (not masked by `continueOnError`)
- [ ] A new `validate-branch` step is added before the first commit step to verify the branch
- [ ] If `validate-branch` fails, no subsequent commit/push steps execute

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Fix `createFeature` resume path: when feature directory exists but branch does not exist locally or on remote, create the branch from default branch HEAD | P0 | `feature.ts` ~line 354, add else clause |
| FR-002 | `createFeature` must verify the current branch matches `branchName` before returning `success: true` | P0 | Add post-checkout verification in both resume and new-creation paths |
| FR-003 | Add branch validation guard in `executor/index.ts` after setup phase completes | P0 | Check `git rev-parse --abbrev-ref HEAD` against default branch |
| FR-004 | If branch validation fails, abort workflow with status `failed` and a descriptive error message | P0 | Must prevent any subsequent step execution |
| FR-005 | Log `git.fetch` failures as warnings instead of silently swallowing them | P1 | `feature.ts` lines 334 and 386 |
| FR-006 | Add `validate-branch` step to `speckit-feature.yaml` before first commit step | P1 | Shell step: verify current branch matches expected feature branch |
| FR-007 | Remove `continueOnError: true` from `create-pr` step in workflow YAMLs | P1 | PR failure is a strong signal of branch problems |
| FR-008 | Push commands should use the explicit branch name instead of `HEAD` | P2 | `git push --force-with-lease -u origin $BRANCH_NAME` |
| FR-009 | Add unit tests for the resume-path edge case (directory exists, branch does not) | P0 | `feature.test.ts` |
| FR-010 | Add unit tests for branch validation in the executor | P0 | New test file or extend existing executor tests |
| FR-011 | Apply the same fixes to `speckit-bugfix.yaml` which has the identical pattern | P1 | Same `continueOnError` and `HEAD` push pattern |

## Technical Design

### Part A: Fix `createFeature` Resume Path

**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`

In the resume path (~line 354), add an else clause when neither local nor remote branch exists:

```typescript
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

Add post-checkout verification before returning `success: true`:

```typescript
// Verify we're on the correct branch before returning success
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

Update `git.fetch` catch blocks to log warnings:

```typescript
try {
  await git.fetch(['--all', '--prune']);
} catch (err) {
  logger.warn(`git fetch failed, continuing with possibly stale refs: ${err}`);
}
```

### Part B: Branch Validation Guard in Executor

**File**: `packages/workflow-engine/src/executor/index.ts`

After each phase completes in the `execute()` method (~line 196), add branch validation for the setup phase:

```typescript
const phaseResult = await this.executePhase(
  workflow, phase, i, workflow.phases.length, options,
  i === startPhaseIndex ? options.startStep : undefined
);

// After setup phase, validate we're on a feature branch
if (phase.name === 'setup' && options.cwd) {
  await this.validateBranchState(options.cwd);
}
```

Implement as a private method on the executor class:

```typescript
private async validateBranchState(cwd: string): Promise<void> {
  const git = simpleGit(cwd);
  const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  const defaultBranch = await getDefaultBranch(git); // reuse existing helper

  if (currentBranch === defaultBranch) {
    throw new Error(
      `Branch validation failed: still on default branch "${currentBranch}" after setup phase. ` +
      `The create-feature step likely failed to create/checkout the feature branch.`
    );
  }
}
```

### Part C: Harden Workflow YAML

**Files**: `.generacy/speckit-feature.yaml`, `.generacy/speckit-bugfix.yaml`

1. Add a `validate-branch` step after `create-feature`:

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
```

2. Remove `continueOnError: true` from `create-pr` step
3. Replace `origin HEAD` with explicit branch reference in push commands

## Files to Modify

| File | Change | Priority |
|------|--------|----------|
| `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` | Fix resume path, add branch verification, log fetch errors | P0 |
| `packages/workflow-engine/src/executor/index.ts` | Add post-setup branch validation guard | P0 |
| `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts` | Add tests for resume-path edge case and branch verification | P0 |
| `.generacy/speckit-feature.yaml` | Add validate-branch step, fix continueOnError on create-pr, use explicit branch in push | P1 |
| `.generacy/speckit-bugfix.yaml` | Same YAML changes as speckit-feature | P1 |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Resume path with missing branch | Creates branch and returns success | Unit test: directory exists, no local/remote branch |
| SC-002 | Resume path with missing branch returns correct `git_branch_created` | `true` when branch is newly created | Unit test assertion |
| SC-003 | Post-checkout branch verification | Returns `success: false` if checkout failed | Unit test: mock checkout failure |
| SC-004 | Executor branch validation | Aborts workflow when on default branch after setup | Unit test / integration test |
| SC-005 | Workflow YAML validate-branch step | Blocks subsequent steps when branch is wrong | Manual test with modified workflow |
| SC-006 | No regression in happy path | Existing feature creation and resume tests pass | All existing tests pass |
| SC-007 | `create-pr` failure stops workflow | Workflow status is `failed` when PR creation fails | Integration test |

## Assumptions

- The `getDefaultBranch` helper in `feature.ts` correctly resolves the default branch name (it already exists and is used in the new-creation path)
- `simple-git` is available in the executor context (it's already a dependency of the workflow-engine package)
- The `setup` phase name is stable and consistently used across workflow definitions
- Workflow YAMLs in `.generacy/` are the actively used versions (v1.3.0), not the older ones in `workflows/`

## Out of Scope

- Retroactive cleanup of commits already pushed to `develop` from tetrad-development#8
- Changes to the orchestrator or job handler (the fix is entirely within the workflow-engine package and workflow YAMLs)
- Adding branch validation to other workflow types beyond speckit-feature and speckit-bugfix
- Refactoring the `continueOnError` pattern across all steps (only the branch-critical steps are changed)
- Adding branch protection rules at the GitHub/Git level (complementary but separate concern)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Branch validation blocks legitimate workflows where setup intentionally stays on default branch | Low | Medium | Only validate when setup phase contains a `create-feature` or `create-bugfix` step |
| `getDefaultBranch` returns wrong value in edge cases | Low | High | Add fallback to common defaults (`main`, `develop`); already handled by existing helper |
| Changing `continueOnError` on `create-pr` causes workflows to fail on transient GitHub API errors | Medium | Medium | Add retry logic to `create-pr` step, or only fail on "same branch" errors specifically |

---

*Generated by speckit*
