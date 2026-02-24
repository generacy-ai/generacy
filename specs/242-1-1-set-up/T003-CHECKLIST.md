# T003: Quick Checklist

## Pre-execution
- [ ] Have NPM token from T002 ready to paste
- [ ] Logged into GitHub with org admin account
- [ ] Browser open to https://github.com/organizations/generacy-ai/settings/secrets/actions

## Execution Steps
1. - [ ] Click "New organization secret"
2. - [ ] Name: `NPM_TOKEN`
3. - [ ] Value: Paste token from T002
4. - [ ] Repository access: Select "Public repositories"
5. - [ ] Click "Add secret"
6. - [ ] Verify secret appears in list

## Verification
- [ ] Run verification script: `./verify-github-secret.sh`
- [ ] Check latency repo: https://github.com/generacy-ai/latency/settings/secrets/actions
- [ ] Check agency repo: https://github.com/generacy-ai/agency/settings/secrets/actions
- [ ] Check generacy repo: https://github.com/generacy-ai/generacy/settings/secrets/actions

## Success Criteria
✅ All three repositories show `NPM_TOKEN` in Organization secrets section

## Time Estimate
⏱️ 2-3 minutes

## If Issues
📖 See troubleshooting section in T003-github-org-secret-setup.md
