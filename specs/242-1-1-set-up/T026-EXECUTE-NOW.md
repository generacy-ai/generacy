# T026: Quick Execution Guide

**⚡ Fast track for enabling branch protection on agency/main**

## 🚀 Quick Start (30 seconds)

```bash
cd /workspaces/generacy/specs/242-1-1-set-up

# Run setup
./T026-setup-branch-protection.sh

# Verify
./T026-verify-protection.sh
```

## ✅ Success Indicators

**Setup script output should show**:
- ✅ Branch protection enabled for generacy-ai/agency/main
- ✓ All 8 protection rules configured

**Verification script output should show**:
- ✅ All protection rules are correctly configured!
- Exit code: 0

## 🔧 If Scripts Fail

### Authentication Required
```bash
gh auth login
```

### Permissions Issue
- You need admin access to generacy-ai/agency
- Contact repo owner to grant access

### Status Checks Not Available
The CI workflow must run at least once before status checks appear:
1. Go to: https://github.com/generacy-ai/agency/actions
2. Manually trigger the CI workflow, OR
3. Push any commit to develop
4. Wait for workflow to complete
5. Re-run setup script

## 🧪 Test Protection (1 minute)

```bash
cd /workspaces/tetrad-development/packages/agency
git checkout main
git pull

# This should FAIL (proving protection works)
echo "test" >> README.md
git add README.md
git commit -m "test: direct push"
git push origin main
# Expected: "remote: error: GH006: Protected branch update failed"

# Clean up
git reset HEAD~1
git checkout README.md
```

## 📋 Manual Alternative

If scripts fail, use GitHub UI:
1. Go to: https://github.com/generacy-ai/agency/settings/branches
2. Click "Add branch protection rule"
3. Branch pattern: `main`
4. Enable settings (see T026-INSTRUCTIONS.md for details)
5. Add required status checks: `lint`, `test`, `build`
6. Save

## 📖 Full Documentation

- **Detailed instructions**: T026-INSTRUCTIONS.md
- **Script source**: T026-setup-branch-protection.sh
- **Verification script**: T026-verify-protection.sh
- **Completion report**: T026-COMPLETION.md (create after completion)

## Next Steps

After T026 completes:
- [ ] Document completion in T026-COMPLETION.md
- [ ] Mark T026 as [DONE] in tasks.md
- [ ] Proceed to T027 (generacy/main branch protection)
