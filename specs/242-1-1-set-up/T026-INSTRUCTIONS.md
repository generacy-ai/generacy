# T026: Enable Branch Protection for agency/main

**Task ID**: T026
**Repository**: generacy-ai/agency
**Branch**: main
**Status**: Ready for execution
**Depends on**: T020 (Stable release workflow for agency)

## Overview

This task configures branch protection rules for the `main` branch of the `generacy-ai/agency` repository to ensure code quality, prevent accidental direct pushes, and require code reviews before merging.

## Prerequisites

- [ ] T020 completed (stable release workflow exists)
- [ ] GitHub admin access to generacy-ai/agency repository
- [ ] `gh` CLI installed and authenticated
- [ ] `jq` installed (for verification script)

## Option 1: Automated Setup (Recommended)

### Step 1: Make scripts executable

```bash
cd /workspaces/generacy/specs/242-1-1-set-up
chmod +x T026-setup-branch-protection.sh
chmod +x T026-verify-protection.sh
```

### Step 2: Run setup script

```bash
./T026-setup-branch-protection.sh
```

Expected output:
```
🔒 Setting up branch protection for generacy-ai/agency/main...
✅ Branch protection enabled for generacy-ai/agency/main

Protection rules configured:
  ✓ Require pull request before merging
  ✓ Require 1 approval
  ✓ Dismiss stale reviews on push
  ✓ Require status checks to pass (lint, test, build)
  ✓ Require branches to be up to date
  ✓ Require conversation resolution
  ✓ Restrict force pushes
  ✓ Allow admins to bypass (for emergency fixes)
```

### Step 3: Verify configuration

```bash
./T026-verify-protection.sh
```

Expected output:
```
🔍 Verifying branch protection for generacy-ai/agency/main...

✅ Branch protection is enabled

📋 Protection Rules:

  ✅ Pull request required
     - Required approvals: 1
     - Dismiss stale reviews: true
  ✅ Status checks required
     - Require up-to-date branches: true
     - Required checks: lint,test,build
     ✅ All expected checks configured (lint, test, build)
  ✅ Conversation resolution required
  ℹ️  Enforce for administrators: false
  ✅ Force pushes blocked
  ✅ Branch deletions blocked

📊 Overall Status:

✅ All protection rules are correctly configured!

Branch protection for generacy-ai/agency/main meets all requirements.
```

## Option 2: Manual Setup via GitHub UI

### Step 1: Navigate to repository settings

1. Go to: https://github.com/generacy-ai/agency/settings/branches
2. Click "Add branch protection rule"

### Step 2: Configure protection rule

**Branch name pattern**: `main`

**Protect matching branches**:

- [x] **Require a pull request before merging**
  - Required approvals: `1`
  - [x] Dismiss stale pull request approvals when new commits are pushed
  - [ ] Require review from Code Owners (leave unchecked)

- [x] **Require status checks to pass before merging**
  - [x] Require branches to be up to date before merging
  - **Required status checks**: Add these three checks:
    - `lint`
    - `test`
    - `build`

  *Note*: These checks must exist in your CI workflow (`.github/workflows/ci.yml`) for them to appear in the list.

- [x] **Require conversation resolution before merging**

- [ ] **Require signed commits** (leave unchecked)

- [ ] **Require linear history** (leave unchecked)

- [ ] **Require deployments to succeed before merging** (leave unchecked)

- [ ] **Lock branch** (leave unchecked)

- [ ] **Do not allow bypassing the above settings**
  - Leave unchecked to allow admins to bypass (recommended for emergency fixes)

- [x] **Restrict who can push to matching branches** (indirectly enforced by PR requirement)
  - Do not add specific users/teams (leave default)

**Rules applied to everyone including administrators**:

- [x] **Restrict force pushes**
  - Select: "Restrict"

- [x] **Allow deletions**
  - Leave unchecked (to block deletions)

### Step 3: Save changes

Click "Create" or "Save changes" at the bottom of the page.

## Step 4: Test Protection Rules

### Test 1: Attempt direct push to main (should fail)

```bash
# Navigate to agency repo
cd /workspaces/tetrad-development/packages/agency

# Ensure you're on main branch
git checkout main
git pull origin main

# Make a test change
echo "# Test" >> README.md

# Try to commit and push directly
git add README.md
git commit -m "test: attempt direct push to main"
git push origin main
```

**Expected result**:
```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: error: Changes must be made through a pull request.
To github.com:generacy-ai/agency.git
 ! [remote rejected] main -> main (protected branch hook declined)
error: failed to push some refs to 'github.com:generacy-ai/agency.git'
```

If this happens, the protection is working correctly. Clean up:

```bash
git reset HEAD~1
git checkout README.md
```

### Test 2: Verify PR workflow

```bash
# Create a test branch
git checkout -b test/branch-protection-verification

# Make a small change
echo "" >> README.md

# Commit and push
git add README.md
git commit -m "test: verify branch protection"
git push origin test/branch-protection-verification

# Create PR (this should work)
gh pr create --title "test: verify branch protection" --body "Testing branch protection rules" --base main
```

**Expected result**: PR is created successfully, but cannot be merged until:
- CI checks (lint, test, build) pass
- At least 1 approval is received
- Branch is up to date with main
- All conversations are resolved

Close the test PR after verification:

```bash
gh pr close --delete-branch
```

## Branch Protection Rules Summary

| Rule | Setting | Purpose |
|------|---------|---------|
| **PR Required** | ✅ Yes | Prevent direct pushes to main |
| **Approvals** | 1 | Require code review |
| **Dismiss Stale** | ✅ Yes | Re-review after changes |
| **Status Checks** | lint, test, build | Ensure CI passes |
| **Up-to-date** | ✅ Yes | Prevent merge conflicts |
| **Conversation Resolution** | ✅ Yes | Address all review comments |
| **Admin Bypass** | ✅ Allowed | Emergency fixes possible |
| **Force Push** | ❌ Blocked | Protect commit history |
| **Branch Deletion** | ❌ Blocked | Prevent accidental deletion |

## Required CI Jobs

The following jobs must be defined in `.github/workflows/ci.yml`:

```yaml
jobs:
  lint:
    name: lint
    # ... job definition

  test:
    name: test
    # ... job definition

  build:
    name: build
    # ... job definition
```

*Note*: The job names must exactly match the status check names configured in branch protection.

## Troubleshooting

### Status checks not appearing

**Problem**: The required checks (lint, test, build) don't appear in the status checks list.

**Solution**:
1. Ensure `.github/workflows/ci.yml` exists and defines these jobs
2. Push a commit to any branch to trigger the workflow
3. Wait for the workflow to run at least once
4. Return to branch protection settings and the checks should now appear

### Cannot bypass as admin

**Problem**: Even as admin, you can't push to main.

**Solution**: Check "Do not allow bypassing the above settings" is **unchecked** in branch protection rules.

### Checks required but workflow doesn't exist

**Problem**: Branch protection requires status checks but CI workflow wasn't created yet.

**Solution**:
1. First complete T012 (Create CI workflow for agency)
2. Then configure branch protection
3. Or temporarily remove required status checks until workflow is ready

## Completion Checklist

- [ ] Branch protection rule created for `main`
- [ ] All required settings configured (see summary table)
- [ ] Status checks (lint, test, build) added as required
- [ ] Direct push to main fails (tested)
- [ ] PR workflow succeeds (tested)
- [ ] Verification script passes
- [ ] Documentation updated in T026-COMPLETION.md

## Related Tasks

- **T020**: Create stable release workflow for agency (prerequisite)
- **T012**: Create CI workflow for agency (CI jobs must exist)
- **T025**: Enable branch protection for latency/main (parallel task)
- **T027**: Enable branch protection for generacy/main (next task)

## References

- [GitHub Branch Protection Documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Status Checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)
- [GitHub CLI Branch Protection](https://cli.github.com/manual/gh_api)

## Notes

- This configuration allows administrators to bypass protection rules for emergency fixes
- The `@changesets/action` bot needs write permissions to create "Version Packages" PRs - this is handled by GITHUB_TOKEN in the workflow, not by branch protection
- If you need to update protection rules later, you can re-run the setup script or use the GitHub UI
