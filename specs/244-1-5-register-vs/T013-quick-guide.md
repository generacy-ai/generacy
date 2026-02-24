# T013: Test Publisher Authentication - Quick Guide

## Quick Commands

```bash
# 1. Get PAT from GitHub org secrets
# https://github.com/organizations/generacy-ai/settings/secrets/actions
# Copy VSCE_PAT value

# 2. Login
vsce login generacy-ai
# Paste PAT when prompted

# 3. Verify
vsce ls-publishers
# Should show: generacy-ai

# 4. Test cycle
vsce logout generacy-ai
vsce login generacy-ai
```

## Expected Output

### Successful Login
```
The Personal Access Token verification succeeded for the publisher 'generacy-ai'.
```

### Publisher List
```
generacy-ai
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Publisher not found" | Verify publisher ID is exactly `generacy-ai` |
| "Invalid PAT" | Check PAT expiration in Azure DevOps |
| "Authentication failed" | Verify PAT has Marketplace: Manage scope |
| PAT expired | Regenerate in Azure DevOps, update GitHub secret |

## Quick Links

- Azure DevOps PATs: https://dev.azure.com/generacy-ai/_usersSettings/tokens
- GitHub Org Secrets: https://github.com/organizations/generacy-ai/settings/secrets/actions
- Publisher Portal: https://marketplace.visualstudio.com/manage/publishers/generacy-ai

## Success Checklist

- [ ] vsce login succeeds
- [ ] generacy-ai in publisher list
- [ ] Logout/login cycle works
- [ ] No errors or warnings

⏱️ **Estimated time**: 2-3 minutes
