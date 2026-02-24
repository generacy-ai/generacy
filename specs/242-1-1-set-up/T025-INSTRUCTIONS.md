# T025: Enable Branch Protection for latency/main

**Status**: Ready to Execute
**Type**: Manual Configuration
**Repository**: generacy-ai/latency
**Branch**: main
**Depends on**: T019 (stable release workflow)

## Overview

This task configures branch protection rules for the `main` branch in the latency repository to ensure code quality and prevent accidental direct pushes.

## Prerequisites

- [ ] T019 completed (stable release workflow created)
- [ ] Access to generacy-ai/latency repository with admin permissions
- [ ] CI workflow exists with `lint`, `test`, and `build` jobs

## Instructions

### Step 1: Navigate to Branch Protection Settings

1. Open your browser and navigate to:
   ```
   https://github.com/generacy-ai/latency/settings/branches
   ```

2. Click **"Add branch protection rule"** (or **"Add rule"**)

### Step 2: Configure Protection Rule

#### Basic Settings

- **Branch name pattern**: `main`

#### Pull Request Requirements

- ✅ **Require a pull request before merging**
  - ✅ **Require approvals**: Set to `1`
  - ✅ **Dismiss stale pull request approvals when new commits are pushed**
  - ⬜ **Require review from Code Owners** (leave unchecked unless CODEOWNERS file exists)

#### Status Checks

- ✅ **Require status checks to pass before merging**
  - ✅ **Require branches to be up to date before merging**
  - **Status checks that are required**: Add the following checks:
    - `lint`
    - `test`
    - `build`

  > **Note**: These status checks must have run at least once for them to appear in the dropdown. If they don't appear, you may need to trigger the CI workflow first.

#### Additional Rules

- ✅ **Require conversation resolution before merging**
- ⬜ **Require signed commits** (optional, leave unchecked for now)
- ⬜ **Require linear history** (leave unchecked to allow merge commits)
- ⬜ **Include administrators** (leave unchecked to allow admins to bypass for emergencies)

#### Force Push and Deletion

- ✅ **Do not allow bypassing the above settings**
- ✅ **Allow force pushes** → **Specify who can force push** → Select **"Do not allow force pushes"**
- ✅ **Allow deletions** → Leave unchecked (do not allow)

### Step 3: Save Changes

1. Scroll to the bottom of the page
2. Click **"Create"** (or **"Save changes"** if editing existing rule)

## Verification

After saving, verify the protection is active:

### Method 1: GitHub Web UI

1. Go to https://github.com/generacy-ai/latency
2. Click on the **"main"** branch dropdown
3. You should see a shield icon next to the `main` branch indicating protection is enabled

### Method 2: GitHub CLI

Run the verification script:

```bash
./T025-verify-protection.sh
```

Or manually check:

```bash
gh api /repos/generacy-ai/latency/branches/main/protection | jq '{
  required_pull_request_reviews: .required_pull_request_reviews,
  required_status_checks: .required_status_checks,
  enforce_admins: .enforce_admins,
  restrictions: .restrictions,
  allow_force_pushes: .allow_force_pushes
}'
```

### Method 3: Test Direct Push (Should Fail)

This test confirms that direct pushes are blocked:

```bash
# In the latency repository
cd /workspaces/tetrad-development/packages/latency

# Try to push directly to main (this should fail)
git checkout main
echo "# Test" >> .test-protection
git add .test-protection
git commit -m "test: verify branch protection"
git push origin main
# Expected: Remote will reject the push with an error about requiring a pull request

# Clean up the test
git reset --hard HEAD~1
rm -f .test-protection
```

**Expected error message**:
```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: error: Changes must be made through a pull request.
```

## Expected Configuration Summary

Once complete, the `main` branch should have:

| Setting | Value |
|---------|-------|
| Require pull request | ✅ Yes |
| Required approvals | 1 |
| Dismiss stale reviews | ✅ Yes |
| Require status checks | ✅ Yes (lint, test, build) |
| Require up-to-date branches | ✅ Yes |
| Require conversation resolution | ✅ Yes |
| Allow admins to bypass | ✅ Yes |
| Allow force pushes | ❌ No |
| Allow deletions | ❌ No |

## Troubleshooting

### Status checks not appearing in dropdown

**Cause**: Status checks only appear after they've run at least once on the branch.

**Solution**:
1. Create a test PR to `main` from any branch
2. Wait for CI to run and create the status check contexts
3. Close the test PR without merging
4. Return to branch protection settings and add the checks

### Can't access settings page

**Cause**: Insufficient permissions on the repository.

**Solution**: Contact a repository admin to either:
- Grant you admin access, or
- Apply the branch protection settings on your behalf

### Changes not taking effect

**Cause**: Settings may need a few moments to propagate.

**Solution**: Wait 1-2 minutes and try the verification steps again.

## Related Tasks

- **T026**: Enable branch protection for agency/main (same settings)
- **T027**: Enable branch protection for generacy/main (same settings)
- **T019**: Stable release workflow (dependency)

## Completion Criteria

- [ ] Branch protection rule created for `main`
- [ ] All required settings configured as specified
- [ ] Verification test passes (direct push blocked)
- [ ] Documentation updated in T025-COMPLETION.md

## Next Steps

After completing this task:

1. Document completion in `T025-COMPLETION.md`
2. Proceed to T026 (agency branch protection)
3. Proceed to T027 (generacy branch protection)

---

**Note**: These same instructions can be adapted for T026 and T027 by replacing the repository name.
