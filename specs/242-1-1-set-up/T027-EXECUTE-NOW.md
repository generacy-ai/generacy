# T027: Enable Branch Protection for generacy/main

## ⚡ Quick Start

```bash
cd /workspaces/generacy/specs/242-1-1-set-up

# 1. Set up branch protection
./T027-setup-branch-protection.sh

# 2. Verify configuration
./T027-verify-protection.sh

# 3. Test protection (optional)
git checkout main
git pull
echo "test" >> README.md
git add README.md
git commit -m "test: direct push to main"
git push  # Should fail with protection error
git reset --hard HEAD~1  # Undo test commit
```

## Prerequisites

- [ ] GitHub CLI (`gh`) installed and authenticated
- [ ] Admin access to `generacy-ai/generacy` repository
- [ ] T021 completed (stable release workflow exists)

## Expected Outcomes

✅ Branch protection enabled on `generacy/main`
✅ Direct pushes to main blocked
✅ Pull requests require 1 approval
✅ Status checks (lint, test, build) required
✅ Conversations must be resolved before merge

## Troubleshooting

**Error: "Resource not accessible by integration"**
- Solution: Ensure you're authenticated with `gh auth login` and have admin permissions

**Error: "Branch not found"**
- Solution: Verify main branch exists: `gh api /repos/generacy-ai/generacy/branches/main`

**Error: "Required status checks not found"**
- Solution: This is expected if CI workflows haven't run yet. Protection is still enabled.

## Next Steps

After completion:
- [ ] Proceed to T028 (Create PUBLISHING.md)
- [ ] Document completion in T027-COMPLETION.md
- [ ] Update tasks.md to mark T027 as [DONE]
