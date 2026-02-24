# ⚠️ T007: Manual Action Required

## Task Summary

**Task T007**: Secure PAT Cleanup
**Status**: Awaiting manual completion
**Priority**: 🔒 CRITICAL SECURITY TASK
**Estimated Time**: 5-10 minutes

## What Has Been Done

✅ Created comprehensive quick guide: `T007-quick-guide.md`
✅ Created progress tracking file: `T007-progress.md`
✅ Identified all potential PAT storage locations
✅ Documented security cleanup procedures

## What You Need To Do

### Required Action

You must **manually verify and clean** all potential PAT storage locations because:
1. The PAT may exist in system clipboard, password managers, or temporary files
2. Automated tools cannot safely identify and clean sensitive data across all locations
3. This is a critical security step to prevent unauthorized marketplace access

### Step-by-Step Instructions

**👉 FOLLOW THE COMPLETE GUIDE**: `T007-quick-guide.md`

**Quick Security Checklist**:

1. **Clear Clipboard** ✂️
   - Copy a benign value (space character or random text)
   - Verify PAT is no longer in clipboard

2. **Clean Temporary Storage** 🗑️
   - Check password manager for temporary PAT entries
   - Review browser autofill/form history
   - Delete any PAT copies found

3. **Verify File System** 📁
   - Search Desktop, Downloads, Documents
   - Check text editor scratch pads
   - Review terminal history
   - Delete any files containing PAT

4. **Verify No Git Exposure** 🔍
   - Check staging area: `git diff --cached`
   - Search history: `git log -p --all -S "PAT_PREFIX"`
   - Confirm no PAT in commits

5. **Confirm Single Source of Truth** ✅
   - Verify PAT only in GitHub organization secrets
   - Confirm Azure DevOps shows metadata only (not value)
   - All unauthorized locations cleaned

## After Completion

Once you've verified all locations are clean:

1. ✅ Mark T007 as [DONE] in `tasks.md`
2. ✅ Update `T007-progress.md` with completion timestamp
3. → Proceed to **T008**: Create Publishing Documentation Directory

---

## ⚠️ Security: Where PAT Should and Should NOT Exist

### ✅ Authorized Locations (PAT SHOULD exist here)

1. **GitHub Organization Secrets**: `VSCE_PAT`
   - https://github.com/organizations/generacy-ai/settings/secrets/actions
   - Encrypted and hidden from view

2. **Azure DevOps Token List** (metadata only)
   - https://dev.azure.com/generacy-ai/_usersSettings/tokens
   - Shows name, expiration, scopes—NOT the actual token value

### ❌ Unauthorized Locations (PAT should NOT exist here)

- System clipboard
- Password manager temporary storage
- Files on disk (Desktop, Downloads, Documents)
- Git repositories (commits, staging area)
- Browser autofill/form data
- Messaging apps (Slack, email, Teams, etc.)
- Documentation files (only reference the secret, not the value)
- Terminal history
- Text editor scratch files

---

## 🚨 If You Discover PAT Exposure

**IMMEDIATE ACTION**:

1. **Revoke the PAT** at https://dev.azure.com/generacy-ai/_usersSettings/tokens
2. **Generate new PAT** following T005 instructions
3. **Update GitHub secret** `VSCE_PAT` with new value
4. **Document incident** in T007-progress.md
5. **Review access logs** for unauthorized activity

See "Security Incident Response" in `T007-quick-guide.md` for detailed steps.

---

## Files Created

1. **T007-progress.md** - Task progress tracking with security checklist
2. **T007-quick-guide.md** - Complete step-by-step security cleanup instructions
3. **T007-MANUAL-ACTION-REQUIRED.md** - This file (action summary)

## Why This Task Is Critical

- **Prevents unauthorized marketplace access**: Anyone with the PAT can publish/unpublish extensions
- **Maintains security posture**: PAT should only exist in encrypted secret storage
- **Compliance**: Follows security best practices for credential management
- **Reduces attack surface**: Limits PAT exposure to single authorized location

---

## Questions?

Refer to:
- Full instructions: `T007-quick-guide.md`
- Progress tracking: `T007-progress.md`
- Security incident response: `T007-quick-guide.md` → "Security Incident Response"
- Task list: `tasks.md`

---

**Created**: 2026-02-24
**Requires**: Human verification (clipboard, files, storage)
**Next Task**: T008 (Create Publishing Documentation Directory)
**Priority**: 🔒 CRITICAL - Do not skip this task
