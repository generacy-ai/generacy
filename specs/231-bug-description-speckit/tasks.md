# Tasks: Branch Safety in Workflow Engine

**Input**: `spec.md`, `plan.md`
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1/US2/US3)

---

## Phase 1: Type & Library Fixes (Root Cause)

### T001 [DONE] [US2] Add `error` field to `CreateFeatureOutput` type
**File**: `packages/workflow-engine/src/actions/builtin/speckit/types.ts`
- Add optional `error?: string` field to `CreateFeatureOutput` interface (after `base_commit` at line ~158)
- This enables descriptive error messages on branch checkout failures without breaking existing callers

### T002 [DONE] [US2] Fix `createFeature` resume path — missing else clause
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
- Depends on T001 (uses the new `error` field)
- At line ~347, after the `if (remoteBranchExists)` block, add an `else` clause for the case where neither local nor remote branch exists
- The else clause should: checkout default branch, `reset --hard` to `origin/<default>`, create new local branch via `checkoutLocalBranch(branchName)`
- Introduce `let gitBranchCreated = false;` at the start of the resume path scope (around line ~329) so it can be set to `true` in the new else clause
- Update the resume return statement (line ~366) to use `gitBranchCreated` instead of hardcoded `false`

### T003 [DONE] [US2] Add post-checkout branch verification to `createFeature`
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
- Depends on T001 and T002
- After all git operations in the resume path (before the return at line ~360), add a `revparse(['--abbrev-ref', 'HEAD'])` check
- If the current branch does not match `branchName`, return `{ success: false, error: "Branch checkout failed: ..." }`
- Add the same verification to the new-creation path (before the final return at line ~453)

### T004 [DONE] [P] [US2] Log `git.fetch` failures as warnings
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
- Can run in parallel with T002/T003 (touches different lines)
- Replace the empty catch blocks at lines ~334-337 (resume path) and ~385-389 (new-creation path) with `console.warn` calls
- Format: `[createFeature] git fetch failed, continuing with possibly stale refs: ${err}`

---

## Phase 2: Executor Branch Validation

### T005 [DONE] [US1] Add `validateBranchState` method to `WorkflowExecutor`
**File**: `packages/workflow-engine/src/executor/index.ts`
- Depends on Phase 1 (conceptually, though could be coded in parallel)
- Add imports for `simpleGit` from `simple-git` and `getDefaultBranch` from `../actions/builtin/speckit/lib/feature.js`
- Add a `private async validateBranchState(cwd: string): Promise<void>` method to the `WorkflowExecutor` class
- Method should: instantiate `simpleGit(cwd)`, get current branch via `revparse`, get default branch via `getDefaultBranch`, throw an `Error` if they match

### T006 [DONE] [US1] Call branch validation after setup phase completes
**File**: `packages/workflow-engine/src/executor/index.ts`
- Depends on T005
- After `this.currentExecution.phaseResults.push(phaseResult)` at line ~200, add a conditional block
- Condition: `phase.name === 'setup' && phaseResult.status === 'completed' && options.cwd`
- Call `await this.validateBranchState(options.cwd)` — the thrown error is caught by the existing try-catch at line ~214

---

## Phase 3: Workflow YAML Hardening

### T007 [DONE] [P] [US3] Harden `speckit-feature.yaml`
**File**: `.generacy/speckit-feature.yaml`
- Can run in parallel with T008
- Add a `validate-branch` step after `create-feature` in the setup phase (after line ~63): shell step that compares `git rev-parse --abbrev-ref HEAD` against `${{ steps.create-feature.output.branch_name }}`
- Remove `continueOnError: true` from the `create-pr` step (line ~99)
- Change `push-spec` command (line ~83) from `git push --force-with-lease -u origin HEAD` to `git push --force-with-lease -u origin ${{ steps.create-feature.output.branch_name }}`
- Update other push steps (`push-clarifications`, `push-plan`, `push-tasks`, `push-implementation`) to use explicit branch: `git push origin ${{ steps.create-feature.output.branch_name }}`

### T008 [DONE] [P] [US3] Harden `speckit-bugfix.yaml`
**File**: `.generacy/speckit-bugfix.yaml`
- Can run in parallel with T007
- Apply identical changes as T007:
  - Add `validate-branch` step after `create-feature` in setup phase
  - Remove `continueOnError: true` from `create-pr` step (line ~91)
  - Replace `origin HEAD` in push commands with explicit branch name
  - Update all push steps to use explicit branch reference

---

## Phase 4: Unit Tests

### T009 [DONE] [US2] Add resume-path edge case tests for `createFeature`
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts`
- Depends on Phase 1 (T002, T003, T004)
- Add test: "creates branch from default when dir exists but no local or remote branch" — verify `success: true`, `git_branch_created: true`, and correct git command sequence (checkout default → reset --hard → checkoutLocalBranch)
- Add test: "sets `git_branch_created` to `true` when branch is newly created in resume path" — mock `revparse` to return new branch name, assert `git_branch_created: true`
- Add test: "returns `success: false` when checkout fails silently (branch mismatch)" — mock `revparse` to return wrong branch, assert `success: false` and `error` contains "Branch checkout failed"
- Add test: "logs a warning when git fetch fails in resume path" — spy on `console.warn`, mock `fetch` to reject, assert warning logged with "git fetch failed"
- Follow existing patterns: use `vi.hoisted()` mocks, `existsFor()` helper, `callLog` for git operation ordering

### T010 [DONE] [P] [US1] Add executor branch validation tests
**File**: `packages/workflow-engine/src/executor/__tests__/branch-validation.test.ts` (new file)
- Can run in parallel with T009 (different files)
- Depends on Phase 2 (T005, T006)
- Add test: "aborts workflow when still on default branch after setup phase" — mock `simpleGit` to return default branch, assert workflow status is `failed` and error message contains "Branch validation failed"
- Add test: "continues normally when on a feature branch after setup" — mock `simpleGit` to return feature branch name, assert workflow completes
- Add test: "skips validation when `cwd` is not provided" — run without `cwd` option, assert no `simpleGit` call
- Add test: "skips validation when setup phase failed" — set phase status to `failed`, assert no validation call
- Follow patterns from `executor.test.ts`: use `vi.fn()` mocking, `NoopLogger`, mock action handlers

---

## Phase 5: Verification

### T011 [DONE] Run existing test suite to verify no regressions
**Command**: `pnpm -C packages/workflow-engine test`
- Depends on all previous phases
- All existing tests in `feature.test.ts` and `executor.test.ts` must continue to pass
- All new tests from T009 and T010 must pass
- Fix any failures before marking complete

### T012 [DONE] Verify YAML syntax is valid
**Command**: Validate that `speckit-feature.yaml` and `speckit-bugfix.yaml` parse correctly
- Depends on T007, T008
- Ensure the `validate-branch` step interpolation syntax is correct
- Verify no YAML syntax errors were introduced

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001-T004) must complete before Phase 4 tests (T009)
- Phase 2 (T005-T006) must complete before Phase 4 tests (T010)
- Phase 3 (T007-T008) is independent of Phases 1 & 2
- Phase 5 depends on all previous phases

**Parallel opportunities within phases**:
- T004 can run in parallel with T002/T003 (different lines in same file)
- T007 and T008 can run in parallel (different files)
- T009 and T010 can run in parallel (different files)

**Critical path**:
T001 → T002 → T003 → T005 → T006 → T009/T010 → T011

**Estimated scope**: 5 files modified, 1 file created, ~200 lines added
