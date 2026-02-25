# T002 Quick Guide: Add Co-Administrator to Azure DevOps

**⏱️ Estimated Time**: 5-10 minutes
**👤 Who**: @christrudelpw (primary admin)
**📋 Outcome**: @mikezouhri added as organization administrator

## Quick Steps

1. **Sign in**: https://dev.azure.com/generacy-ai (use chris@generacy.ai)

2. **Navigate**: Click ⚙️ (gear icon) → "Organization settings" → "Users"

3. **Add user**: Click "+ Add users" button

4. **Configure**:
   - Email: `@mikezouhri's Microsoft account email`
   - Access level: **Basic**
   - Group: **Project Collection Administrators** ⭐ (this is the admin role)

5. **Send invite**: Click "Add" button

6. **Notify**: Tell @mikezouhri to check email and accept invitation

7. **Verify**: After acceptance, confirm:
   - ✅ @mikezouhri shows "Active" status
   - ✅ Member of "Project Collection Administrators" group
   - ✅ Can access https://dev.azure.com/generacy-ai
   - ✅ Can view Organization Settings

## Critical Detail

The key to admin access is adding @mikezouhri to the **"Project Collection Administrators"** group. Without this, they'll be a regular user, not an admin.

## What You'll Need

- [ ] Access to chris@generacy.ai account
- [ ] @mikezouhri's Microsoft account email address
- [ ] Ability to coordinate with @mikezouhri for invitation acceptance

## Success = Both Admins Can:

- Access https://dev.azure.com/generacy-ai ✅
- View Organization Settings ✅
- Manage Users ✅
- Generate Personal Access Tokens ✅

---

📖 For detailed instructions and troubleshooting: See `T002-progress.md`
