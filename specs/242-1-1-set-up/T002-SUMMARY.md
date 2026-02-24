# T002: npm Automation Token Generation - Task Summary

**Task ID**: T002
**Type**: Manual (requires browser interaction)
**Status**: Ready to Execute
**Estimated Time**: 10-15 minutes
**Dependencies**: T001 (completed)
**Blocks**: T003-T048 (all subsequent tasks)

---

## 🎯 Objective

Generate an npm automation token with read/write permissions that will be used by GitHub Actions to automatically publish @generacy-ai packages to npm.

---

## 📂 Documentation Created

All necessary documentation has been prepared for you:

### Primary Documents
1. **T002-EXECUTE-NOW.md** ⭐ START HERE
   - Quick 3-step guide
   - Takes 10-15 minutes total
   - No technical background needed

2. **T002-npm-token-generation-guide.md**
   - Comprehensive step-by-step instructions
   - Screenshots and verification steps
   - Troubleshooting section

3. **T002-quick-checklist.md**
   - Minimal checklist format
   - For quick reference during execution

### Supporting Documents
4. **T002-npm-token-details.template.md**
   - Template to fill out after generation
   - Documents token metadata (NOT the token itself)
   - Used for future reference and rotation

---

## 🚀 Quick Start

### Ready to execute? Follow these steps:

1. **Open**: `T002-EXECUTE-NOW.md`
2. **Follow**: The three simple steps
3. **Complete**: The completion checklist
4. **Proceed**: To T003 (Configure GitHub secret)

### Command to open the guide:
```bash
cat /workspaces/generacy/specs/242-1-1-set-up/T002-EXECUTE-NOW.md
```

---

## 📋 What Happens in This Task

### Input
- Admin access to @generacy-ai npm organization
- Web browser access to npmjs.com
- Password manager (to store token)

### Process
1. Log in to npmjs.com
2. Navigate to Access Tokens
3. Generate new "Automation" type token
4. Set "Read and Publish" permissions
5. Copy token to password manager
6. Document token metadata

### Output
- ✅ npm automation token (stored securely)
- ✅ Token metadata documented
- ✅ Ready for T003 (GitHub secrets)

---

## ⚠️ Critical Requirements

### Token Type
- ✅ **Use**: "Automation" type
- ❌ **Don't use**: "Publish", "Read-only", or "Classic" types

### Permissions
- ✅ **Use**: "Read and Publish"
- ❌ **Don't use**: "Read-only" (won't allow publishing)

### Security
- ✅ **Store in**: Password manager
- ❌ **Never**: Commit to git, share via chat/email

---

## 🔐 Security Model

### Token Characteristics
- **Type**: Automation (designed for CI/CD)
- **Expiration**: Never (manual rotation required)
- **Scope**: Organization-wide (@generacy-ai)
- **Permissions**: Read + Publish
- **Usage**: GitHub Actions workflows only

### Storage Locations
1. **Password Manager**: Primary secure storage
2. **GitHub Secrets**: Will be added in T003
3. **Documentation**: Metadata only (in T002-npm-token-details.md)

### Rotation Policy
- **Frequency**: Annually (or on compromise)
- **Next Rotation**: 2027-02-24
- **Procedure**: Documented in T004

---

## 📊 Task Context

### Why This Task Matters
This token is the foundation for automated npm publishing. Without it:
- ❌ Can't publish packages automatically
- ❌ Can't run preview releases on develop
- ❌ Can't run stable releases on main
- ❌ All subsequent CI/CD tasks are blocked

### Impact on Project
- **Enables**: Automated publishing for 3 repos (latency, agency, generacy)
- **Unlocks**: 45 subsequent tasks (T003-T048)
- **Supports**: Both preview (@preview) and stable (@latest) release streams

---

## ✅ Success Criteria

Task is complete when:
- [ ] Token generated on npmjs.com
- [ ] Token type is "Automation"
- [ ] Permissions set to "Read and Publish"
- [ ] Token saved in password manager
- [ ] `T002-npm-token-details.md` created and filled out
- [ ] Token ready for use in T003

---

## 🔄 Next Steps

### Immediate (within 1 hour)
1. **Execute**: This task (T002) using T002-EXECUTE-NOW.md
2. **Proceed**: To T003 (Configure GitHub organization secret)
3. **Complete**: T004 (Document token rotation policy)

### Short-term (same day)
4. **Start**: Phase 2A (Branch synchronization)
5. **Begin**: Changesets configuration

---

## 📞 Support

### If You Get Stuck

**Issue**: Can't find npm organization
- **Check**: T001 verification was completed
- **Verify**: You're logged in as org admin
- **URL**: https://www.npmjs.com/org/generacy-ai

**Issue**: Token generation fails
- **Check**: You have sufficient permissions (owner/admin)
- **Verify**: Organization allows token creation
- **Try**: Logging out and back in

**Issue**: Lost token before saving
- **Solution**: Delete token on npm, generate new one
- **Important**: Tokens can only be viewed once

### Reference Documents
- Full task list: `tasks.md`
- Implementation plan: `plan.md`
- Feature spec: `spec.md`

---

## 🎓 Learning Resources

### npm Token Types
- **Classic**: Legacy, not recommended
- **Granular**: Preferred, includes Automation type
- **Automation**: Designed for CI/CD, no expiration
- **Publish**: For manual publishing, not for automation
- **Read-only**: For reading packages, can't publish

### Why "Automation" Type?
- ✅ Designed for CI/CD environments
- ✅ No automatic expiration
- ✅ Works with GitHub Actions
- ✅ Can bypass 2FA in automated contexts
- ✅ Auditable via npm logs

---

## 📈 Progress Tracking

### Overall Feature Progress
- Phase 1: Organization Setup
  - T001: ✅ Complete (npm org verification)
  - **T002: ⏳ Current (token generation)** ← YOU ARE HERE
  - T003: ⏸️ Pending (GitHub secrets)
  - T004: ⏸️ Pending (rotation policy)

### Completion Percentage
- Phase 1: 25% (1/4 tasks complete)
- Overall: 2% (1/48 tasks complete)

---

## 💡 Tips

### Before You Start
1. Have password manager open and ready
2. Use a dedicated browser session (avoid distractions)
3. Set aside 15 uninterrupted minutes
4. Have T002-EXECUTE-NOW.md open for reference

### During Execution
1. Read each step carefully before clicking
2. Copy token immediately after generation
3. Verify token is saved before closing browser
4. Fill out template right away (while fresh)

### After Completion
1. Verify token is in password manager
2. Verify documentation is complete
3. Mark task complete in tasks.md
4. Move to T003 immediately (momentum!)

---

**Status**: 📋 Ready for Execution
**Owner**: [Your Name]
**Started**: [When you begin]
**Completed**: [When finished]

---

**Need to start? Open T002-EXECUTE-NOW.md and follow the three steps! 🚀**
