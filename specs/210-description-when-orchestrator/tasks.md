# Tasks: Worker must pull latest develop before creating feature branch

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Core bug fix — Sync default branch before creating feature branch

### T001 [DONE] [US1] Add `getDefaultBranch()` helper to `feature.ts`
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
- Add an `async function getDefaultBranch(git: SimpleGit): Promise<string>` helper
- Use `git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])` to resolve the remote's default branch
- Parse the output (e.g. `refs/remotes/origin/develop` → `develop`)
- Catch errors and fall back to `'develop'`

### T002 [DONE] [US1] Sync to latest default branch before `checkoutLocalBranch()` for new branches
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
**Depends on**: T001
- In the `else` block at line 412-413 (new branch creation, no epic parent, no remote branch)
- Before `git.checkoutLocalBranch(branchName)`, add:
  - `const defaultBranch = await getDefaultBranch(git)`
  - `await git.checkout(defaultBranch)`
  - `await git.reset(['--hard', \`origin/${defaultBranch}\`])`
- Then call `await git.checkoutLocalBranch(branchName)` to fork from the freshly-synced HEAD
- This ensures FR-002: new feature branches are always based on the tip of `origin/develop`

---

## Phase 2: Epic branch fix — Replace `pull` with `fetch` + `reset --hard`

### T003 [DONE] [US1] Replace `git.pull()` with `git.reset(['--hard', ...])` for epic parent branches
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
- At lines 402-406, replace the `try { await git.pull(...) } catch {}` block with:
  - `await git.reset(['--hard', \`origin/${input.parent_epic_branch}\`])`
- Remove the try/catch wrapper — `reset --hard` cannot produce merge conflicts on isolated worker checkouts
- This ensures FR-003: epic parent branches are always synced to their remote tip before branching

---

## Phase 3: Diagnostics — Log base commit SHA

### T004 [DONE] [P] [US1] Add `base_commit` field to `CreateFeatureOutput` type
**File**: `packages/workflow-engine/src/actions/builtin/speckit/types.ts`
- Add `base_commit?: string` to the `CreateFeatureOutput` interface (after `parent_epic_branch`)
- Add JSDoc comment: `/** SHA of the commit the feature branch was based on */`

### T005 [DONE] [US1] Capture and return base commit SHA in `createFeature()`
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts`
**Depends on**: T002, T004
- After the default branch reset (T002) and before `checkoutLocalBranch()`, capture: `const baseSha = await git.revparse(['HEAD'])`
- Also capture the base SHA in the epic branch path (after T003's reset)
- Include `base_commit: baseSha` in the return object for new branch creation paths
- For the `else` fallback (line 409-410, epic branch not found), also capture and return the SHA

---

## Phase 4: Verification — Confirm `repo-checkout.ts` is already correct

### T006 [DONE] [P] [US1] [US2] Verify `ensureCheckout()` always syncs when directory exists
**File**: `packages/orchestrator/src/worker/repo-checkout.ts`
- **Read-only verification — no code changes expected**
- Confirm line 58-59: when directory exists, `updateRepo()` is always called (fetch + reset --hard)
- Confirm `cloneRepo()` uses `--branch` flag which clones latest from remote
- Confirm `switchBranch()` (line 91-110) does fetch + checkout + reset --hard — correct for FR-005
- Document findings in this task (pass/fail for FR-001, FR-004, FR-005)

---

## Phase 5: Testing

### T007 [DONE] [US1] Write unit tests for `createFeature()` branch sync behavior
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts` (new)
**Depends on**: T002, T003, T004, T005
- Mock `simple-git` using `vi.mock('simple-git')` — return a mock `SimpleGit` instance with chainable methods
- Mock `./fs.js` to control `exists()`, `mkdir()`, `writeFile()`, `readFile()`, `readDir()`, `findRepoRoot()`, `resolveSpecsPath()`
- **Test: new branch syncs to latest default branch**
  - Call `createFeature({ description: 'test feature', number: 42 })`
  - Assert `git.checkout('develop')` was called before `git.checkoutLocalBranch()`
  - Assert `git.reset(['--hard', 'origin/develop'])` was called before `git.checkoutLocalBranch()`
  - Assert call order: `fetch` → `checkout(default)` → `reset` → `checkoutLocalBranch`
- **Test: epic branch uses reset --hard instead of pull**
  - Call `createFeature({ description: 'test', number: 42, parent_epic_branch: 'epic-123' })`
  - Assert `git.reset(['--hard', 'origin/epic-123'])` was called
  - Assert `git.pull()` was **not** called
- **Test: `getDefaultBranch()` resolves from symbolic-ref**
  - Mock `git.raw(['symbolic-ref', ...])` to return `'refs/remotes/origin/main'`
  - Assert result is `'main'`
- **Test: `getDefaultBranch()` falls back to 'develop' on error**
  - Mock `git.raw()` to throw
  - Assert result is `'develop'`
- **Test: resume path (feature dir exists) returns early without syncing default branch**
  - Mock `exists(featureDir)` to return `true`
  - Assert `git.reset(['--hard', 'origin/develop'])` was **not** called on the default branch
- **Test: base_commit SHA is returned in output**
  - Mock `git.revparse(['HEAD'])` to return a known SHA
  - Assert `result.base_commit` matches the mocked SHA

### T008 [DONE] [P] [US2] Write unit tests for `RepoCheckout` regression guard
**File**: `packages/orchestrator/src/worker/__tests__/repo-checkout.test.ts` (new)
**Depends on**: T006
- Mock `node:child_process` `execFile` using `vi.mock()`
- Mock `node:fs/promises` `stat`, `mkdir`, `rm`
- Create a mock logger with `info`, `warn`, `debug`, `error`, `child` methods
- **Test: `ensureCheckout()` with existing directory calls `updateRepo()`**
  - Mock `stat()` to succeed (directory exists)
  - Assert `execFile('git', ['fetch', 'origin'], ...)` was called
  - Assert `execFile('git', ['reset', '--hard', 'origin/develop'], ...)` was called
- **Test: `ensureCheckout()` with non-existing directory calls `cloneRepo()`**
  - Mock `stat()` to throw ENOENT
  - Assert `execFile('git', ['clone', '--branch', 'develop', ...], ...)` was called
- **Test: `switchBranch()` fetches and resets to remote HEAD**
  - Assert `execFile('git', ['fetch', 'origin'], ...)` was called
  - Assert `execFile('git', ['reset', '--hard', 'origin/my-branch'], ...)` was called
- **Test: `getDefaultBranch()` returns API result**
  - Mock `execFile('gh', ['repo', 'view', ...])` to return `{ stdout: 'main\n' }`
  - Assert result is `'main'`
- **Test: `getDefaultBranch()` falls back to 'develop' on failure**
  - Mock `execFile('gh', ...)` to throw
  - Assert result is `'develop'`

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 3 (T005 depends on T002)
- Phase 2 can run in parallel with Phase 1 (different code paths in same file, but logically independent)
- Phase 4 is read-only verification and can run in parallel with Phases 1-3
- Phase 5 depends on all implementation phases (1-4) being complete

**Parallel opportunities within phases**:
- T004 [P] and T006 [P] can run in parallel with any other task (different files, no code dependencies)
- T007 and T008 [P] can run in parallel with each other (different test files, different packages)

**Critical path**:
T001 → T002 → T005 → T007 (feature.ts sync fix → diagnostics → tests)

**Secondary path (parallel)**:
T003 (epic fix, can start after T001 or independently)
T004 (types change, independent)
T006 → T008 (repo-checkout verification → regression tests)
