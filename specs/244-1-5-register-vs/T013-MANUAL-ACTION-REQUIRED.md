# T013: Test Publisher Authentication - MANUAL ACTION REQUIRED

**Task**: Test Publisher Authentication
**Date**: 2026-02-24
**Status**: Awaiting Manual Execution

## Prerequisites

✅ **vsce CLI installed**: Version 3.7.1 confirmed

## Manual Steps Required

### Step 1: Retrieve VSCE_PAT from GitHub

1. Navigate to: https://github.com/organizations/generacy-ai/settings/secrets/actions
2. Locate the organization secret named `VSCE_PAT`
3. Copy the Personal Access Token value

### Step 2: Login to VS Code Marketplace

```bash
cd /workspaces/generacy
vsce login generacy-ai
```

When prompted:
- Paste the `VSCE_PAT` value from GitHub secrets
- Press Enter

**Expected Output**:
```
The Personal Access Token verification succeeded for the publisher 'generacy-ai'.
```

### Step 3: Verify Publisher List

```bash
vsce ls-publishers
```

**Expected Output**:
```
generacy-ai
```

### Step 4: Test Authentication Status

```bash
vsce logout generacy-ai
vsce login generacy-ai
```

Re-login to verify the token works consistently.

## Success Criteria

- [ ] `vsce login generacy-ai` succeeds without errors
- [ ] PAT verification message appears
- [ ] `vsce ls-publishers` shows `generacy-ai` in the list
- [ ] Can logout and login again successfully

## Notes

- **Security**: Do not commit or log the VSCE_PAT value
- **Token Storage**: vsce stores the token in `~/.vsce`
- **Expiration**: PAT has 1-year expiration (verify expiration date in Azure DevOps)
- **Troubleshooting**: If login fails, verify:
  - PAT has not expired
  - PAT has correct scopes (Marketplace: Manage)
  - Publisher ID is exactly `generacy-ai` (case-sensitive)

## Next Steps After Verification

Once authentication is confirmed:
1. Update T013-progress.md with results
2. Document any issues encountered
3. Proceed to T014 (if applicable) or mark feature complete

## Support

If authentication fails:
- Check Azure DevOps PAT settings: https://dev.azure.com/generacy-ai/_usersSettings/tokens
- Regenerate PAT if expired
- Update GitHub secret with new PAT value
- Verify publisher exists: https://marketplace.visualstudio.com/manage/publishers/generacy-ai
