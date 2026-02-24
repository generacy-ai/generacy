# T025: Enable Branch Protection for latency/main

## Quick Start

1. **Read**: [T025-QUICK-REFERENCE.md](./T025-QUICK-REFERENCE.md) - One-page setup guide
2. **Execute**: [T025-INSTRUCTIONS.md](./T025-INSTRUCTIONS.md) - Detailed step-by-step instructions
3. **Verify**: Run `./T025-verify-protection.sh` - Automated verification
4. **Document**: Fill out [T025-COMPLETION-TEMPLATE.md](./T025-COMPLETION-TEMPLATE.md) when done

## Task Overview

**Objective**: Configure branch protection rules for the `main` branch in the latency repository to ensure code quality and prevent accidental direct pushes.

**Type**: Manual GitHub configuration task

**Dependencies**:
- T019 (stable release workflow must be created first)

**Estimated Time**: 10-15 minutes

## Why This Matters

Branch protection ensures:
- All changes go through pull request review
- CI tests pass before merging
- No accidental force pushes or deletions
- Consistent quality standards for stable releases

The `main` branch is the stable release branch. Only version PRs from changesets should merge to it.

## Files in This Task

| File | Purpose |
|------|---------|
| `T025-README.md` | This file - overview and navigation |
| `T025-QUICK-REFERENCE.md` | One-page configuration matrix |
| `T025-INSTRUCTIONS.md` | Detailed step-by-step setup guide |
| `T025-verify-protection.sh` | Automated verification script |
| `T025-setup-branch-protection.sh` | API automation (requires elevated permissions) |
| `T025-COMPLETION-TEMPLATE.md` | Documentation template for completion |

## Workflow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Verify Prerequisites                                      │
│    - T019 complete                                           │
│    - CI workflow exists                                      │
│    - Admin access confirmed                                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Configure Protection Rules                                │
│    - Navigate to GitHub Settings → Branches                  │
│    - Add protection rule for 'main'                          │
│    - Apply all settings from QUICK-REFERENCE.md              │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Verify Configuration                                      │
│    - Run ./T025-verify-protection.sh                         │
│    - Check for shield icon in GitHub UI                      │
│    - Test direct push (should fail)                          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Document Completion                                       │
│    - Fill out T025-COMPLETION-TEMPLATE.md                    │
│    - Rename to T025-COMPLETION.md                            │
│    - Proceed to T026 (agency) and T027 (generacy)            │
└─────────────────────────────────────────────────────────────┘
```

## Expected Protection Settings

The following protection rules will be configured:

### Pull Request Requirements
- ✅ Require pull request before merging
- ✅ Require 1 approval
- ✅ Dismiss stale reviews when new commits are pushed

### Status Checks
- ✅ Require status checks to pass: `lint`, `test`, `build`
- ✅ Require branches to be up to date before merging

### Additional Rules
- ✅ Require conversation resolution
- ✅ Block force pushes
- ✅ Block deletions
- ✅ Allow administrators to bypass (for emergency fixes)

## Common Commands

### Check current status
```bash
gh api /repos/generacy-ai/latency/branches/main/protection
```

### Run verification script
```bash
cd /workspaces/generacy/specs/242-1-1-set-up
./T025-verify-protection.sh
```

### Test protection (should fail)
```bash
cd /workspaces/tetrad-development/packages/latency
git checkout main
git commit --allow-empty -m "test: branch protection"
git push origin main
# Expected: remote: error: GH006: Protected branch update failed
```

## Next Steps

After completing T025:

1. **T026**: Apply identical settings to `generacy-ai/agency`
2. **T027**: Apply identical settings to `generacy-ai/generacy`
3. **T028+**: Proceed to documentation phase

## Troubleshooting

### Issue: Status checks not showing in dropdown

**Cause**: Status checks must run at least once before they appear.

**Solution**:
1. Trigger CI workflow manually or create a test PR
2. Wait for workflow to complete
3. Return to branch protection settings

### Issue: "Resource not accessible" error

**Cause**: GitHub API requires admin token for branch protection.

**Solution**: Use the web UI method described in INSTRUCTIONS.md

### Issue: Protection not working immediately

**Cause**: Settings take 1-2 minutes to propagate.

**Solution**: Wait and retry verification.

## Related Documentation

- [GitHub Branch Protection Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) - Issue 1.1

---

**Last Updated**: 2026-02-24
**Task ID**: T025
**Feature**: 242-1-1-set-up (npm publishing setup)
