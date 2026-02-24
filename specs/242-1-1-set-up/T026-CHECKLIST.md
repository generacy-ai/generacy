# T026 Quick Checklist

**Task**: Enable branch protection for agency/main
**Repo**: generacy-ai/agency

---

## ✅ Pre-Execution Checklist

- [ ] T020 completed (stable release workflow exists)
- [ ] T012 completed (CI workflow exists and has run)
- [ ] GitHub admin access to generacy-ai/agency
- [ ] `gh` CLI installed: `gh --version`
- [ ] `gh` CLI authenticated: `gh auth status`
- [ ] `jq` installed: `jq --version`
- [ ] Read [T026-README.md](./T026-README.md) or [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md)

---

## ⚡ Execution Checklist

### Option A: Automated (Recommended)

- [ ] Navigate to feature directory: `cd /workspaces/generacy/specs/242-1-1-set-up`
- [ ] Make scripts executable: `chmod +x T026-*.sh` (already done)
- [ ] Run setup: `./T026-setup-branch-protection.sh`
- [ ] Check output shows "✅ Branch protection enabled"
- [ ] Run verification: `./T026-verify-protection.sh`
- [ ] Check output shows "✅ All protection rules are correctly configured!"

### Option B: Manual (GitHub UI)

- [ ] Open https://github.com/generacy-ai/agency/settings/branches
- [ ] Click "Add branch protection rule"
- [ ] Branch pattern: `main`
- [ ] Enable: Require pull request before merging
- [ ] Set: Required approvals: `1`
- [ ] Enable: Dismiss stale reviews
- [ ] Enable: Require status checks to pass
- [ ] Add checks: `lint`, `test`, `build`
- [ ] Enable: Require branches to be up to date
- [ ] Enable: Require conversation resolution
- [ ] Disable: Do not allow bypassing (allow admin bypass)
- [ ] Enable: Restrict force pushes
- [ ] Disable: Allow deletions
- [ ] Click "Create" or "Save"
- [ ] Run verification: `./T026-verify-protection.sh`

---

## 🧪 Testing Checklist

- [ ] Test 1: Direct push blocked
  - [ ] `cd /workspaces/tetrad-development/packages/agency`
  - [ ] `git checkout main`
  - [ ] `git pull origin main`
  - [ ] `echo "test" >> README.md`
  - [ ] `git add README.md`
  - [ ] `git commit -m "test: direct push"`
  - [ ] `git push origin main` → Should FAIL with "protected branch" error
  - [ ] `git reset HEAD~1` (cleanup)
  - [ ] `git checkout README.md` (cleanup)

- [ ] Test 2: PR workflow succeeds (optional)
  - [ ] Create test branch: `git checkout -b test/branch-protection`
  - [ ] Make change: `echo "" >> README.md`
  - [ ] Commit: `git commit -am "test: branch protection"`
  - [ ] Push: `git push origin test/branch-protection`
  - [ ] Create PR: `gh pr create --base main --title "test" --body "test"`
  - [ ] Verify PR created successfully
  - [ ] Close test PR: `gh pr close --delete-branch`

---

## 📝 Documentation Checklist

- [ ] Copy template: `cp T026-COMPLETION-TEMPLATE.md T026-COMPLETION.md`
- [ ] Fill in completion report:
  - [ ] Date and executor
  - [ ] Method used (automated/manual)
  - [ ] Execution output
  - [ ] Verification output
  - [ ] Test results
  - [ ] Any issues encountered
  - [ ] Links to GitHub settings

---

## ✨ Verification Checklist

Verify all these are configured:

- [ ] ✅ Pull request required
- [ ] ✅ Required approvals: 1
- [ ] ✅ Dismiss stale reviews: true
- [ ] ✅ Status checks required
  - [ ] ✅ lint
  - [ ] ✅ test
  - [ ] ✅ build
- [ ] ✅ Require branches up to date: true
- [ ] ✅ Conversation resolution required
- [ ] ℹ️ Enforce for administrators: false (admin bypass allowed)
- [ ] ✅ Force pushes blocked
- [ ] ✅ Branch deletions blocked

---

## 📋 Finalization Checklist

- [ ] All tests passed
- [ ] Completion report filled out (T026-COMPLETION.md)
- [ ] Update tasks.md:
  - Change line 465: `### T026 [US1] Enable branch protection for agency/main`
  - To: `### T026 [DONE] [US1] Enable branch protection for agency/main`
- [ ] Commit documentation:
  ```bash
  git add T026-COMPLETION.md tasks.md
  git commit -m "docs: complete T026 - enable branch protection for agency/main"
  ```

---

## 🔜 Next Steps Checklist

- [ ] Proceed to T027 (Enable branch protection for generacy/main)
- [ ] Update project tracking documents
- [ ] Inform team that agency/main is now protected

---

## 🆘 Troubleshooting Checklist

If setup script fails:

- [ ] Check authentication: `gh auth status`
- [ ] Check permissions: `gh api /repos/generacy-ai/agency --jq '.permissions.admin'`
- [ ] Check if CI workflow has run: Visit https://github.com/generacy-ai/agency/actions
- [ ] Review error messages in script output
- [ ] Fallback to manual setup if needed

If verification script fails:

- [ ] Check if branch protection was actually created in GitHub UI
- [ ] Verify status checks exist in CI workflow
- [ ] Manually check settings: https://github.com/generacy-ai/agency/settings/branches
- [ ] Try running setup script again

If direct push test doesn't fail:

- [ ] Branch protection may not be enabled
- [ ] Check GitHub UI for protection status
- [ ] Verify you're pushing to the correct remote
- [ ] Re-run setup script

---

## 📊 Progress Tracker

```
[ ] Prerequisites verified
[ ] Method chosen (Automated/Manual)
[ ] Setup executed
[ ] Configuration verified
[ ] Tests completed
[ ] Documentation filled
[ ] Task marked as DONE
[ ] Ready for T027
```

---

## 🎯 Success Criteria

**Task is complete when ALL of these are true:**

- ✅ Branch protection exists for generacy-ai/agency main branch
- ✅ Verification script passes (exit code 0)
- ✅ Direct push to main is blocked (tested)
- ✅ PR workflow succeeds (optional test)
- ✅ Completion report created and filled
- ✅ tasks.md updated to mark T026 as [DONE]

---

## 🔗 Quick Links

- **Documentation Index**: [T026-INDEX.md](./T026-INDEX.md)
- **Quick Start**: [T026-EXECUTE-NOW.md](./T026-EXECUTE-NOW.md)
- **Detailed Guide**: [T026-INSTRUCTIONS.md](./T026-INSTRUCTIONS.md)
- **GitHub Settings**: https://github.com/generacy-ai/agency/settings/branches

---

**Print this checklist and check off items as you complete them!** ✅
