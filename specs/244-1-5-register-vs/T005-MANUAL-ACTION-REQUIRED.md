# ⚠️ T005: Manual Action Required

## Task Summary

**Task T005**: Generate Marketplace Publishing PAT (Personal Access Token)
**Status**: Awaiting manual completion
**Estimated Time**: 5-10 minutes

## What Has Been Done

✅ Created comprehensive quick guide: `T005-quick-guide.md`
✅ Created progress tracking file: `T005-progress.md`
✅ Updated main tasks file with IN PROGRESS status
✅ Identified correct sign-in page: https://aex.dev.azure.com/

## What You Need To Do

### Required Action

You must **manually complete** the token generation because it requires:
1. Signing in with your Microsoft account (`chris@generacy.ai`)
2. Authenticating with multi-factor authentication (if enabled)
3. Copying the sensitive PAT token value (only shown once)

### Step-by-Step Instructions

**👉 FOLLOW THE COMPLETE GUIDE**: `T005-quick-guide.md`

**Quick Summary**:

1. **Sign In**
   - Go to: https://aex.dev.azure.com/
   - Sign in with `chris@generacy.ai`

2. **Navigate to Tokens**
   - Go to: https://dev.azure.com/generacy-ai/_usersSettings/tokens
   - Click "**+ New Token**"

3. **Configure Token**
   - Name: `VS Code Marketplace Publishing`
   - Organization: `generacy-ai`
   - Expiration: **2027-02-24** (exactly 1 year)
   - Scopes: Click "**Show all scopes**" → Find "**Marketplace**" → Select "**Manage**" ✓

4. **Copy Token**
   - Click "**Create**"
   - **IMMEDIATELY COPY** the token value (looks like: `abc123...xyz789`)
   - ⚠️ This is the ONLY time you'll see it!
   - Store securely (password manager or secure note)

5. **Document**
   - Update `T005-progress.md` with completion details
   - Verify token appears in your token list

## After Completion

Once you have the token copied and documented:

1. ✅ Mark T005 as [DONE] in `tasks.md`
2. → Proceed to **T006**: Store PAT as GitHub org secret
   - Navigate to: https://github.com/organizations/generacy-ai/settings/secrets/actions
   - Create secret named: `VSCE_PAT`
   - Paste the token value

## Important Security Notes

⚠️ **DO NOT**:
- Commit the token to git
- Share the token via email/Slack/etc.
- Log the token in console output
- Store in plain text files

✅ **DO**:
- Store only in GitHub organization secrets (after completing T006)
- Use a password manager for temporary storage
- Rotate annually (as documented)

## Files Created

1. **T005-progress.md** - Task progress tracking and documentation template
2. **T005-quick-guide.md** - Complete step-by-step instructions with screenshots context
3. **T005-MANUAL-ACTION-REQUIRED.md** - This file (action summary)

## Troubleshooting

If you encounter issues, see the "Troubleshooting" section in `T005-quick-guide.md`.

Common issues:
- Organization not found → Complete T004 first (create Azure DevOps org)
- Cannot find Marketplace scope → Click "Show all scopes"
- Lost token value → Regenerate (token settings → Regenerate)

## Questions?

Refer to:
- Full instructions: `T005-quick-guide.md`
- Progress tracking: `T005-progress.md`
- Task list: `tasks.md`

---

**Created**: 2026-02-24
**Requires**: Human action (authentication & token copy)
**Next Task**: T006 (Store PAT as GitHub org secret)
