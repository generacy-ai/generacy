# Implementation Checklist: npm Publishing Setup

**Feature**: 242-1-1-set-up
**Date**: 2026-02-24

## Overview

This checklist provides a step-by-step guide for implementing npm publishing infrastructure for @generacy-ai packages. Check off each item as you complete it.

---

## Phase 1: Organization Setup (Manual)

**Estimated Time**: 30 minutes

### npm Organization Configuration

- [ ] **1.1** Log in to npmjs.com with admin account
- [ ] **1.2** Verify `@generacy-ai` organization exists
- [ ] **1.3** Navigate to organization settings → Members
- [ ] **1.4** Confirm automation user has publish permissions
- [ ] **1.5** Document organization admin contacts

### npm Automation Token

- [ ] **1.6** Navigate to npmjs.com → Access Tokens
- [ ] **1.7** Click "Generate New Token" → Select "Automation"
- [ ] **1.8** Name token: `GitHub Actions - @generacy-ai`
- [ ] **1.9** Set permissions: Read and Write
- [ ] **1.10** (Optional) Limit to specific packages if needed
- [ ] **1.11** Copy token to secure location (shown only once)

### GitHub Organization Secret

- [ ] **1.12** Navigate to https://github.com/organizations/generacy-ai/settings/secrets/actions
- [ ] **1.13** Click "New organization secret"
- [ ] **1.14** Name: `NPM_TOKEN`
- [ ] **1.15** Value: Paste npm automation token
- [ ] **1.16** Repository access: Select "Public repositories"
- [ ] **1.17** Click "Add secret"

### Verification

- [ ] **1.18** Verify secret is accessible:
  ```bash
  # Check in any public repo's Actions settings
  gh secret list --org generacy-ai
  ```

### Documentation

- [ ] **1.19** Document npm org admin contacts in PUBLISHING.md
- [ ] **1.20** Document token rotation policy (annual)
- [ ] **1.21** Set calendar reminder for token rotation

---

## Phase 2A: Repository Preparation - Latency

**Estimated Time**: 1 hour

### Branch Synchronization

- [ ] **2A.1** Clone latency repository
  ```bash
  git clone https://github.com/generacy-ai/latency.git
  cd latency
  ```

- [ ] **2A.2** Verify current branch state
  ```bash
  git fetch origin
  git log --oneline main..develop | wc -l
  # Should show ~30 commits
  ```

- [ ] **2A.3** Backup main branch (safety)
  ```bash
  git checkout main
  git branch main-backup-$(date +%Y%m%d)
  git push origin main-backup-$(date +%Y%m%d)
  ```

- [ ] **2A.4** Reset main to develop
  ```bash
  git checkout main
  git reset --hard origin/develop
  git push --force-with-lease origin main
  ```

- [ ] **2A.5** Verify synchronization
  ```bash
  git log main..develop  # Should be empty
  git log develop..main  # Should be empty
  ```

### Changesets Installation

- [ ] **2A.6** Checkout develop branch
  ```bash
  git checkout develop
  git pull origin develop
  ```

- [ ] **2A.7** Install changesets CLI
  ```bash
  pnpm add -D -w @changesets/cli
  ```

- [ ] **2A.8** Initialize changesets
  ```bash
  pnpm changeset init
  ```

- [ ] **2A.9** Update `.changeset/config.json` with configuration:
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

- [ ] **2A.10** Create test changeset to verify setup
  ```bash
  pnpm changeset
  # Select a package, choose "patch", describe as "test changeset"
  ```

- [ ] **2A.11** Verify changeset file created in `.changeset/*.md`

### Package.json Updates

- [ ] **2A.12** For each publishable package, verify/update package.json:
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
    ]
  }
  ```

- [ ] **2A.13** Commit changes
  ```bash
  git add .
  git commit -m "chore: configure changesets for npm publishing"
  git push origin develop
  ```

- [ ] **2A.14** Sync main with develop
  ```bash
  git checkout main
  git merge develop --ff-only
  git push origin main
  ```

---

## Phase 2B: Repository Preparation - Agency

**Estimated Time**: 45 minutes

### Branch Synchronization

- [ ] **2B.1** Clone agency repository
  ```bash
  git clone https://github.com/generacy-ai/agency.git
  cd agency
  ```

- [ ] **2B.2** Verify current branch state
  ```bash
  git fetch origin
  git log --oneline main..develop | wc -l
  # Should show ~111 commits
  ```

- [ ] **2B.3** Backup main branch
  ```bash
  git checkout main
  git branch main-backup-$(date +%Y%m%d)
  git push origin main-backup-$(date +%Y%m%d)
  ```

- [ ] **2B.4** Reset main to develop
  ```bash
  git checkout main
  git reset --hard origin/develop
  git push --force-with-lease origin main
  ```

- [ ] **2B.5** Verify synchronization
  ```bash
  git log main..develop
  git log develop..main
  ```

### Changesets Configuration

- [ ] **2B.6** Checkout develop
  ```bash
  git checkout develop
  git pull origin develop
  ```

- [ ] **2B.7** Verify changesets already installed (check root package.json)

- [ ] **2B.8** Update `.changeset/config.json` if needed:
  - Ensure `baseBranch: "develop"` (currently set to "main")
  - Ensure `access: "public"`

- [ ] **2B.9** Create test changeset
  ```bash
  pnpm changeset
  ```

### Package.json Updates

- [ ] **2B.10** For each publishable package, verify publishConfig

- [ ] **2B.11** Commit changes
  ```bash
  git add .
  git commit -m "chore: update changesets config for dual release streams"
  git push origin develop
  ```

- [ ] **2B.12** Sync main
  ```bash
  git checkout main
  git merge develop --ff-only
  git push origin main
  ```

---

## Phase 2C: Repository Preparation - Generacy

**Estimated Time**: 1 hour

### Branch Synchronization

- [ ] **2C.1** Clone generacy repository
  ```bash
  git clone https://github.com/generacy-ai/generacy.git
  cd generacy
  ```

- [ ] **2C.2** Verify current branch state
  ```bash
  git log --oneline main..develop | wc -l
  # Should show ~180 commits
  ```

- [ ] **2C.3** Backup main branch
  ```bash
  git checkout main
  git branch main-backup-$(date +%Y%m%d)
  git push origin main-backup-$(date +%Y%m%d)
  ```

- [ ] **2C.4** Reset main to develop
  ```bash
  git checkout main
  git reset --hard origin/develop
  git push --force-with-lease origin main
  ```

- [ ] **2C.5** Verify synchronization

### Changesets Setup

- [ ] **2C.6** Install and configure changesets (same as latency)

- [ ] **2C.7** Update package.json files

- [ ] **2C.8** Commit and sync
  ```bash
  git add .
  git commit -m "chore: configure changesets for npm publishing"
  git push origin develop
  git checkout main
  git merge develop --ff-only
  git push origin main
  ```

---

## Phase 3A: GitHub Actions - Latency

**Estimated Time**: 1.5 hours

### Create Workflows Directory

- [ ] **3A.1** Create `.github/workflows/` directory
  ```bash
  cd latency
  git checkout develop
  mkdir -p .github/workflows
  ```

### CI Workflow

- [ ] **3A.2** Create `.github/workflows/ci.yml`
- [ ] **3A.3** Copy CI template from workflow-templates.md
- [ ] **3A.4** Verify pnpm scripts exist: `lint`, `typecheck`, `test`, `build`
- [ ] **3A.5** Adjust script names if different

### Preview Publish Workflow

- [ ] **3A.6** Create `.github/workflows/publish-preview.yml`
- [ ] **3A.7** Copy Template 2A (latency) from workflow-templates.md
- [ ] **3A.8** Verify no placeholders remain

### Stable Release Workflow

- [ ] **3A.9** Create `.github/workflows/release.yml`
- [ ] **3A.10** Copy Template 3A (latency) from workflow-templates.md

### Commit Workflows

- [ ] **3A.11** Commit workflows
  ```bash
  git add .github/
  git commit -m "ci: add GitHub Actions workflows for npm publishing"
  git push origin develop
  ```

### Test CI Workflow

- [ ] **3A.12** Create test PR to develop
- [ ] **3A.13** Verify CI workflow runs
- [ ] **3A.14** Check all jobs pass (lint, typecheck, test, build)
- [ ] **3A.15** Merge test PR

---

## Phase 3B: GitHub Actions - Agency

**Estimated Time**: 1 hour

### Create Workflows

- [ ] **3B.1** Create workflows directory in agency
- [ ] **3B.2** Create `.github/workflows/ci.yml` (same as latency)
- [ ] **3B.3** Create `.github/workflows/publish-preview.yml`
  - Use Template 2B (agency with latency dependency check)
- [ ] **3B.4** Create `.github/workflows/release.yml`
  - Use Template 3B (agency with latency verification)

### Commit and Test

- [ ] **3B.5** Commit workflows
- [ ] **3B.6** Create and merge test PR
- [ ] **3B.7** Verify CI passes

---

## Phase 3C: GitHub Actions - Generacy

**Estimated Time**: 1 hour

### Create Workflows

- [ ] **3C.1** Create workflows directory in generacy
- [ ] **3C.2** Create `.github/workflows/ci.yml`
- [ ] **3C.3** Create `.github/workflows/publish-preview.yml`
  - Use Template 2C (generacy with all dependencies)
- [ ] **3C.4** Create `.github/workflows/release.yml`
  - Use Template 3C (generacy verification)

### Commit and Test

- [ ] **3C.5** Commit workflows
- [ ] **3C.6** Create and merge test PR
- [ ] **3C.7** Verify CI passes

---

## Phase 4: Branch Protection

**Estimated Time**: 30 minutes

### Latency Branch Protection

- [ ] **4.1** Navigate to https://github.com/generacy-ai/latency/settings/branches
- [ ] **4.2** Click "Add branch protection rule"
- [ ] **4.3** Branch name pattern: `main`
- [ ] **4.4** Enable "Require a pull request before merging"
  - [ ] Required approvals: 1
  - [ ] Dismiss stale reviews: ✅
- [ ] **4.5** Enable "Require status checks to pass"
  - [ ] Require branches to be up to date: ✅
  - [ ] Add status checks: `lint`, `test`, `build`
- [ ] **4.6** Enable "Require conversation resolution before merging"
- [ ] **4.7** Do not allow bypassing: ❌ (allow admins)
- [ ] **4.8** Save changes

### Agency Branch Protection

- [ ] **4.9** Repeat steps 4.1-4.8 for agency repository

### Generacy Branch Protection

- [ ] **4.10** Repeat steps 4.1-4.8 for generacy repository

### Verification

- [ ] **4.11** Attempt to push directly to main (should fail)
  ```bash
  # In any repo
  git checkout main
  echo "test" >> README.md
  git commit -am "test: verify branch protection"
  git push origin main
  # Should be rejected
  git reset --hard HEAD~1
  ```

---

## Phase 5: Documentation

**Estimated Time**: 2 hours

### Create PUBLISHING.md - Latency

- [ ] **5.1** Create `PUBLISHING.md` in latency repo root
- [ ] **5.2** Use template from plan.md Appendix
- [ ] **5.3** Customize with latency-specific examples
- [ ] **5.4** Add npm badge to README.md:
  ```markdown
  [![npm version](https://badge.fury.io/js/@generacy-ai%2Flatency.svg)](https://www.npmjs.com/package/@generacy-ai/latency)
  ```

### Create PUBLISHING.md - Agency

- [ ] **5.5** Create `PUBLISHING.md` in agency repo
- [ ] **5.6** Add note about latency dependency order
- [ ] **5.7** Add npm badges to README.md

### Create PUBLISHING.md - Generacy

- [ ] **5.8** Create `PUBLISHING.md` in generacy repo
- [ ] **5.9** Add note about full dependency chain
- [ ] **5.10** Add npm badges to README.md

### Update CONTRIBUTING.md

- [ ] **5.11** Update/create CONTRIBUTING.md in each repo
- [ ] **5.12** Add section on changesets workflow
- [ ] **5.13** Link to PUBLISHING.md

### Commit Documentation

- [ ] **5.14** Commit all documentation changes to develop
- [ ] **5.15** Create PR to main for each repo
- [ ] **5.16** Merge PRs

---

## Phase 6: Validation & Testing

**Estimated Time**: 2 hours

### Test 1: Preview Publish - Latency

- [ ] **6.1** Create test branch from develop
  ```bash
  cd latency
  git checkout develop
  git pull origin develop
  git checkout -b test/preview-publish
  ```

- [ ] **6.2** Make trivial change
  ```bash
  echo "# Test" >> README.md
  ```

- [ ] **6.3** Create changeset
  ```bash
  pnpm changeset
  # Select a package, "patch", describe as "test: preview publish"
  ```

- [ ] **6.4** Commit and push
  ```bash
  git add .
  git commit -m "test: verify preview publish workflow"
  git push origin test/preview-publish
  ```

- [ ] **6.5** Create PR to develop
- [ ] **6.6** Wait for CI to pass
- [ ] **6.7** Merge PR
- [ ] **6.8** Monitor `publish-preview` workflow
- [ ] **6.9** Verify publish succeeds
- [ ] **6.10** Check npm:
  ```bash
  npm view @generacy-ai/latency@preview
  # Should show preview version
  ```

- [ ] **6.11** Verify dist-tag:
  ```bash
  npm dist-tag ls @generacy-ai/latency
  # Should show preview: [version]
  ```

- [ ] **6.12** Verify PR comment created with published versions

### Test 2: Preview Publish - Agency

- [ ] **6.13** Repeat steps 6.1-6.12 for agency
- [ ] **6.14** Verify latency dependency check passes
- [ ] **6.15** Verify agency packages published

### Test 3: Preview Publish - Generacy

- [ ] **6.16** Repeat for generacy
- [ ] **6.17** Verify all dependency checks pass

### Test 4: Stable Release - Latency

- [ ] **6.18** Create PR from develop to main
  ```bash
  cd latency
  git checkout main
  git pull origin main
  git checkout -b release/test-stable
  git merge develop --no-ff
  git push origin release/test-stable
  ```

- [ ] **6.19** Create PR to main
- [ ] **6.20** Wait for CI (should pass, already tested on develop)
- [ ] **6.21** Merge PR
- [ ] **6.22** Monitor `release` workflow
- [ ] **6.23** Verify "Version Packages" PR is created
- [ ] **6.24** Review Version PR contents
  - [ ] package.json versions bumped
  - [ ] CHANGELOG.md updated
  - [ ] Changeset files removed
- [ ] **6.25** Merge Version PR
- [ ] **6.26** Verify publish succeeds
- [ ] **6.27** Check npm:
  ```bash
  npm view @generacy-ai/latency@latest
  # Should show stable version (e.g., 1.0.0)
  ```

- [ ] **6.28** Verify GitHub release created

### Test 5: Stable Release - Agency & Generacy

- [ ] **6.29** Repeat stable release test for agency
- [ ] **6.30** Repeat stable release test for generacy

### Test 6: Dependency Chain Verification

- [ ] **6.31** Attempt to publish agency without latency published (should fail)
- [ ] **6.32** Verify error message is clear
- [ ] **6.33** Publish latency first, then agency (should succeed)

### Test 7: Idempotency

- [ ] **6.34** Find a completed publish workflow
- [ ] **6.35** Re-run the workflow
- [ ] **6.36** Verify it completes successfully (handles "already published")

### Test 8: Failed Publish Recovery

- [ ] **6.37** Temporarily invalidate NPM_TOKEN (optional, risky)
- [ ] **6.38** Trigger publish, watch it fail
- [ ] **6.39** Restore valid token
- [ ] **6.40** Re-run workflow
- [ ] **6.41** Verify recovery

---

## Phase 7: Cleanup & Finalization

**Estimated Time**: 30 minutes

### Remove Test Artifacts

- [ ] **7.1** Delete test branches
- [ ] **7.2** Delete backup branches (if no longer needed)
- [ ] **7.3** Remove test changesets if any remain

### Final Verification

- [ ] **7.4** Verify all three packages on npm:
  - [ ] `npm info @generacy-ai/latency`
  - [ ] `npm info @generacy-ai/agency`
  - [ ] `npm info @generacy-ai/generacy`

- [ ] **7.5** Verify dist-tags configured:
  ```bash
  npm dist-tag ls @generacy-ai/latency
  npm dist-tag ls @generacy-ai/agency
  npm dist-tag ls @generacy-ai/generacy
  ```

- [ ] **7.6** Test installation as end-user:
  ```bash
  # Create test directory
  mkdir /tmp/test-install
  cd /tmp/test-install
  npm init -y

  # Install stable
  npm install @generacy-ai/latency

  # Install preview
  npm install @generacy-ai/latency@preview

  # Verify both work
  node -e "console.log(require('@generacy-ai/latency'))"
  ```

### Documentation Review

- [ ] **7.7** Review all PUBLISHING.md files for accuracy
- [ ] **7.8** Verify README badges are correct
- [ ] **7.9** Check CONTRIBUTING.md links work

### Team Communication

- [ ] **7.10** Announce npm publishing is live
- [ ] **7.11** Share PUBLISHING.md with team
- [ ] **7.12** Document any learnings or deviations from plan

---

## Success Criteria Checklist

### Organizational

- [ ] ✅ NPM_TOKEN configured and accessible in all repos
- [ ] ✅ All three repos have working CI workflows
- [ ] ✅ Branch protection enabled on main branches

### Technical

- [ ] ✅ Preview publishes work on merge to develop
- [ ] ✅ Stable releases work on merge to main via Version PR
- [ ] ✅ Dependency verification prevents broken publishes
- [ ] ✅ Workflows are idempotent (safe to re-run)

### Documentation

- [ ] ✅ PUBLISHING.md exists in all repos
- [ ] ✅ Maintainers understand changeset workflow
- [ ] ✅ Recovery procedures documented

### Validation

- [ ] ✅ At least one preview publish per repo
- [ ] ✅ At least one stable publish per repo
- [ ] ✅ Dependency chain tested (latency → agency → generacy)

### Acceptance Criteria (from spec)

- [ ] ✅ `npm info @generacy-ai/latency` returns package metadata
- [ ] ✅ Both `@preview` and `@latest` dist-tags functional

---

## Troubleshooting Reference

### If npm publish fails with 403

1. Check NPM_TOKEN exists: `gh secret list --org generacy-ai`
2. Verify token on npmjs.com → Access Tokens
3. Check token permissions (must have publish rights)
4. Regenerate token if needed
5. Update GitHub secret

### If changesets version doesn't generate preview format

1. Verify using `--snapshot preview` flag
2. Check changesets CLI version (`pnpm list @changesets/cli`)
3. Update if < 2.28.0: `pnpm add -D @changesets/cli@latest`

### If dependency verification fails

1. Check publish order: latency → agency → generacy
2. Verify dependency published: `npm view @generacy-ai/latency@preview`
3. Check network/npm registry availability
4. Verify package name/version in package.json

### If "Version Packages" PR not created

1. Check for pending changesets: `ls .changeset/*.md | grep -v README`
2. Run `pnpm changeset status` to see pending versions
3. Check workflow logs for errors
4. Verify GITHUB_TOKEN has `pull-requests: write` permission

---

## Post-Implementation

### Monitoring Setup

- [ ] Set up alerts for workflow failures
- [ ] Monitor npm download stats
- [ ] Track changeset adoption rate

### Regular Maintenance

- [ ] Schedule quarterly review of npm org members
- [ ] Set annual reminder for token rotation
- [ ] Update changesets/action when new versions available

### Next Steps

- [ ] Start Issue 1.2 - latency#31 (Full CI/CD for latency)
- [ ] Start Issue 1.3 - agency#292 (Full CI/CD for agency)
- [ ] Start Issue 1.4 - generacy#243 (Full CI/CD for generacy)

---

## Sign-Off

**Completed by**: _______________
**Date**: _______________
**Verified by**: _______________
**Date**: _______________

---

*Checklist version: 1.0*
*Feature: 242-1-1-set-up*
*Last updated: 2026-02-24*
