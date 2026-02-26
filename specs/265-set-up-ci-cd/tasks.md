# Tasks: Set up CI/CD and npm publishing

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Changesets Initialization

### T001 Create `.changeset/config.json`
**File**: `.changeset/config.json`
- Create the `.changeset/` directory
- Add `config.json` with `baseBranch: "develop"`, `access: "public"`
- Set `changelog: "@changesets/cli/changelog"`
- Set `commit: false` (changesets/action handles commits)
- Set `updateInternalDependencies: "patch"` for cascade versioning
- Add `"ignore": ["generacy-extension"]` to exclude VS Code extension from npm publishing
- Include `$schema` for editor validation

### T002 Add `packageManager` field to root `package.json`
**File**: `package.json` (root)
- Add `"packageManager": "pnpm@9.15.9"` to root package.json
- This enables auto-detection by `pnpm/action-setup@v4` and Corepack
- Do NOT modify any existing fields (scripts, dependencies, etc.)

### T003 Add `@changesets/cli` to root devDependencies
**File**: `package.json` (root)
- Add `@changesets/cli` to root `devDependencies`
- Do NOT modify any other dependencies or scripts per spec requirements
- Note: T002 and T003 both modify root package.json — apply sequentially

### T004 Update lockfile
**File**: `pnpm-lock.yaml`
- Run `pnpm install` to update the lockfile with the new `@changesets/cli` dependency
- Verify lockfile is valid with `pnpm install --frozen-lockfile` (should pass)
- **Depends on**: T003

---

## Phase 2: Package Configuration

### T005 [P] Add `publishConfig` to `@generacy-ai/generacy`
**File**: `packages/generacy/package.json`
- Add `"publishConfig": { "access": "public" }` to package.json
- Package currently lacks this field

### T006 [P] Add `publishConfig` to `@generacy-ai/orchestrator`
**File**: `packages/orchestrator/package.json`
- Add `"publishConfig": { "access": "public" }` to package.json
- Package currently lacks this field

### T007 [P] Add `publishConfig` to `@generacy-ai/workflow-engine`
**File**: `packages/workflow-engine/package.json`
- Add `"publishConfig": { "access": "public" }` to package.json
- Package currently lacks this field

### T008 [P] Add `publishConfig` to `@generacy-ai/knowledge-store`
**File**: `packages/knowledge-store/package.json`
- Add `"publishConfig": { "access": "public" }` to package.json
- Package currently lacks this field

### T009 [P] Add `publishConfig` to excluded workspace packages
**Files**:
- `packages/github-actions/package.json`
- `packages/generacy-plugin-cloud-build/package.json`
- `packages/generacy-plugin-copilot/package.json`
- `packages/generacy-plugin-claude-code/package.json`
- `packages/github-issues/package.json`
- `packages/jira/package.json`
- Add `"publishConfig": { "access": "public" }` to each
- These are currently excluded from pnpm workspace (depend on `@generacy-ai/latency`) but still need publishConfig for when they are re-included
- Skip `@generacy-ai/templates` — already has `publishConfig`

---

## Phase 3: CI Workflow

### T010 Create `.github/workflows/ci.yml`
**File**: `.github/workflows/ci.yml`
- Trigger on PRs to `develop`/`main` and pushes to `develop`/`main`
- Set `concurrency` with `cancel-in-progress: true` to abort stale builds
- Set `permissions: contents: read` (least privilege)
- Use `actions/checkout@v4`
- Use `pnpm/action-setup@v4` (auto-detects version from `packageManager` field)
- Use `actions/setup-node@v4` with `node-version: '22'` and `cache: 'pnpm'`
- Install with `pnpm install --frozen-lockfile`
- Run lint: root (`pnpm lint`) then packages (`pnpm -r run --if-present lint`)
- Run build: root (`pnpm build`) then packages (`pnpm -r run --if-present build`)
- Run test: root (`pnpm test`) then packages (`pnpm -r run --if-present test`)
- Use `--if-present` for resilience — packages without a script are skipped, but failing scripts still fail CI
- Do NOT modify existing `publish-devcontainer-feature.yml`

---

## Phase 4: Preview Publish Workflow

### T011 Create `.github/workflows/publish-preview.yml`
**File**: `.github/workflows/publish-preview.yml`
- Trigger on push to `develop` only
- Set `concurrency` with `cancel-in-progress: false` (prevent partial publishes)
- Set `permissions: contents: read`
- Use same checkout/pnpm/node setup as CI workflow
- Add `registry-url: 'https://registry.npmjs.org'` to setup-node (required for auth)
- Install dependencies with `--frozen-lockfile`
- Build root then packages (same as CI)
- Add "Check for changesets" step: detect `.changeset/*.md` files, set `has_changesets` output
- Add "Version (snapshot)" step: `pnpm changeset version --snapshot preview` (conditional on changesets)
- Add "Publish preview" step: `pnpm -r --filter '!generacy-extension' publish --tag preview --no-git-checks` (conditional on changesets)
- Pass `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to publish step
- Snapshot format: `0.1.0-preview.20260225143022` (datetime-based)
- No git reset needed — ephemeral runner is discarded

---

## Phase 5: Stable Release Workflow

### T012 Create `.github/workflows/release.yml`
**File**: `.github/workflows/release.yml`
- Trigger on push to `main` only
- Set `concurrency` with `cancel-in-progress: false` (prevent partial publishes)
- Set `permissions: contents: write, pull-requests: write` (needed for "Version Packages" PR)
- Use same checkout/pnpm/node setup with `registry-url`
- Install dependencies with `--frozen-lockfile`
- Build root then packages (same as CI)
- Use `changesets/action@v1` with:
  - `version: pnpm changeset version`
  - `publish: pnpm -r --filter '!generacy-extension' publish --no-git-checks`
  - `title: 'chore: version packages'`
  - `commit: 'chore: version packages'`
- Pass both `GITHUB_TOKEN` and `NODE_AUTH_TOKEN` (NPM_TOKEN) environment variables
- When changesets exist: creates "Version Packages" PR
- When PR is merged (no changesets remain): publishes to npm with `@latest` dist-tag

---

## Phase 6: Verification

### T013 Validate workflow YAML syntax
**Files**:
- `.github/workflows/ci.yml`
- `.github/workflows/publish-preview.yml`
- `.github/workflows/release.yml`
- Verify all YAML files are syntactically valid
- Check that GitHub Actions expressions use correct syntax (`${{ }}`)
- Verify all action versions are pinned (`@v4`, `@v1`)

### T014 Verify lockfile integrity
**File**: `pnpm-lock.yaml`
- Run `pnpm install --frozen-lockfile` to confirm lockfile is consistent
- Ensure `@changesets/cli` is properly installed and resolvable

### T015 Verify existing workflows are unmodified
**File**: `.github/workflows/publish-devcontainer-feature.yml`
- Confirm the existing devcontainer feature workflow is untouched
- No files outside the scope of this feature should be modified

### T016 Verify build and lint still pass
- Run `pnpm lint` (root) to confirm linting passes
- Run `pnpm build` (root) to confirm build passes
- Run `pnpm test` (root) to confirm tests pass
- Run `pnpm -r run --if-present lint` for packages
- Run `pnpm -r run --if-present build` for packages
- Run `pnpm -r run --if-present test` for packages

---

## Phase 7: Manual Steps (Post-Merge Documentation)

### T017 Document manual setup steps
- These steps cannot be automated in the PR and must be performed by a human:
  1. **Configure `NPM_TOKEN` secret**: Create granular npm access token scoped to `@generacy-ai/*` with read-write publish permissions; add as `NPM_TOKEN` in GitHub repo Settings → Secrets and variables → Actions
  2. **Branch protection on `main`**: Require PR reviews, require `ci` status check to pass; configure in GitHub repo Settings → Branches → Branch protection rules
  3. **Sync `main` to `develop`**: Create PR from `develop` → `main` after CI is in place (main currently only has initial commits)
- These are tracked as notes in the PR description, not as code changes

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (lockfile must be valid before modifying packages)
- Phase 1 must complete before Phase 3 (CI needs `packageManager` field for pnpm setup)
- Phase 2 must complete before Phase 4 (packages need `publishConfig` before preview publish)
- Phase 2 must complete before Phase 5 (packages need `publishConfig` before stable publish)
- Phases 3, 4, 5 are independent of each other (different workflow files)
- Phase 6 depends on all implementation phases (1-5)
- Phase 7 is documentation only, independent of code changes

**Parallel opportunities within phases**:
- Phase 2: T005, T006, T007, T008, T009 can all run in parallel (different files, no dependencies)
- Phase 3, 4, 5: T010, T011, T012 can run in parallel (different workflow files, no dependencies between them)

**Critical path**:
T001 → T002 → T003 → T004 → T005-T009 (parallel) → T010-T012 (parallel) → T013-T016 (verification) → T017

**Estimated file changes**: 16 files (3 created, 13 modified)
