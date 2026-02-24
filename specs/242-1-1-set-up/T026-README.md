# T026: Enable Branch Protection for agency/main

> **Repository**: generacy-ai/agency
> **Branch**: main
> **Status**: Ready for execution
> **Task Type**: Manual (GitHub configuration)

## 📖 Overview

This task configures GitHub branch protection rules for the `main` branch of the `generacy-ai/agency` repository. Branch protection ensures code quality by requiring pull requests, code reviews, and passing CI checks before any code can be merged to the stable release branch.

## 🎯 Objectives

1. ✅ Prevent direct pushes to `main` branch
2. ✅ Require at least 1 code review approval before merging
3. ✅ Enforce CI checks (lint, test, build) to pass
4. ✅ Require all PR conversations to be resolved
5. ✅ Block force pushes and branch deletions
6. ✅ Allow admin bypass for emergency fixes

## 🚀 Quick Start

Choose your path:

### Path A: Automated (Recommended) ⚡

```bash
cd /workspaces/generacy/specs/242-1-1-set-up

# Setup branch protection
./T026-setup-branch-protection.sh

# Verify configuration
./T026-verify-protection.sh
```

**Time**: ~2 minutes

### Path B: Manual Setup 🖱️

1. Open [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md) for quick guide
2. Or [T026-INSTRUCTIONS.md](./T026-INSTRUCTIONS.md) for detailed steps
3. Configure via GitHub UI at: https://github.com/generacy-ai/agency/settings/branches

**Time**: ~5 minutes

## 📁 Documentation Files

| File | What's Inside |
|------|---------------|
| **T026-README.md** | ← You are here - Start here for overview |
| **T026-SUMMARY.md** | Quick reference card with key info |
| **T026-EXECUTE-NOW.md** | 30-second quick start guide |
| **T026-INSTRUCTIONS.md** | Comprehensive setup guide (automated + manual) |
| **T026-setup-branch-protection.sh** | Automated setup script (via GitHub API) |
| **T026-verify-protection.sh** | Verification script with detailed checks |
| **T026-COMPLETION-TEMPLATE.md** | Template for documenting completion |

## 🔗 Links

### GitHub
- [agency repository](https://github.com/generacy-ai/agency)
- [Branch protection settings](https://github.com/generacy-ai/agency/settings/branches)
- [CI workflow](https://github.com/generacy-ai/agency/blob/develop/.github/workflows/ci.yml)
- [Release workflow](https://github.com/generacy-ai/agency/blob/develop/.github/workflows/release.yml)

### Related Tasks
- **T020**: [DONE] Create stable release workflow for agency
- **T012**: [DONE] Create CI workflow for agency
- **T025**: [DONE] Enable branch protection for latency/main
- **T027**: [Next] Enable branch protection for generacy/main

## 📋 Prerequisites

Before running this task, ensure:

- [x] T020 completed (release.yml workflow exists)
- [x] T012 completed (ci.yml workflow exists and has run at least once)
- [x] GitHub admin access to generacy-ai/agency
- [x] `gh` CLI installed and authenticated
- [x] `jq` installed (for verification script)

### Check Prerequisites

```bash
# Check gh CLI
gh --version

# Check authentication
gh auth status

# Check jq
jq --version

# Check if you have admin access
gh api /repos/generacy-ai/agency --jq '.permissions.admin'
# Should output: true
```

## 🔧 What Gets Configured

### Branch Protection Rules

| Rule | Setting | Purpose |
|------|---------|---------|
| **Pull Request** | Required | Force code review process |
| **Approvals** | 1 minimum | Ensure human oversight |
| **Dismiss Stale Reviews** | Enabled | Re-review after changes |
| **Status Checks** | lint, test, build | Enforce CI passing |
| **Up-to-date Branches** | Required | Prevent merge conflicts |
| **Conversation Resolution** | Required | Address all feedback |
| **Admin Bypass** | Allowed | Emergency fixes possible |
| **Force Push** | Blocked | Protect git history |
| **Branch Deletion** | Blocked | Prevent accidents |

### Status Checks Required

The following CI jobs must pass before merging:
- ✅ `lint` - Code linting and formatting
- ✅ `test` - Unit and integration tests
- ✅ `build` - Package build validation

These jobs are defined in `.github/workflows/ci.yml`.

## 🧪 Testing

After configuration, verify with:

```bash
# 1. Verify via script
./T026-verify-protection.sh

# 2. Test direct push (should fail)
cd /workspaces/tetrad-development/packages/agency
git checkout main
echo "test" >> README.md
git add README.md
git commit -m "test: direct push"
git push origin main
# Expected: Push rejected with protection error

# Clean up
git reset HEAD~1
git checkout README.md
```

## 📊 Protection Settings Details

### API Configuration

The setup script uses GitHub API to configure:

```json
{
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "required_status_checks": {
    "strict": true,
    "checks": [
      {"context": "lint"},
      {"context": "test"},
      {"context": "build"}
    ]
  },
  "enforce_admins": false,
  "required_conversation_resolution": {
    "enabled": true
  },
  "allow_force_pushes": {
    "enabled": false
  },
  "allow_deletions": {
    "enabled": false
  }
}
```

## ⚠️ Troubleshooting

### Status Checks Not Available

**Problem**: The required checks (lint, test, build) don't appear in the dropdown.

**Solution**: Status checks only appear after the workflow runs at least once.

```bash
# Trigger CI workflow
cd /workspaces/tetrad-development/packages/agency
git checkout develop
git commit --allow-empty -m "chore: trigger CI"
git push origin develop

# Wait for workflow to complete, then re-run setup
```

### Permission Denied

**Problem**: `gh api` returns 403 Forbidden or "Resource not accessible by integration"

**Solution**: Ensure you have admin access to the repository.

```bash
# Check your permissions
gh api /repos/generacy-ai/agency --jq '.permissions'

# If not admin, contact repository owner
```

### Authentication Failed

**Problem**: `gh` CLI not authenticated.

**Solution**: Authenticate with GitHub.

```bash
gh auth login
# Follow prompts to authenticate
```

## 🎓 What You'll Learn

By completing this task, you'll understand:

1. **GitHub Branch Protection**: How to protect critical branches
2. **Required Status Checks**: How to enforce CI/CD quality gates
3. **Code Review Process**: How to require approvals before merge
4. **GitHub API**: How to automate repository configuration
5. **Testing Protection Rules**: How to verify configuration works

## ✅ Completion Checklist

When done, verify all of these:

- [ ] Setup script executed successfully
- [ ] Verification script shows all checks passing
- [ ] GitHub UI confirms protection rules are active
- [ ] Direct push to main is blocked (tested)
- [ ] PR workflow requires approval and status checks
- [ ] Completed T026-COMPLETION.md from template
- [ ] Updated tasks.md to mark T026 as [DONE]

## 📝 Documentation After Completion

After running the setup:

1. **Copy the completion template**:
   ```bash
   cp T026-COMPLETION-TEMPLATE.md T026-COMPLETION.md
   ```

2. **Fill in the completion report**:
   - Execution method used
   - Script outputs
   - Test results
   - Any issues encountered

3. **Update tasks.md**:
   ```bash
   # Change line 465 from:
   ### T026 [US1] Enable branch protection for agency/main

   # To:
   ### T026 [DONE] [US1] Enable branch protection for agency/main
   ```

## 🔜 Next Steps

After T026 is complete:

1. **T027**: Enable branch protection for generacy/main
   - Similar process for the generacy repository
   - Can reuse scripts with repo name changed

2. **T038**: Test preview publish for agency
   - Requires T026 to be complete
   - Tests the full preview release workflow with branch protection

3. **T041**: Test stable release for agency
   - Requires T026 and T020
   - Tests the full stable release workflow with branch protection

## 💡 Pro Tips

1. **Status Checks First**: Always ensure CI workflow has run at least once before adding status checks to branch protection
2. **Test Immediately**: Test that direct push fails right after setup to confirm protection works
3. **Keep Scripts**: These scripts can be reused for other branches or repositories
4. **Document Issues**: Use the completion template to record any problems for future reference
5. **Admin Bypass**: The admin bypass is intentionally enabled for emergency fixes, but should be used sparingly

## 🤝 Getting Help

If you encounter issues:

1. Check [T026-INSTRUCTIONS.md](./T026-INSTRUCTIONS.md) troubleshooting section
2. Review [GitHub Branch Protection Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
3. Check script output for specific error messages
4. Verify prerequisites are met (auth, permissions, jq installed)

## 📚 Additional Resources

- [GitHub Branch Protection Documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Status Checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)
- [GitHub CLI Manual](https://cli.github.com/manual/)
- [Changesets Release Action](https://github.com/changesets/action)

---

**Ready to start?** Jump to [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md) for the fastest path to completion! ⚡
