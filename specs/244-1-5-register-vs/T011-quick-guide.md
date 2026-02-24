# T011 Quick Guide: Document PAT Rotation Process

**Status**: ✅ COMPLETED
**Time**: Already documented (0 minutes additional work)
**Type**: Documentation enhancement

## What Was Done

The PAT rotation process was already comprehensively documented in `/docs/publishing/vscode-marketplace-setup.md` during T009. Task T011 was essentially a verification that the rotation documentation exists and is complete.

## Quick Reference

### Location of PAT Rotation Documentation

**File**: `/docs/publishing/vscode-marketplace-setup.md`
**Section**: "PAT Rotation Process" (lines 97-132)

### What's Documented

1. ✅ 13-step rotation checklist
2. ✅ Azure DevOps token generation process
3. ✅ GitHub secret update procedure
4. ✅ Verification commands (`vsce login`, `vsce ls-publishers`)
5. ✅ Old token cleanup/revocation
6. ✅ New rotation tracking issue creation
7. ✅ Documentation update requirements
8. ✅ Security cleanup steps

### Key Information

- **Current PAT Expires**: 2027-02-24
- **Rotation Due**: 2027-02-10 (2 weeks before expiration)
- **Scopes Required**: Marketplace: Manage only
- **Organization**: generacy-ai (Azure DevOps)
- **GitHub Secret**: VSCE_PAT

## When to Use This

### Annual PAT Rotation

1. GitHub issue will be created 2 weeks before expiration (by T016)
2. Follow checklist at `/docs/publishing/vscode-marketplace-setup.md` lines 101-132
3. Update token dates in "Current Token Details" section
4. Create new tracking issue for next year

### PAT Compromise Response

If PAT is compromised:
1. Immediately revoke old PAT in Azure DevOps
2. Follow rotation checklist to generate new PAT
3. Skip waiting period - rotate immediately
4. Review GitHub Actions logs for unauthorized usage
5. Update documentation with incident details

## Commands Quick Reference

```bash
# Test authentication with new PAT
vsce login generacy-ai
# (paste PAT when prompted)

# Verify publisher access
vsce ls-publishers
# Should show: generacy-ai
```

## Links

- **PAT Management**: https://dev.azure.com/generacy-ai/_usersSettings/tokens
- **GitHub Secrets**: https://github.com/organizations/generacy-ai/settings/secrets/actions
- **Documentation**: `/docs/publishing/vscode-marketplace-setup.md`

## Notes

- Task T011 required no additional work - documentation was complete from T009
- This validates the comprehensive approach taken in T009
- The rotation process is ready for production use
- First rotation due: February 2027

---

**Next**: T012 - Install and verify vsce CLI
