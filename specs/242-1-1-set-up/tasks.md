# Tasks: Set up npm publishing for @generacy-ai packages

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1: npm publishing setup)

---

## Phase 1: Organization Setup (Manual, One-Time)

### T001 [DONE] [US1] Verify npm organization access
**Manual Task**
- Log in to npmjs.com with organization admin credentials
- Navigate to @generacy-ai organization settings
- Verify organization exists and is accessible
- Document current members and their permission levels
- Confirm automation user has publish permissions for all packages
- Document organization structure in implementation notes

### T002 [DONE] [US1] Generate npm automation token
**Manual Task** - Depends on: T001
- Log in to npmjs.com as automation user (or org admin)
- Navigate to Access Tokens page
- Generate New Token → Select "Automation" type
- Set permissions to Read/Write (publish access)
- Copy token to secure location (will be used in T003)
- Document token creation date and purpose

### T003 [DONE] [US1] Configure GitHub organization secret
**Manual Task** - Depends on: T002
- Navigate to https://github.com/organizations/generacy-ai/settings/secrets/actions
- Click "New organization secret"
- Name: `NPM_TOKEN`
- Value: Paste token from T002
- Repository access: Select "Public repositories"
- Save secret
- Verify secret appears in latency, agency, and generacy repos (Settings → Secrets → Actions)

### T004 [DONE] [US1] Document token rotation policy
**File**: `/workspaces/tetrad-development/docs/NPM_TOKEN_ROTATION.md`
- Document token creation date and location
- Define rotation schedule (annually recommended)
- Document rotation procedure:
  - Generate new token on npmjs.com
  - Update GitHub org secret
  - Verify workflows still pass
  - Revoke old token
- Document emergency rotation procedure (security incident)

---

## Phase 2A: Initial Branch Synchronization

### T005 [DONE] [US1] Synchronize main branch in latency repo
**Manual Task** - Depends on: T003
- Navigate to latency repo: `/workspaces/tetrad-development/packages/latency`
- Execute synchronization commands:
  ```bash
  git fetch origin
  git checkout main
  git reset --hard origin/develop
  git push --force-with-lease origin main
  ```
- Verify synchronization:
  ```bash
  git log main..develop  # Should be empty
  git log develop..main  # Should be empty
  ```
- Document commit hash where sync occurred

### T006 [DONE] [US1] Synchronize main branch in agency repo
**Manual Task** - Depends on: T003
- Navigate to agency repo: `/workspaces/tetrad-development/packages/agency`
- Execute synchronization commands:
  ```bash
  git fetch origin
  git checkout main
  git reset --hard origin/develop
  git push --force-with-lease origin main
  ```
- Verify synchronization:
  ```bash
  git log main..develop  # Should be empty
  git log develop..main  # Should be empty
  ```
- Document commit hash where sync occurred

### T007 [DONE] [US1] Synchronize main branch in generacy repo
**Manual Task** - Depends on: T003
- Navigate to generacy repo: `/workspaces/generacy`
- Execute synchronization commands:
  ```bash
  git fetch origin
  git checkout main
  git reset --hard origin/develop
  git push --force-with-lease origin main
  ```
- Verify synchronization:
  ```bash
  git log main..develop  # Should be empty
  git log develop..main  # Should be empty
  ```
- Document commit hash where sync occurred

---

## Phase 2B: Changesets Configuration

### T008 [DONE] [P] [US1] Install and initialize changesets in latency
**Files**:
- `/workspaces/tetrad-development/packages/latency/package.json`
- `/workspaces/tetrad-development/packages/latency/.changeset/config.json`
- `/workspaces/tetrad-development/packages/latency/.changeset/README.md`

**Depends on**: T005

- Navigate to latency repo root
- Install changesets: `pnpm add -D @changesets/cli`
- Initialize changesets: `pnpm changeset init`
- Create `.changeset/config.json` with configuration:
  ```json
  {
    "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
    "changelog": "@changesets/cli/changelog",
    "commit": false,
    "fixed": [],
    "linked": [],
    "access": "public",
    "baseBranch": "develop",
    "updateInternalDependencies": "patch",
    "ignore": []
  }
  ```
- Verify changesets CLI works: `pnpm changeset status`
- Commit changes to develop branch

### T009 [DONE] [P] [US1] Update changesets configuration in agency
**Files**:
- `/workspaces/tetrad-development/packages/agency/package.json`
- `/workspaces/tetrad-development/packages/agency/.changeset/config.json`

**Depends on**: T006

- Navigate to agency repo root
- Verify changesets already installed (check package.json)
- If not installed: `pnpm add -D @changesets/cli`
- Update existing `.changeset/config.json` to match standard:
  ```json
  {
    "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
    "changelog": "@changesets/cli/changelog",
    "commit": false,
    "fixed": [],
    "linked": [],
    "access": "public",
    "baseBranch": "develop",
    "updateInternalDependencies": "patch",
    "ignore": []
  }
  ```
- Verify changesets CLI works: `pnpm changeset status`
- Commit changes to develop branch

### T010 [DONE] [P] [US1] Install and initialize changesets in generacy
**Files**:
- `/workspaces/generacy/package.json`
- `/workspaces/generacy/.changeset/config.json`
- `/workspaces/generacy/.changeset/README.md`

**Depends on**: T007

- Navigate to generacy repo root
- Install changesets: `pnpm add -D @changesets/cli`
- Initialize changesets: `pnpm changeset init`
- Create `.changeset/config.json` with configuration:
  ```json
  {
    "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
    "changelog": "@changesets/cli/changelog",
    "commit": false,
    "fixed": [],
    "linked": [],
    "access": "public",
    "baseBranch": "develop",
    "updateInternalDependencies": "patch",
    "ignore": []
  }
  ```
- Verify changesets CLI works: `pnpm changeset status`
- Commit changes to develop branch

---

## Phase 3A: PR Validation Workflows

### T011 [DONE] [P] [US1] Create CI workflow for latency
**File**: `/workspaces/tetrad-development/packages/latency/.github/workflows/ci.yml`

**Depends on**: T008

- Create `.github/workflows/` directory if not exists
- Create `ci.yml` with complete CI workflow:
  - Triggers: PRs to all branches, push to develop/main
  - Jobs: lint, test, build
  - Use pnpm action setup
  - Node.js version: 20
  - Frozen lockfile installation
- Verify workflow syntax with GitHub Actions validator
- Test workflow on a test branch/PR
- Commit to develop branch

### T012 [DONE] [P] [US1] Create CI workflow for agency
**File**: `/workspaces/tetrad-development/packages/agency/.github/workflows/ci.yml`

**Depends on**: T009

- Create `.github/workflows/` directory if not exists
- Create `ci.yml` with complete CI workflow:
  - Triggers: PRs to all branches, push to develop/main
  - Jobs: lint, test, build
  - Use pnpm action setup
  - Node.js version: 20
  - Frozen lockfile installation
- Verify workflow syntax with GitHub Actions validator
- Test workflow on a test branch/PR
- Commit to develop branch

### T013 [DONE] [P] [US1] Create CI workflow for generacy
**File**: `/workspaces/generacy/.github/workflows/ci.yml`

**Depends on**: T010

- Create `.github/workflows/` directory if not exists
- Create `ci.yml` with complete CI workflow:
  - Triggers: PRs to all branches, push to develop/main
  - Jobs: lint, test, build
  - Use pnpm action setup
  - Node.js version: 20
  - Frozen lockfile installation
- Verify workflow syntax with GitHub Actions validator
- Test workflow on a test branch/PR
- Commit to develop branch

---

## Phase 3B: Preview Publish Workflows

### T014 [DONE] [US1] Create dependency verification script for agency
**File**: `/workspaces/tetrad-development/packages/agency/scripts/verify-deps.sh`

**Depends on**: T012

- Create `scripts/` directory if not exists
- Create executable script that:
  - Accepts dist-tag argument (preview or latest)
  - Parses package.json for @generacy-ai/* dependencies
  - Checks npm registry for each dependency's published version
  - Exits 0 if all checks pass, exits 1 with clear error if any missing
- Make script executable: `chmod +x scripts/verify-deps.sh`
- Test script manually with both tags
- Commit to develop branch

### T015 [DONE] [US1] Create dependency verification script for generacy
**File**: `/workspaces/generacy/scripts/verify-deps.sh`

**Depends on**: T013

- Create `scripts/` directory if not exists
- Create executable script that:
  - Accepts dist-tag argument (preview or latest)
  - Parses package.json for @generacy-ai/* dependencies (latency and agency)
  - Checks npm registry for each dependency's published version
  - Exits 0 if all checks pass, exits 1 with clear error if any missing
- Make script executable: `chmod +x scripts/verify-deps.sh`
- Test script manually with both tags
- Commit to develop branch

### T016 [DONE] [US1] Create preview publish workflow for latency
**File**: `/workspaces/tetrad-development/packages/latency/.github/workflows/publish-preview.yml`

**Depends on**: T011

- Create `publish-preview.yml` workflow:
  - Trigger: push to develop branch
  - Check for pending changesets (exit if none)
  - Create snapshot versions: `pnpm changeset version --snapshot preview`
  - Build packages: `pnpm build`
  - Publish to npm: `pnpm changeset publish --no-git-tag --tag preview`
  - Use NPM_TOKEN from secrets
  - Add PR comment job (optional, can be added later)
- Verify workflow syntax
- Test with dry-run or test branch
- Commit to develop branch

### T017 [DONE] [US1] Create preview publish workflow for agency
**File**: `/workspaces/tetrad-development/packages/agency/.github/workflows/publish-preview.yml`

**Depends on**: T012, T014

- Create `publish-preview.yml` workflow:
  - Trigger: push to develop branch
  - Check for pending changesets (exit if none)
  - Run dependency verification: `./scripts/verify-deps.sh preview`
  - Create snapshot versions: `pnpm changeset version --snapshot preview`
  - Build packages: `pnpm build`
  - Publish to npm: `pnpm changeset publish --no-git-tag --tag preview`
  - Use NPM_TOKEN from secrets
  - Add PR comment job (optional)
- Verify workflow syntax
- Test with dry-run or test branch
- Commit to develop branch

### T018 [DONE] [US1] Create preview publish workflow for generacy
**File**: `/workspaces/generacy/.github/workflows/publish-preview.yml`

**Depends on**: T013, T015

- Create `publish-preview.yml` workflow:
  - Trigger: push to develop branch
  - Check for pending changesets (exit if none)
  - Run dependency verification: `./scripts/verify-deps.sh preview`
  - Create snapshot versions: `pnpm changeset version --snapshot preview`
  - Build packages: `pnpm build`
  - Publish to npm: `pnpm changeset publish --no-git-tag --tag preview`
  - Use NPM_TOKEN from secrets
  - Add PR comment job (optional)
- Verify workflow syntax
- Test with dry-run or test branch
- Commit to develop branch

---

## Phase 3C: Stable Release Workflows

### T019 [DONE] [P] [US1] Create stable release workflow for latency
**File**: `/workspaces/tetrad-development/packages/latency/.github/workflows/release.yml`

**Depends on**: T016

- Create `release.yml` workflow:
  - Trigger: push to main branch
  - Use changesets/action@v1
  - Version command: `pnpm changeset version`
  - Publish command: `pnpm changeset publish`
  - Commit message: "chore: version packages"
  - PR title: "chore: version packages"
  - Permissions: contents: write, pull-requests: write
  - Use GITHUB_TOKEN and NPM_TOKEN
- Verify workflow syntax
- Commit to develop branch

### T020 [DONE] [P] [US1] Create stable release workflow for agency
**File**: `/workspaces/tetrad-development/packages/agency/.github/workflows/release.yml`

**Depends on**: T017

- Create `release.yml` workflow:
  - Trigger: push to main branch
  - Run dependency verification: `./scripts/verify-deps.sh latest` (before publish step)
  - Use changesets/action@v1
  - Version command: `pnpm changeset version`
  - Publish command: `pnpm changeset publish`
  - Commit message: "chore: version packages"
  - PR title: "chore: version packages"
  - Permissions: contents: write, pull-requests: write
  - Use GITHUB_TOKEN and NPM_TOKEN
- Verify workflow syntax
- Commit to develop branch

### T021 [DONE] [P] [US1] Create stable release workflow for generacy
**File**: `/workspaces/generacy/.github/workflows/release.yml`

**Depends on**: T018

- Create `release.yml` workflow:
  - Trigger: push to main branch
  - Run dependency verification: `./scripts/verify-deps.sh latest` (before publish step)
  - Use changesets/action@v1
  - Version command: `pnpm changeset version`
  - Publish command: `pnpm changeset publish`
  - Commit message: "chore: version packages"
  - PR title: "chore: version packages"
  - Permissions: contents: write, pull-requests: write
  - Use GITHUB_TOKEN and NPM_TOKEN
- Verify workflow syntax
- Commit to develop branch

---

## Phase 3D: Package Configuration

### T022 [DONE] [P] [US1] Update package.json for latency publishing
**File**: `/workspaces/tetrad-development/packages/latency/package.json`

**Depends on**: T008

- Update or add fields:
  - `name`: "@generacy-ai/latency"
  - `version`: "0.0.0" (changesets will manage)
  - `publishConfig`: `{ "access": "public" }`
  - `files`: ["dist", "README.md", "LICENSE"]
  - `main`: "./dist/index.js"
  - `types`: "./dist/index.d.ts"
  - `exports`: Proper ESM/CJS exports configuration
- Verify package.json is valid JSON
- Commit to develop branch

### T023 [P] [US1] Update package.json for agency publishing
**File**: `/workspaces/tetrad-development/packages/agency/package.json`

**Depends on**: T009

- Update or add fields:
  - `name`: "@generacy-ai/agency"
  - `version`: "0.0.0" (changesets will manage)
  - `publishConfig`: `{ "access": "public" }`
  - `files`: ["dist", "README.md", "LICENSE"]
  - `main`: "./dist/index.js"
  - `types`: "./dist/index.d.ts"
  - `exports`: Proper ESM/CJS exports configuration
- Verify package.json is valid JSON
- Commit to develop branch

### T024 [P] [US1] Update package.json for generacy publishing
**File**: `/workspaces/generacy/package.json`

**Depends on**: T010

- Update or add fields:
  - `name`: "@generacy-ai/generacy"
  - `version`: "0.0.0" (changesets will manage)
  - `publishConfig`: `{ "access": "public" }`
  - `files`: ["dist", "README.md", "LICENSE"]
  - `main`: "./dist/index.js" (or appropriate entry point)
  - `types`: "./dist/index.d.ts"
  - `exports`: Proper ESM/CJS exports configuration
- Verify package.json is valid JSON
- Commit to develop branch

---

## Phase 4: Branch Protection

### T025 [US1] Enable branch protection for latency/main
**Manual Task** - Depends on: T019

- Navigate to latency repo Settings → Branches on GitHub
- Add branch protection rule for `main`:
  - Require pull request before merging: ✓
  - Require approvals: 1
  - Dismiss stale reviews on push: ✓
  - Require status checks to pass: ✓
    - Add required checks: `lint`, `test`, `build`
    - Require branches to be up to date: ✓
  - Require conversation resolution: ✓
  - Do not allow bypassing settings: ✗ (allow admins)
  - Restrict force pushes: ✓
- Save changes
- Test by attempting to push directly to main (should fail)

### T026 [US1] Enable branch protection for agency/main
**Manual Task** - Depends on: T020

- Navigate to agency repo Settings → Branches on GitHub
- Add branch protection rule for `main`:
  - Require pull request before merging: ✓
  - Require approvals: 1
  - Dismiss stale reviews on push: ✓
  - Require status checks to pass: ✓
    - Add required checks: `lint`, `test`, `build`
    - Require branches to be up to date: ✓
  - Require conversation resolution: ✓
  - Do not allow bypassing settings: ✗ (allow admins)
  - Restrict force pushes: ✓
- Save changes
- Test by attempting to push directly to main (should fail)

### T027 [US1] Enable branch protection for generacy/main
**Manual Task** - Depends on: T021

- Navigate to generacy repo Settings → Branches on GitHub
- Add branch protection rule for `main`:
  - Require pull request before merging: ✓
  - Require approvals: 1
  - Dismiss stale reviews on push: ✓
  - Require status checks to pass: ✓
    - Add required checks: `lint`, `test`, `build`
    - Require branches to be up to date: ✓
  - Require conversation resolution: ✓
  - Do not allow bypassing settings: ✗ (allow admins)
  - Restrict force pushes: ✓
- Save changes
- Test by attempting to push directly to main (should fail)

---

## Phase 5: Documentation

### T028 [P] [US1] Create PUBLISHING.md for latency
**File**: `/workspaces/tetrad-development/packages/latency/PUBLISHING.md`

**Depends on**: T019

- Create comprehensive publishing guide covering:
  - How to create a changeset (`pnpm changeset`)
  - Preview releases (develop branch workflow)
  - Stable releases (main branch workflow)
  - Installation instructions for both dist-tags
  - Failed publish recovery procedures
  - Cross-package dependency notes (N/A for latency)
- Include code examples and command snippets
- Commit to develop branch

### T029 [P] [US1] Create PUBLISHING.md for agency
**File**: `/workspaces/tetrad-development/packages/agency/PUBLISHING.md`

**Depends on**: T020

- Create comprehensive publishing guide covering:
  - How to create a changeset (`pnpm changeset`)
  - Preview releases (develop branch workflow)
  - Stable releases (main branch workflow)
  - Installation instructions for both dist-tags
  - Failed publish recovery procedures
  - Dependency on @generacy-ai/latency (must publish first)
- Include code examples and command snippets
- Commit to develop branch

### T030 [P] [US1] Create PUBLISHING.md for generacy
**File**: `/workspaces/generacy/PUBLISHING.md`

**Depends on**: T021

- Create comprehensive publishing guide covering:
  - How to create a changeset (`pnpm changeset`)
  - Preview releases (develop branch workflow)
  - Stable releases (main branch workflow)
  - Installation instructions for both dist-tags
  - Failed publish recovery procedures
  - Dependencies on @generacy-ai/latency and @generacy-ai/agency
- Include code examples and command snippets
- Commit to develop branch

### T031 [P] [US1] Update README.md badges for latency
**File**: `/workspaces/tetrad-development/packages/latency/README.md`

**Depends on**: T028

- Add npm package badge: `[![npm version](https://badge.fury.io/js/@generacy-ai%2Flatency.svg)](https://www.npmjs.com/package/@generacy-ai/latency)`
- Add npm downloads badge (optional)
- Document available dist-tags: `@latest` and `@preview`
- Add installation instructions
- Commit to develop branch

### T032 [P] [US1] Update README.md badges for agency
**File**: `/workspaces/tetrad-development/packages/agency/README.md`

**Depends on**: T029

- Add npm package badge: `[![npm version](https://badge.fury.io/js/@generacy-ai%2Fagency.svg)](https://www.npmjs.com/package/@generacy-ai/agency)`
- Add npm downloads badge (optional)
- Document available dist-tags: `@latest` and `@preview`
- Add installation instructions
- Commit to develop branch

### T033 [P] [US1] Update README.md badges for generacy
**File**: `/workspaces/generacy/README.md`

**Depends on**: T030

- Add npm package badge: `[![npm version](https://badge.fury.io/js/@generacy-ai%2Fgeneracy.svg)](https://www.npmjs.com/package/@generacy-ai/generacy)`
- Add npm downloads badge (optional)
- Document available dist-tags: `@latest` and `@preview`
- Add installation instructions
- Commit to develop branch

### T034 [P] [US1] Update CONTRIBUTING.md for latency
**File**: `/workspaces/tetrad-development/packages/latency/CONTRIBUTING.md`

**Depends on**: T028

- Create or update CONTRIBUTING.md
- Add section on changesets workflow
- Link to PUBLISHING.md for detailed instructions
- Explain when to create changesets (user-facing changes)
- Commit to develop branch

### T035 [P] [US1] Update CONTRIBUTING.md for agency
**File**: `/workspaces/tetrad-development/packages/agency/CONTRIBUTING.md`

**Depends on**: T029

- Create or update CONTRIBUTING.md
- Add section on changesets workflow
- Link to PUBLISHING.md for detailed instructions
- Explain when to create changesets (user-facing changes)
- Commit to develop branch

### T036 [P] [US1] Update CONTRIBUTING.md for generacy
**File**: `/workspaces/generacy/CONTRIBUTING.md`

**Depends on**: T030

- Create or update CONTRIBUTING.md
- Add section on changesets workflow
- Link to PUBLISHING.md for detailed instructions
- Explain when to create changesets (user-facing changes)
- Commit to develop branch

---

## Phase 6: Validation & Testing

### T037 [US1] Test preview publish for latency
**Manual Task** - Depends on: T016, T022, T028

- Create test branch from develop in latency repo
- Make trivial change (e.g., add comment to README)
- Run `pnpm changeset` and select patch bump
- Write changeset description
- Commit changeset file
- Create PR to develop
- Merge PR
- Monitor workflow execution in GitHub Actions
- Verify workflow completes successfully
- Check npm: `npm info @generacy-ai/latency@preview`
- Verify version format: `*-preview.YYYYMMDDHHmmss`
- Document results

### T038 [US1] Test preview publish for agency
**Manual Task** - Depends on: T017, T023, T029, T037

- Create test branch from develop in agency repo
- Make trivial change (e.g., add comment to README)
- Run `pnpm changeset` and select patch bump
- Write changeset description
- Commit changeset file
- Create PR to develop
- Merge PR
- Monitor workflow execution in GitHub Actions
- Verify dependency verification passes (checks for @generacy-ai/latency@preview)
- Verify workflow completes successfully
- Check npm: `npm info @generacy-ai/agency@preview`
- Verify version format: `*-preview.YYYYMMDDHHmmss`
- Document results

### T039 [US1] Test preview publish for generacy
**Manual Task** - Depends on: T018, T024, T030, T038

- Create test branch from develop in generacy repo
- Make trivial change (e.g., add comment to README)
- Run `pnpm changeset` and select patch bump
- Write changeset description
- Commit changeset file
- Create PR to develop
- Merge PR
- Monitor workflow execution in GitHub Actions
- Verify dependency verification passes (checks for @generacy-ai/latency@preview and @generacy-ai/agency@preview)
- Verify workflow completes successfully
- Check npm: `npm info @generacy-ai/generacy@preview`
- Verify version format: `*-preview.YYYYMMDDHHmmss`
- Document results

### T040 [US1] Test stable release for latency
**Manual Task** - Depends on: T019, T025, T037

- Ensure changesets exist in latency/develop (from T037)
- Create PR from develop to main
- Get PR approval
- Merge PR to main
- Monitor workflow execution in GitHub Actions
- Verify "Version Packages" PR is created by changesets bot
- Review PR contents (version bumps, CHANGELOG.md updates)
- Approve and merge "Version Packages" PR
- Verify publish workflow runs after merge
- Check npm: `npm info @generacy-ai/latency@latest`
- Verify semver version (e.g., 0.0.1)
- Verify git tag created
- Document results

### T041 [US1] Test stable release for agency
**Manual Task** - Depends on: T020, T026, T038, T040

- Ensure changesets exist in agency/develop (from T038)
- Create PR from develop to main
- Get PR approval
- Merge PR to main
- Monitor workflow execution in GitHub Actions
- Verify "Version Packages" PR is created by changesets bot
- Review PR contents (version bumps, CHANGELOG.md updates)
- Approve and merge "Version Packages" PR
- Verify dependency verification passes (checks for @generacy-ai/latency@latest)
- Verify publish workflow runs after merge
- Check npm: `npm info @generacy-ai/agency@latest`
- Verify semver version (e.g., 0.0.1)
- Verify git tag created
- Document results

### T042 [US1] Test stable release for generacy
**Manual Task** - Depends on: T021, T027, T039, T041

- Ensure changesets exist in generacy/develop (from T039)
- Create PR from develop to main
- Get PR approval
- Merge PR to main
- Monitor workflow execution in GitHub Actions
- Verify "Version Packages" PR is created by changesets bot
- Review PR contents (version bumps, CHANGELOG.md updates)
- Approve and merge "Version Packages" PR
- Verify dependency verification passes (checks for @generacy-ai/latency@latest and @generacy-ai/agency@latest)
- Verify publish workflow runs after merge
- Check npm: `npm info @generacy-ai/generacy@latest`
- Verify semver version (e.g., 0.0.1)
- Verify git tag created
- Document results

### T043 [US1] Test dependency chain publishing
**Manual Task** - Depends on: T037, T038, T039

- Review publish order from preview tests (T037 → T038 → T039)
- Verify that agency publish waited for/verified latency@preview
- Verify that generacy publish waited for/verified agency@preview
- Document any timing issues or race conditions
- Verify all dependency versions are correct in published packages
- Test installing generacy@preview and verifying full dependency tree

### T044 [US1] Test failed publish recovery
**Manual Task** - Depends on: T040

- In latency repo, trigger a preview publish workflow
- Manually cancel the workflow mid-execution (or wait for it to complete)
- Re-run the workflow from GitHub Actions UI
- Verify idempotent behavior:
  - Already-published versions are skipped gracefully
  - Workflow completes successfully on re-run
  - No duplicate package errors
- Document recovery process and any issues encountered

### T045 [US1] Document validation results
**File**: `/workspaces/generacy/specs/242-1-1-set-up/validation-results.md`

**Depends on**: T037, T038, T039, T040, T041, T042, T043, T044

- Compile results from all validation tests (T037-T044)
- Document success/failure for each test
- Include npm package URLs for all published versions
- Include GitHub Actions workflow run URLs
- Note any issues or edge cases discovered
- Include screenshots or logs if applicable
- Mark all acceptance criteria as met or not met

---

## Phase 7: Finalization

### T046 [US1] Update project documentation
**Files**:
- `/workspaces/tetrad-development/docs/onboarding-buildout-plan.md`
- `/workspaces/generacy/specs/242-1-1-set-up/implementation-notes.md`

**Depends on**: T045

- Mark Issue 1.1 as complete in onboarding-buildout-plan.md
- Create implementation-notes.md with:
  - Token location and rotation policy reference
  - Branch protection configuration details
  - Known issues or limitations
  - Links to published packages
  - Links to workflow files
  - Lessons learned
- Commit documentation updates

### T047 [US1] Create PR template updates
**Files** (if not already present):
- `/workspaces/tetrad-development/packages/latency/.github/pull_request_template.md`
- `/workspaces/tetrad-development/packages/agency/.github/pull_request_template.md`
- `/workspaces/generacy/.github/pull_request_template.md`

**Depends on**: T036

- Create or update PR templates to include:
  - Checklist item: "Added changeset if this PR includes user-facing changes"
  - Link to PUBLISHING.md
  - Link to CONTRIBUTING.md
- Commit to develop branch

### T048 [US1] Final acceptance criteria verification
**Manual Task** - Depends on: T045

- Verify primary acceptance criterion: `npm info @generacy-ai/latency` returns package metadata ✓
- Verify extended acceptance criteria:
  - [ ] NPM_TOKEN configured and accessible
  - [ ] All three repos have working CI workflows
  - [ ] Branch protection enabled on main
  - [ ] Preview publishes work on merge to develop
  - [ ] Stable releases work on merge to main via Version PR
  - [ ] Dependency verification prevents broken publishes
  - [ ] Workflows are idempotent (safe to re-run)
  - [ ] PUBLISHING.md exists in all repos
  - [ ] At least one preview publish per repo
  - [ ] At least one stable publish per repo
  - [ ] Dependency chain tested (latency → agency → generacy)
- Document final verification in spec/242-1-1-set-up/VERIFICATION.md

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
1. Phase 1 (Organization Setup) must complete before any other phase
2. Phase 2A (Branch Sync) must complete before Phase 2B (Changesets Config)
3. Phase 2B must complete before Phase 3 (Workflows)
4. Phase 3 must complete before Phase 4 (Branch Protection)
5. Phase 5 (Documentation) can run in parallel with Phase 3-4
6. Phase 6 (Validation) depends on completion of Phases 2-5
7. Phase 7 (Finalization) depends on Phase 6

**Parallel opportunities within phases**:
- Phase 1: Sequential (manual setup tasks)
- Phase 2A: T005, T006, T007 can run in parallel (different repos)
- Phase 2B: T008, T009, T010 can run in parallel (different repos)
- Phase 3A: T011, T012, T013 can run in parallel (different repos)
- Phase 3B: T016 independent, T017 depends on T014, T018 depends on T015
- Phase 3C: T019, T020, T021 can run in parallel (different repos)
- Phase 3D: T022, T023, T024 can run in parallel (different repos)
- Phase 4: T025, T026, T027 can run in parallel (different repos, manual)
- Phase 5: T028-T036 can all run in parallel (different files)
- Phase 6: T037 → T038 → T039 must be sequential (dependency chain), T040 → T041 → T042 must be sequential

**Critical path**:
```
T001 → T002 → T003 →
  T005 → T008 → T011 → T016 → T019 → T022 → T025 → T028 → T037 → T040 →
  T038 → T041 →
  T039 → T042 →
  T045 → T046 → T048
```

**Estimated timeline**: 1-2 days with manual steps
- Phase 1: 30 minutes
- Phase 2: 2 hours
- Phase 3: 4 hours
- Phase 4: 30 minutes
- Phase 5: 2 hours
- Phase 6: 2 hours
- Phase 7: 1 hour

**Total tasks**: 48 tasks (28 parallel opportunities, 20 sequential)
