# T004 Quick Guide: Publisher Registration Verification

## 🔴 Critical Finding: Publisher Not Registered

**Status**: Publisher `generacy-ai` is **NOT YET REGISTERED** on VS Code Marketplace

## Verification Results Summary

| Check | Status | Notes |
|-------|--------|-------|
| Publisher page accessible | ❌ FAIL | 404 error at marketplace.visualstudio.com/publishers/generacy-ai |
| Display name "Generacy" | ⚠️ N/A | Cannot verify - publisher doesn't exist |
| Description visible | ⚠️ N/A | Cannot verify - publisher doesn't exist |
| No pending verification | ⚠️ N/A | Cannot verify without authentication |
| Publisher ID confirmed | ⚠️ PENDING | Intended ID: `generacy-ai` |

## Immediate Action Required

### ⚠️ STOP: Complete Registration First

Before proceeding with any other tasks in this feature, **you must register the publisher account**:

1. **Sign in to Azure DevOps**
   - Go to: https://marketplace.visualstudio.com/manage
   - Use account: `chris@generacy.ai` (or authorized admin)

2. **Create Publisher**
   - Click "Create Publisher"
   - Publisher ID: `generacy-ai`
   - Display Name: `Generacy`
   - Description: [Add appropriate description]

3. **Complete Verification**
   - Follow any verification steps required by Microsoft
   - Confirm email/domain if needed
   - Accept terms and conditions

4. **Re-run This Verification**
   - After registration, verify:
     - https://marketplace.visualstudio.com/publishers/generacy-ai returns 200 OK
     - Display name and description appear correctly
     - No pending verification warnings

## What This Blocks

Without completing publisher registration, you **cannot**:
- Generate Personal Access Token (PAT)
- Store `VSCE_PAT` in GitHub secrets
- Set up CI/CD publishing workflows
- Publish Agency extension (issue 1.6)
- Publish Generacy extension (issue 1.7)

## Next Steps After Registration

Once the publisher is confirmed registered and visible:

1. **Generate PAT** (T005 or next task)
   - Go to Azure DevOps → User Settings → Personal Access Tokens
   - Create new token with **Marketplace (Manage)** scope
   - Set 1-year expiration
   - Copy token value

2. **Store in GitHub**
   - Navigate to GitHub org settings → Secrets
   - Create organization secret: `VSCE_PAT`
   - Paste token value

3. **Test Publishing**
   - Verify `vsce` CLI can authenticate
   - Test publish with sample extension (if needed)

## Who Can Help

**Account Admins** (per plan.md):
- @christrudelpw
- @mikezouhri

**Microsoft Account**: chris@generacy.ai

## Key URLs

- **Marketplace Management**: https://marketplace.visualstudio.com/manage
- **Publisher Page (after registration)**: https://marketplace.visualstudio.com/publishers/generacy-ai
- **Azure DevOps Org**: https://dev.azure.com/generacy-ai

## References

- Full Report: [T004-progress.md](./T004-progress.md)
- Specification: [spec.md](./spec.md)
- Implementation Plan: [plan.md](./plan.md)
- Registration Procedures: T001, T002, T003 progress files

---

**Quick Summary**: Publisher account not found. Register at marketplace.visualstudio.com/manage before continuing with PAT generation or CI/CD setup.
