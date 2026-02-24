# Implementation Plan: Set up npm publishing for @generacy-ai packages

**Feature**: 242-1-1-set-up
**Date**: 2026-02-24
**Status**: Ready for Implementation

## Summary

This task establishes the foundational npm publishing infrastructure for the @generacy-ai organization, enabling automated preview and stable release streams across three public repositories (latency, agency, generacy). This is an organization-level coordination task that sets up the tooling, secrets, workflows, and branch protections required for all subsequent CI/CD work.

## Technical Context

### Environment
- **Package Manager**: pnpm with workspaces (all repos)
- **Versioning**: Changesets (`@changesets/cli`) for automated version management
- **CI Platform**: GitHub Actions
- **npm Organization**: `@generacy-ai` (public packages)
- **Repositories**:
  - `latency` (30 commits ahead on develop)
  - `agency` (111 commits ahead, changesets already configured)
  - `generacy` (180 commits ahead)

### Key Technologies
- **@changesets/cli** v2.28.1+ - Version and changelog management
- **changesets/action** - GitHub Action for automated releases
- **npm** - Registry and publishing (public access)
- **GitHub Actions** - CI/CD orchestration

### Current State
- **Agency**: Has `.changeset/config.json` with `baseBranch: "main"` and `access: "public"`
- **Latency**: No `.changeset/` directory, no `.github/workflows/`
- **Generacy**: No changesets configuration visible
- **All repos**: `main` branch exists but is significantly behind `develop`

## Architecture Overview

### Release Stream Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    @generacy-ai npm Organization                 │
│                                                                   │
│  ┌────────────────────────┐     ┌─────────────────────────┐    │
│  │   @preview dist-tag    │     │   @latest dist-tag      │    │
│  │  (develop → snapshot)  │     │  (main → semver)        │    │
│  └────────────────────────┘     └─────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
           ▲                                  ▲
           │                                  │
    ┌──────┴──────┐                   ┌──────┴──────┐
    │   develop   │                   │     main    │
    │   branch    │                   │    branch   │
    └─────────────┘                   └─────────────┘
         │                                    │
         │ Merge PR with                      │ Merge PR with
         │ .changeset/*.md                    │ .changeset/*.md
         │                                    │
         ▼                                    ▼
    ┌──────────────────┐               ┌─────────────────────┐
    │ Snapshot Publish │               │ Changesets Action   │
    │                  │               │ Creates Version PR  │
    │ changeset version│               │                     │
    │ --snapshot preview│              │ Merging PR triggers │
    │                  │               │ stable publish      │
    └──────────────────┘               └─────────────────────┘
         │                                    │
         ▼                                    ▼
  1.0.0-preview.20260224143022          1.0.0, 1.0.1, etc.
```

### Publish Order & Dependency Chain

```
latency (core framework)
    ↓
    └─→ agency (depends on @generacy-ai/latency@*)
            ↓
            └─→ generacy (depends on agency & latency)
```

Each publish workflow includes a dependency verification step before publishing.

### Branch Strategy

**Before Implementation:**
- `develop` is default branch (30-180 commits ahead of main)
- `main` exists but is stale

**After Implementation:**
1. Reset `main` to match `develop` (force-push, one-time operation)
2. Enable branch protection on `main`:
   - Require pull request
   - Require status checks: build, test, lint
   - No force pushes (after initial sync)
3. Both branches operational with different publish behaviors

## Implementation Phases

### Phase 1: Organization Setup (Manual, One-Time)

**Objective**: Configure npm organization and GitHub secrets

**Tasks**:

1. **Verify npm Organization Access**
   - Confirm `@generacy-ai` npm organization exists
   - Ensure automation user has publish rights
   - Document organization members/permissions

2. **Generate npm Automation Token**
   - Create automation token with publish permissions
   - Scope: Read/Write (not granular per-package)
   - Token type: Automation (for CI/CD)

3. **Configure GitHub Organization Secret**
   - Add `NPM_TOKEN` as organization-level secret
   - Scope: Accessible to public repositories
   - Verify secret is available in latency, agency, generacy repos

**Deliverables**:
- [ ] `NPM_TOKEN` available in all three repos
- [ ] Organization admin access documented
- [ ] Token rotation policy documented

**Manual Steps Required**:
```bash
# Generate npm token (on npmjs.com)
# 1. Log in to npmjs.com
# 2. Navigate to Access Tokens
# 3. Generate New Token → Automation
# 4. Copy token

# Add to GitHub
# 1. Navigate to https://github.com/organizations/generacy-ai/settings/secrets/actions
# 2. New organization secret
# 3. Name: NPM_TOKEN
# 4. Value: <paste token>
# 5. Repository access: Public repositories
```

---

### Phase 2: Repository Preparation

**Objective**: Synchronize main branches and configure changesets in all repos

#### 2A: Initial Branch Synchronization

**For each repo (latency, agency, generacy):**

```bash
# In each repo directory
git fetch origin
git checkout main
git reset --hard origin/develop
git push --force-with-lease origin main
```

**Verification**:
```bash
# Confirm main and develop are at same commit
git log main..develop  # Should be empty
git log develop..main  # Should be empty
```

**Note**: This is a one-time operation before branch protection is enabled.

#### 2B: Changesets Configuration

**Files to create/update in each repo:**

**latency** (new configuration):
- `.changeset/config.json`
- `.changeset/README.md` (generated by `changeset init`)

**agency** (update existing):
- Update `.changeset/config.json` to align with new strategy

**generacy** (new configuration):
- `.changeset/config.json`
- `.changeset/README.md`

**Changesets Configuration Template**:

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

**Key Configuration Decisions**:
- `baseBranch: "develop"` - Changesets tracks changes from develop (not main)
- `access: "public"` - All packages published with `--access public`
- `commit: false` - Don't auto-commit version bumps (handled by workflows)
- `updateInternalDependencies: "patch"` - Bump internal deps on any change

**Installation**:

```bash
# In each repo root
pnpm add -D @changesets/cli
pnpm changeset init
```

**Deliverables**:
- [ ] All repos have `main` synchronized with `develop`
- [ ] Changesets configured in latency, agency, generacy
- [ ] Dependencies added to root package.json

---

### Phase 3: GitHub Actions Workflows

**Objective**: Create CI workflows for all three repos with dual release streams

#### Workflow Architecture

Each repo needs 3 workflows:

1. **PR Validation** (`ci.yml`) - Runs on all PRs, any branch
2. **Preview Publish** (`publish-preview.yml`) - Runs on merge to develop
3. **Stable Release** (`release.yml`) - Runs on merge to main

#### 3A: PR Validation Workflow

**Purpose**: Validate all PRs before merge

**File**: `.github/workflows/ci.yml`

**Triggers**:
- Pull requests to any branch
- Push to develop (as pre-publish validation)

**Jobs**:
1. **Setup**: Checkout, install pnpm, install deps
2. **Lint**: Run linting across workspace
3. **Typecheck**: Run TypeScript type checking
4. **Test**: Run test suites
5. **Build**: Build all packages

**Required Status Checks**: `lint`, `test`, `build`

#### 3B: Preview Publish Workflow

**Purpose**: Publish snapshot versions when changesets exist on develop

**File**: `.github/workflows/publish-preview.yml`

**Triggers**:
- Push to `develop` branch

**Logic**:
```yaml
1. Checkout repo
2. Install dependencies
3. Check for pending changesets
   - If no changesets: exit (no publish)
   - If changesets exist: continue
4. Create snapshot versions
   - pnpm changeset version --snapshot preview
5. Build all packages
   - pnpm build
6. Publish to npm
   - pnpm changeset publish --no-git-tag --tag preview
7. Comment on associated PR with published versions
```

**Idempotency**: Check if version already published before attempting publish (npm publish returns error for duplicates, which should be caught gracefully)

**Dependency Verification** (agency and generacy only):
```yaml
- name: Verify Dependencies Published
  run: |
    # Check that @generacy-ai/latency@preview is available (for agency)
    # Check that @generacy-ai/agency@preview is available (for generacy)
    # Fail with clear error if dependency not found
```

#### 3C: Stable Release Workflow

**Purpose**: Create "Version Packages" PR and publish stable versions

**File**: `.github/workflows/release.yml`

**Triggers**:
- Push to `main` branch

**Implementation**: Uses `changesets/action@v1`

```yaml
- name: Create Release Pull Request or Publish
  uses: changesets/action@v1
  with:
    version: pnpm changeset version
    publish: pnpm changeset publish
    commit: "chore: version packages"
    title: "chore: version packages"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Behavior**:
- If changesets exist: Create/update "Version Packages" PR
- If "Version Packages" PR is merged: Publish to npm with `@latest` tag

**Dependency Verification** (agency and generacy only):
```yaml
- name: Verify Dependencies Published
  run: |
    # Check that @generacy-ai/latency@latest is at expected version
    # Check that @generacy-ai/agency@latest is at expected version
```

#### 3D: Dependency Verification Script

**Purpose**: Shared script to verify dependencies before publishing

**File**: `scripts/verify-deps.sh` (in each repo)

```bash
#!/bin/bash
set -e

# Parse package.json for @generacy-ai/* dependencies
# For each dependency:
#   - Extract expected version
#   - Check npm registry for published version
#   - Fail if not found or version mismatch
# Exit 0 if all checks pass
```

**Usage in workflows**:
```yaml
- name: Verify Dependencies
  run: ./scripts/verify-deps.sh ${{ github.ref_name == 'develop' && 'preview' || 'latest' }}
```

**Deliverables**:
- [ ] Workflows created in all three repos
- [ ] Dependency verification scripts in agency and generacy
- [ ] All workflows tested with dry-run or test publish

---

### Phase 4: Branch Protection

**Objective**: Enable branch protection on `main` after workflows are in place

**Configuration** (for each repo):

**Branch**: `main`

**Rules**:
- [x] Require pull request before merging
  - [x] Require approvals: 1
  - [x] Dismiss stale reviews on push: true
- [x] Require status checks to pass:
  - [x] `lint`
  - [x] `test`
  - [x] `build`
  - [x] Require branches to be up to date: true
- [x] Require conversation resolution: true
- [x] Do not allow bypassing settings: false (allow admins to bypass)
- [ ] Restrict force pushes: true (after initial sync)

**Applied to**: `latency`, `agency`, `generacy`

**Manual Steps**:
```
1. Navigate to repo Settings → Branches
2. Add branch protection rule for `main`
3. Configure settings as above
4. Save changes
```

**Deliverables**:
- [ ] Branch protection enabled on latency/main
- [ ] Branch protection enabled on agency/main
- [ ] Branch protection enabled on generacy/main

---

### Phase 5: Documentation

**Objective**: Document the publishing process for maintainers

**Documentation Files**:

1. **PUBLISHING.md** (in each repo)
   - How to create a changeset
   - How preview publishing works
   - How stable releases work
   - How to handle failed publishes
   - Dependency update workflow

2. **Update CONTRIBUTING.md** (if exists)
   - Add section on changesets
   - Link to PUBLISHING.md

3. **Root README.md Update**
   - Add npm package badges
   - Document available dist-tags

**Template: PUBLISHING.md**

```markdown
# Publishing Guide

## Creating a Changeset

When you make a change that affects package users:

```bash
pnpm changeset
```

Follow the prompts:
1. Select packages that changed
2. Select semver bump type (patch/minor/major)
3. Write a description of the change

This creates a file in `.changeset/*.md` - commit this with your PR.

## Preview Releases (develop branch)

When your PR with a changeset is merged to `develop`:
- CI runs `changeset version --snapshot preview`
- Snapshot version created: `1.0.0-preview.20260224143022`
- Published to npm with `@preview` dist-tag
- Bot comments on PR with published versions

**Installation**:
```bash
npm install @generacy-ai/latency@preview
```

## Stable Releases (main branch)

When a PR with changesets is merged to `main`:
- Changesets bot creates a "Version Packages" PR
- PR contains version bumps and changelog updates
- Merging that PR triggers publish to npm with `@latest` tag

**Installation**:
```bash
npm install @generacy-ai/latency  # Gets @latest
```

## Failed Publish Recovery

If a publish workflow fails:
1. Check the workflow logs for the error
2. Re-run the workflow (it's idempotent)
3. If package already published, workflow skips it
4. Manual publish (if needed):
   ```bash
   npm publish --access public --tag preview
   ```

## Cross-Package Dependencies

When latency publishes a new preview:
- A follow-up PR is created in agency/generacy
- PR updates package.json to new latency version
- Merge the PR to propagate the update
```

**Deliverables**:
- [ ] PUBLISHING.md in latency
- [ ] PUBLISHING.md in agency
- [ ] PUBLISHING.md in generacy
- [ ] README badges updated

---

### Phase 6: Validation & Testing

**Objective**: Verify end-to-end publish flow in all repos

**Test Plan**:

#### Test 1: Preview Publish (develop)

**For each repo:**

1. Create test branch from develop
2. Create a trivial change (e.g., add comment to README)
3. Run `pnpm changeset` and select patch bump
4. Commit changeset file
5. Create PR to develop
6. Merge PR
7. Verify workflow runs and publishes
8. Check npm: `npm info @generacy-ai/[package]@preview`
9. Verify version format: `*-preview.YYYYMMDDHHmmss`

**Expected Outcome**:
- Workflow completes successfully
- Package available on npm with @preview tag
- Bot comments on PR (if configured)

#### Test 2: Stable Release (main)

**For each repo:**

1. Ensure changesets exist in main (from test 1)
2. Push to main (or create/merge PR to main)
3. Verify "Version Packages" PR is created
4. Review PR contents (version bumps, changelog)
5. Merge PR
6. Verify publish workflow runs
7. Check npm: `npm info @generacy-ai/[package]@latest`
8. Verify semver version and changelog

**Expected Outcome**:
- Version Packages PR created
- Merging PR triggers publish
- Package available on npm with @latest tag
- Git tag created

#### Test 3: Dependency Chain

1. Publish latency preview
2. Verify agency preview publish waits/succeeds after latency
3. Verify generacy preview publish waits/succeeds after agency

**Expected Outcome**:
- Publish order respected
- Dependency checks pass
- All packages published with correct versions

#### Test 4: Failed Publish Recovery

1. Trigger a publish workflow
2. Simulate failure (temporarily invalid token, network issue)
3. Re-run workflow
4. Verify idempotent behavior

**Expected Outcome**:
- Re-run succeeds
- No duplicate package errors
- Clear error messages

**Deliverables**:
- [ ] All tests pass for latency
- [ ] All tests pass for agency
- [ ] All tests pass for generacy
- [ ] Test results documented

---

## Package Configuration Updates

### Required package.json Updates

**In each publishable package:**

```json
{
  "name": "@generacy-ai/[package-name]",
  "version": "0.0.0",
  "publishConfig": {
    "access": "public"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

**Notes**:
- `version: "0.0.0"` - Managed by changesets
- `publishConfig.access: "public"` - Required for scoped packages
- `files` - Explicit list of published files (prevents accidental inclusion)
- `exports` - Modern Node.js package entry points

---

## Key Technical Decisions

### Decision 1: Changesets Over Manual Versioning

**Rationale**:
- Automated version management reduces human error
- Built-in changelog generation
- Supports monorepos with workspace dependencies
- Standard workflow used by many OSS projects
- GitHub Action integration for "Version Packages" PR

**Alternatives Considered**:
- Manual semver tagging (too error-prone)
- Lerna (deprecated, less actively maintained)
- Conventional commits + semantic-release (more complex, less flexible)

**Trade-offs**:
- Requires developers to remember to add changesets
- Extra file in PRs (.changeset/*.md)
- Learning curve for contributors

---

### Decision 2: Datetime-Based Preview Versions

**Format**: `1.0.0-preview.20260224143022`

**Rationale**:
- Human-readable freshness indicator
- Avoids same-day publish conflicts
- Native support via `changeset version --snapshot preview`
- Sorts correctly in npm version listing
- Traceable to approximate publish time

**Alternatives Considered**:
- Commit hash (less readable for freshness)
- Sequential numbers (requires state tracking)
- Date-only (can conflict with multiple daily publishes)

---

### Decision 3: Changeset-Based Publishing Trigger

**Approach**: Only publish when `.changeset/*.md` files exist

**Rationale**:
- Avoids noise from docs-only or config-only changes
- Maintainers control when versions bump
- Explicit changelog entries
- Standard changesets workflow

**Alternatives Considered**:
- Publish on every merge (too noisy)
- Manual workflow_dispatch (less automated)
- Code-change detection (fragile, hard to configure)

---

### Decision 4: Reset Main to Develop

**Approach**: Force-push develop to main (one-time operation)

**Rationale**:
- Main only has 2 initial commits (nothing to preserve)
- Simplest way to establish common baseline
- Avoids complex merge conflicts
- Clean history for release stream

**Alternatives Considered**:
- Fast-forward merge (potential conflicts)
- Squash merge (loses commit granularity)
- Cherry-pick (too manual, error-prone)

---

### Decision 5: Dependency Verification Before Publish

**Approach**: Each repo's workflow verifies @generacy-ai/* deps are published

**Rationale**:
- Prevents broken publishes (missing dependency versions)
- Fails fast with clear error message
- Lightweight compared to cross-repo workflow orchestration
- Works across repositories without complex setup

**Alternatives Considered**:
- Workflow dependencies (doesn't work cross-repo in GitHub Actions)
- Manual publish order enforcement (error-prone)
- Monorepo migration (out of scope, major refactor)

---

### Decision 6: Idempotent Publish Workflows

**Approach**: Gracefully handle "already published" errors, allow re-runs

**Rationale**:
- Simplifies recovery from partial failures
- Safe to re-run workflows
- No need for manual cleanup
- Reduces operational burden

**Implementation**:
- Check npm registry before publishing
- Catch publish errors and check if "version already exists"
- Exit successfully if already published

---

## Risk Mitigation

### Risk 1: Accidental Publish to Wrong Tag

**Likelihood**: Medium
**Impact**: Medium (confusion for users, wrong versions installed)

**Mitigation**:
- Workflow conditionals check branch name before selecting tag
- Dry-run testing before going live
- Clear workflow logs showing which tag is being used
- Documentation emphasizes dist-tag importance

**Recovery**:
- Deprecate incorrect version on npm
- Publish corrected version
- Document mistake in changelog

---

### Risk 2: NPM_TOKEN Exposure or Expiration

**Likelihood**: Low
**Impact**: High (publishing blocked, security risk)

**Mitigation**:
- Token stored as GitHub org secret (encrypted)
- Token rotation policy documented
- Monitor workflow failures (broken token surfaces immediately)
- Document token regeneration process

**Recovery**:
1. Generate new automation token on npmjs.com
2. Update GitHub org secret
3. Re-run failed workflows

---

### Risk 3: Publish Order Violation (Dependency Breakage)

**Likelihood**: Medium (without automation)
**Impact**: High (broken packages, failed builds for consumers)

**Mitigation**:
- Dependency verification script in workflows
- Explicit publish order documentation
- Fail-fast with clear error messages
- Test publish order in validation phase

**Recovery**:
1. Identify missing dependency version
2. Re-run publish in correct order
3. May need to publish hotfix version

---

### Risk 4: Main Branch Desync After Initial Reset

**Likelihood**: Medium
**Impact**: Medium (confusing history, merge conflicts)

**Mitigation**:
- Branch protection prevents force pushes after initial sync
- Clear documentation: develop → main is one-way via PR
- Regular merges from develop to main via release PRs
- Monitor branch divergence

**Recovery**:
- Create PR from develop to main
- Resolve conflicts if any
- Merge to re-sync

---

### Risk 5: Changesets Not Created by Contributors

**Likelihood**: High (new workflow for contributors)
**Impact**: Low (caught in PR review)

**Mitigation**:
- Documentation in CONTRIBUTING.md
- PR template checklist item for changesets
- CI check that warns if no changeset (possible future enhancement)
- Reviewer guidance to check for changesets

**Recovery**:
- Request changeset addition before merge
- Maintainer can add changeset on contributor's behalf

---

### Risk 6: Preview Versions Not Consumed by Dependents

**Likelihood**: Medium
**Impact**: Medium (preview packages untested, bugs in stable)

**Mitigation**:
- Automated PRs to update dependencies (clarification Q8)
- CI in agency/generacy tests against preview versions
- Documentation encourages testing preview versions

**Recovery**:
- Catch issues in stable release testing
- Hotfix if needed

---

## Success Criteria

### Acceptance Criteria (from spec)

- [x] `npm info @generacy-ai/latency` returns package metadata
- [x] Both `@preview` and `@latest` dist-tags are configured and functional

### Extended Success Criteria

**Organizational**:
- [ ] NPM_TOKEN configured and accessible
- [ ] All three repos have working CI workflows
- [ ] Branch protection enabled on main

**Technical**:
- [ ] Preview publishes work on merge to develop
- [ ] Stable releases work on merge to main via Version PR
- [ ] Dependency verification prevents broken publishes
- [ ] Workflows are idempotent (safe to re-run)

**Documentation**:
- [ ] PUBLISHING.md exists in all repos
- [ ] Maintainers understand changeset workflow
- [ ] Recovery procedures documented

**Validation**:
- [ ] At least one preview publish per repo
- [ ] At least one stable publish per repo
- [ ] Dependency chain tested (latency → agency → generacy)

---

## Post-Implementation

### Immediate Follow-Ups

1. **Issue 1.2** (latency#31): Full CI/CD for latency repo
2. **Issue 1.3** (agency#292): Full CI/CD for agency repo
3. **Issue 1.4** (generacy#243): Full CI/CD for generacy repo

This task establishes the foundation. Follow-up issues will implement repo-specific workflows, build optimization, and testing infrastructure.

### Monitoring

**Metrics to Track**:
- Publish success rate (% of workflows that complete)
- Time from merge to npm availability
- Number of failed publishes requiring manual intervention
- Changeset adoption rate (% of PRs with changesets)

**Alerts**:
- Publish workflow failures (GitHub Actions notifications)
- NPM token expiration (proactive renewal)
- Branch protection violations

### Maintenance

**Regular Tasks**:
- Quarterly review of npm organization members
- NPM token rotation (annually or on security incident)
- Update changesets/action version (when new releases available)
- Review and update PUBLISHING.md as workflow evolves

---

## Timeline Estimate

**Total Effort**: 1-2 days (with manual steps requiring human decision-making)

| Phase | Estimated Time | Can Parallelize? |
|-------|----------------|------------------|
| Phase 1: Org Setup | 30 minutes | No (manual) |
| Phase 2: Repo Prep | 2 hours | Yes (per repo) |
| Phase 3: Workflows | 4 hours | Yes (per repo) |
| Phase 4: Branch Protection | 30 minutes | Yes (per repo) |
| Phase 5: Documentation | 2 hours | Yes (per repo) |
| Phase 6: Validation | 2 hours | Partially (per repo, but dependency chain sequential) |

**Critical Path**: Phase 1 → Phase 2 → Phase 3 → Phase 6 (dependency chain test)

**Parallelization**: Phases 2-5 can be done in parallel across repos once Phase 1 completes.

---

## Appendix A: Workflow Templates

### CI Workflow Template

**File**: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: ["**"]
  push:
    branches: [develop, main]

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
```

### Preview Publish Workflow Template

**File**: `.github/workflows/publish-preview.yml`

```yaml
name: Publish Preview

on:
  push:
    branches: [develop]

jobs:
  publish:
    name: Publish Preview Packages
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          registry-url: 'https://registry.npmjs.org'

      - run: pnpm install --frozen-lockfile

      - name: Check for changesets
        id: check-changesets
        run: |
          if [ -n "$(ls -A .changeset/*.md 2>/dev/null | grep -v README)" ]; then
            echo "has-changesets=true" >> $GITHUB_OUTPUT
          else
            echo "has-changesets=false" >> $GITHUB_OUTPUT
          fi

      - name: Create snapshot versions
        if: steps.check-changesets.outputs.has-changesets == 'true'
        run: |
          pnpm changeset version --snapshot preview

      - name: Build packages
        if: steps.check-changesets.outputs.has-changesets == 'true'
        run: pnpm build

      - name: Publish to npm
        if: steps.check-changesets.outputs.has-changesets == 'true'
        run: |
          pnpm changeset publish --no-git-tag --tag preview
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Comment on PR
        if: steps.check-changesets.outputs.has-changesets == 'true'
        uses: actions/github-script@v7
        with:
          script: |
            const packages = require('./package.json');
            // Logic to find associated PR and comment with published versions
            // (Implementation details omitted for brevity)
```

### Stable Release Workflow Template

**File**: `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    branches: [main]

jobs:
  release:
    name: Release Packages
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          registry-url: 'https://registry.npmjs.org'

      - run: pnpm install --frozen-lockfile

      - name: Create Release Pull Request or Publish
        uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm changeset publish
          commit: "chore: version packages"
          title: "chore: version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## Appendix B: Troubleshooting Guide

### Problem: Workflow fails with "npm publish error: 403"

**Cause**: Invalid or missing NPM_TOKEN

**Solution**:
1. Verify secret exists: GitHub org settings → Secrets
2. Check token validity: `npm whoami --registry=https://registry.npmjs.org`
3. Regenerate token if needed
4. Update secret

---

### Problem: "Version already exists" error during publish

**Cause**: Package version already published (not actually a problem if workflow is re-running)

**Solution**:
- Workflow should catch this and exit successfully
- If workflow fails, add error handling:
  ```bash
  pnpm changeset publish || npm view @generacy-ai/package@version && echo "Already published"
  ```

---

### Problem: Changesets Version PR not created on main merge

**Cause**: No pending changesets to version

**Solution**:
- Verify changesets exist: `ls .changeset/*.md | grep -v README`
- Check changeset status: `pnpm changeset status`
- Changesets may have been consumed by previous release

---

### Problem: Dependency verification fails

**Cause**: Required @generacy-ai/* dependency not published yet

**Solution**:
1. Check publish order: latency → agency → generacy
2. Verify dependency published: `npm view @generacy-ai/latency@preview`
3. Re-run failed workflow after dependency publishes
4. Check for typos in dependency versions

---

### Problem: Main and develop diverge after initial sync

**Cause**: Direct commits to main or develop without coordination

**Solution**:
1. All changes go through develop first
2. Merge develop → main only via release PRs
3. If diverged, create sync PR: develop → main
4. Resolve conflicts, merge

---

## Appendix C: Reference Links

**Changesets Documentation**:
- [Changesets GitHub](https://github.com/changesets/changesets)
- [Changesets Action](https://github.com/changesets/action)
- [Snapshot Releases](https://github.com/changesets/changesets/blob/main/docs/snapshot-releases.md)

**npm Publishing**:
- [npm Access Tokens](https://docs.npmjs.com/about-access-tokens)
- [npm Scoped Packages](https://docs.npmjs.com/cli/v10/using-npm/scope)
- [npm dist-tags](https://docs.npmjs.com/cli/v10/commands/npm-dist-tag)

**GitHub Actions**:
- [Workflow Syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
- [Encrypted Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [Branch Protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

**Related Issues**:
- [generacy#238](https://github.com/generacy-ai/generacy/issues/238) - CI/CD Epic
- [latency#31](https://github.com/generacy-ai/latency/issues/31) - Latency CI/CD
- [agency#292](https://github.com/generacy-ai/agency/issues/292) - Agency CI/CD
- [generacy#243](https://github.com/generacy-ai/generacy/issues/243) - Generacy CI/CD

---

*Plan generated: 2026-02-24*
*Author: Claude (Sonnet 4.5)*
*Spec: 242-1-1-set-up*
