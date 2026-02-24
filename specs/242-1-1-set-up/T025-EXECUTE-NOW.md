# ⚡ T025: Execute Branch Protection Setup

**Ready to configure branch protection? Start here.**

## 🎯 What You're About to Do

Configure GitHub branch protection rules for `generacy-ai/latency` repository's `main` branch to ensure:
- All changes require PR approval
- CI tests must pass (lint, test, build)
- No direct pushes or force pushes
- Stable release quality control

**Time Required**: 10-15 minutes

---

## ✅ Prerequisites Check

Before starting, verify:

- [ ] You have **admin access** to generacy-ai/latency repository
- [ ] T019 is complete (stable release workflow exists)
- [ ] CI workflow has run at least once (creates status check contexts)

> **Don't have admin access?** Contact a repository administrator to either grant access or perform this task on your behalf.

---

## 🚀 Quick Start (3 Steps)

### Step 1: Navigate to Settings

Open this URL in your browser:
```
https://github.com/generacy-ai/latency/settings/branches
```

Click **"Add branch protection rule"**

### Step 2: Apply Configuration

Copy these settings exactly:

| Setting | Value |
|---------|-------|
| Branch name pattern | `main` |
| ✅ Require pull request before merging | |
| ├─ Required approvals | `1` |
| └─ Dismiss stale reviews | ✅ |
| ✅ Require status checks | |
| ├─ Require branches up to date | ✅ |
| └─ Add checks | `lint`, `test`, `build` |
| ✅ Require conversation resolution | |
| ⬜ Include administrators | (leave unchecked) |
| ✅ Restrict force pushes | |

> **Tip**: See `T025-QUICK-REFERENCE.md` for visual configuration matrix

### Step 3: Verify & Test

Run verification script:
```bash
cd /workspaces/generacy/specs/242-1-1-set-up
./T025-verify-protection.sh
```

Expected output: ✅ All checks pass

---

## 📋 Detailed Instructions

If you need step-by-step guidance with screenshots and explanations:

👉 **See**: `T025-INSTRUCTIONS.md`

---

## 🔍 Troubleshooting

### Issue: Status checks not appearing

**Symptom**: The `lint`, `test`, `build` checks don't show in the dropdown

**Cause**: Status checks only appear after running at least once

**Fix**:
1. Create a test PR to trigger CI
2. Wait for workflow to complete
3. Return to branch protection settings
4. The checks should now be visible

### Issue: Can't access settings page

**Symptom**: 404 error or "You must be an admin" message

**Cause**: Insufficient repository permissions

**Fix**: Request admin access from repository owner

### Issue: Protection not blocking pushes

**Symptom**: Can still push directly to main after setup

**Cause**: Settings take 1-2 minutes to propagate

**Fix**: Wait 2 minutes and try again

---

## ✨ After Setup

1. **Document Completion**
   ```bash
   cp T025-COMPLETION-TEMPLATE.md T025-COMPLETION.md
   # Fill in the completion details
   ```

2. **Replicate to Other Repos**
   - T026: Apply same settings to `generacy-ai/agency`
   - T027: Apply same settings to `generacy-ai/generacy`

3. **Test the Protection**
   ```bash
   cd /workspaces/tetrad-development/packages/latency
   git checkout main
   git commit --allow-empty -m "test: branch protection"
   git push origin main
   # Should fail with: "Changes must be made through a pull request"
   ```

---

## 📚 Reference Files

| File | Purpose | When to Use |
|------|---------|-------------|
| **T025-EXECUTE-NOW.md** | This file | Starting point |
| `T025-QUICK-REFERENCE.md` | One-page config matrix | During setup |
| `T025-INSTRUCTIONS.md` | Detailed guide | If confused |
| `T025-verify-protection.sh` | Verification script | After setup |
| `T025-COMPLETION-TEMPLATE.md` | Documentation template | Recording completion |
| `T025-README.md` | Task overview | Understanding context |

---

## 🎯 Success Criteria

You're done when:

- ✅ Verification script exits 0 (all checks pass)
- ✅ Shield icon appears next to `main` branch in GitHub
- ✅ Direct push to `main` is blocked
- ✅ `T025-COMPLETION.md` created and filled out

---

## 🆘 Need Help?

1. **Check**: `T025-INSTRUCTIONS.md` for detailed guidance
2. **Run**: `./T025-verify-protection.sh` for diagnostic output
3. **Review**: GitHub's [branch protection documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)

---

## ⏱️ Time Estimate

| Activity | Time |
|----------|------|
| Navigate to settings | 1 min |
| Configure protection | 5 min |
| Run verification | 2 min |
| Test protection | 2 min |
| Document completion | 5 min |
| **Total** | **~15 min** |

---

**Ready?** Open the URL and start configuring! ⬆️

```
https://github.com/generacy-ai/latency/settings/branches
```

---

**Task**: T025
**Repository**: generacy-ai/latency
**Branch**: main
**Feature**: 242-1-1-set-up
