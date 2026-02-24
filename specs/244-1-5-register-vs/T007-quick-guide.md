# T007: Secure PAT Cleanup - Quick Guide

**⏱ Estimated Time**: 5-10 minutes
**🔒 Priority**: CRITICAL SECURITY TASK

## Overview

After storing the VSCE_PAT in GitHub organization secrets (T006), you must ensure no copies of the token remain in temporary locations. This prevents unauthorized access to your VS Code Marketplace publisher account.

---

## Security Cleanup Checklist

### Step 1: Clear System Clipboard

**Why**: The PAT may still be in your clipboard from copying it.

**How**:
1. Copy a benign value (e.g., a single space character or random text)
2. Verify the PAT is gone by pasting into a temporary notepad
3. Clear that notepad immediately

**Verification**:
- Paste into a temporary location and confirm it's NOT your PAT
- ✅ Clipboard is clean

---

### Step 2: Clean Password Manager / Temporary Storage

**Why**: You may have temporarily stored the PAT while setting up GitHub secrets.

**Locations to Check**:
- Password manager temporary notes
- Secure notes applications (Apple Notes, OneNote, etc.)
- Clipboard managers (if you use one)
- Browser password manager / autofill data

**How**:
1. Open your password manager
2. Search for entries containing "VSCE", "PAT", "token", or "marketplace"
3. Delete any temporary PAT entries
4. Keep only the documented reference (not the actual value)

**Verification**:
- ✅ No PAT values in password manager (only documentation references)

---

### Step 3: Check File System

**Why**: The PAT may have been saved to a file during setup.

**Common Locations**:
- Desktop files
- Downloads folder
- Documents folder
- VS Code workspace files (`.vscode/`, scratch pads)
- Text editor scratch files (Notepad++, Sublime, etc.)
- Terminal history files (`~/.bash_history`, `~/.zsh_history`)

**How to Search**:

**macOS/Linux**:
```bash
# Search for files containing PAT-like strings (adjust pattern)
grep -r "YOUR_PAT_PREFIX" ~/Desktop ~/Downloads ~/Documents 2>/dev/null

# Check shell history
history | grep -i vsce
history | grep -i token
```

**Windows**:
```powershell
# Search Desktop and Downloads
Get-ChildItem -Recurse -Path "$env:USERPROFILE\Desktop","$env:USERPROFILE\Downloads" | Select-String -Pattern "YOUR_PAT_PREFIX"
```

**Manual Check**:
1. Review recent files in your text editor
2. Check "Recent Documents" in your OS
3. Review any note-taking apps (Notion, Evernote, etc.)

**Verification**:
- ✅ No PAT found in file system searches
- ✅ Recent files reviewed and cleaned

---

### Step 4: Verify No Git Exposure

**Why**: Accidentally committing the PAT to git would expose it permanently in history.

**How**:

1. **Check current repository** (if working in a git repo):
```bash
# Check staging area
git diff --cached

# Check working directory
git status

# Search entire git history for PAT (use first 6-8 chars)
git log -p --all -S "YOUR_PAT_PREFIX" | less
```

2. **If PAT found in git**:
```bash
# DO NOT COMMIT - immediately remove and revoke the PAT
# Follow "Security Incident Response" in T007-progress.md
```

**Verification**:
- ✅ No PAT in git staging area
- ✅ No PAT in git commit history
- ✅ No PAT in any git-tracked files

---

### Step 5: Verify Single Source of Truth

**Why**: Confirm the PAT only exists in authorized, secure locations.

**Authorized Locations** (where PAT SHOULD exist):
1. ✅ GitHub organization secrets: `VSCE_PAT`
   - https://github.com/organizations/generacy-ai/settings/secrets/actions
   - Value is encrypted and hidden
2. ✅ Azure DevOps token list (metadata only, not the actual value)
   - https://dev.azure.com/generacy-ai/_usersSettings/tokens
   - Shows token name, expiration, scopes—NOT the actual token value

**Unauthorized Locations** (where PAT should NOT exist):
- ❌ Clipboard
- ❌ Password manager temporary storage
- ❌ Files on disk
- ❌ Git repositories
- ❌ Browser autofill data
- ❌ Messaging apps (Slack, email, etc.)
- ❌ Documentation files (should reference the secret, not contain the value)

**Final Verification**:
- [ ] Confirm PAT is in GitHub organization secrets
- [ ] Confirm Azure DevOps shows token metadata (not value)
- [ ] Confirm all unauthorized locations are clean
- [ ] Confirm no other copies exist

**Verification**:
- ✅ PAT only in GitHub organization secrets
- ✅ All temporary locations cleaned

---

## Completion

### After Cleanup

1. **Update Progress**: Mark all items complete in `T007-progress.md`
2. **Update Tasks**: Mark T007 as [DONE] in `tasks.md`
3. **Proceed to T008**: Create Publishing Documentation Directory

---

## Security Incident Response

### If You Discover PAT Exposure

**⚠️ IMMEDIATE ACTION REQUIRED**:

1. **Revoke the PAT immediately**:
   - Go to https://dev.azure.com/generacy-ai/_usersSettings/tokens
   - Find the `VSCE_PAT_Marketplace_Publishing` token
   - Click "Revoke"

2. **Generate a new PAT**:
   - Follow T005 instructions again
   - Use same settings (1 year, Marketplace: Manage)

3. **Update GitHub secret**:
   - Go to https://github.com/organizations/generacy-ai/settings/secrets/actions
   - Update `VSCE_PAT` secret with new value

4. **Document the incident**:
   - Create a note in T007-progress.md about the incident
   - Record when/where PAT was exposed
   - Document remediation steps taken

5. **Review access logs** (if applicable):
   - Check VS Code Marketplace activity
   - Check Azure DevOps audit logs

---

## Common Questions

**Q: What if I can't remember if I copied the PAT somewhere?**
A: Err on the side of caution. If uncertain, revoke and regenerate the PAT.

**Q: Should I store the PAT in my password manager?**
A: No. The PAT should only be stored in GitHub organization secrets. Your password manager can store a *reference* to the secret location, but not the actual value.

**Q: Can I share the PAT with my co-admin?**
A: No. The PAT is stored in GitHub organization secrets, which both admins can access. Co-admins should retrieve it from there if needed, not from you directly.

**Q: What if the PAT was committed to git accidentally?**
A: Immediately revoke it, remove from git history (using `git filter-branch` or BFG Repo-Cleaner), and generate a new PAT. See "Security Incident Response" above.

---

## Next Steps

After completing this task:
- → **T008**: Create Publishing Documentation Directory
- → **T009**: Write Marketplace Setup Documentation

**✅ Great job securing your marketplace access!**
