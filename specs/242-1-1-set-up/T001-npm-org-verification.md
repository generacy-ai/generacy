# T001: npm Organization Access Verification

**Task**: Verify npm organization access for @generacy-ai
**Date**: 2026-02-24
**Status**: Pending Verification

## Verification Checklist

### 1. Organization Access
- [ ] Log in to [npmjs.com](https://www.npmjs.com/login)
- [ ] Navigate to [@generacy-ai organization](https://www.npmjs.com/org/generacy-ai)
- [ ] Confirm organization exists and is accessible
- [ ] Verify you have admin/owner permissions

### 2. Member Audit
- [ ] Go to Organization Settings → Members
- [ ] Document all current members
- [ ] Record permission levels for each member
- [ ] Identify automation/bot accounts

### 3. Automation User Verification
- [ ] Verify automation user exists (or document if needs creation)
- [ ] Confirm automation user is a member of @generacy-ai
- [ ] Check publish permissions for automation user
- [ ] Verify access to all target packages:
  - [ ] @generacy-ai/latency
  - [ ] @generacy-ai/agency
  - [ ] @generacy-ai/generacy

### 4. Package Scope Verification
- [ ] Verify @generacy-ai scope is owned by the organization
- [ ] Check existing packages under @generacy-ai scope
- [ ] Verify package visibility settings (public/private)

## CLI Verification Commands

After manual verification, run these commands to confirm npm access from CLI:

```bash
# Login with organization admin credentials
npm login

# Verify login and organization membership
npm whoami
npm org ls generacy-ai

# Check organization access level
npm org ls generacy-ai --json > /workspaces/generacy/specs/242-1-1-set-up/org-members.json

# Verify package access (if packages exist)
npm access ls-packages generacy-ai

# Check existing packages info
npm info @generacy-ai/latency --json 2>/dev/null || echo "Package not yet published"
npm info @generacy-ai/agency --json 2>/dev/null || echo "Package not yet published"
npm info @generacy-ai/generacy --json 2>/dev/null || echo "Package not yet published"

# Verify you can create access tokens
# (Do this in browser: https://www.npmjs.com/settings/[username]/tokens)
```

## Documentation Template

### Organization Structure

**Organization Name**: @generacy-ai
**Organization URL**: https://www.npmjs.com/org/generacy-ai
**Verified Date**: [FILL IN]
**Verified By**: [FILL IN]

#### Members

| Username | Role | Type | Notes |
|----------|------|------|-------|
| [username] | owner/admin/member | human/automation | [notes] |
| | | | |

#### Automation User Details

**Username**: [FILL IN]
**Account Type**: [automation/service account]
**Permissions**: [list permissions]
**Token Created**: [yes/no]
**Token Expiry**: [date or "never"]

#### Existing Packages

| Package Name | Visibility | Latest Version | Last Updated | Maintainers |
|--------------|-----------|----------------|--------------|-------------|
| @generacy-ai/latency | public/private | [version or "not published"] | [date] | [list] |
| @generacy-ai/agency | public/private | [version or "not published"] | [date] | [list] |
| @generacy-ai/generacy | public/private | [version or "not published"] | [date] | [list] |

#### Organization Settings

**Default Package Visibility**: [public/private]
**Two-Factor Auth Required**: [yes/no]
**Package Provenance**: [enabled/disabled]

## Required Actions

Based on verification, document any required actions:

- [ ] Create automation user account (if doesn't exist)
- [ ] Grant automation user appropriate permissions
- [ ] Generate npm access token for GitHub Actions
- [ ] Configure 2FA for automation account (if required)
- [ ] Update organization settings (if needed)

## Token Generation (For GitHub Actions)

Once automation user is verified/created:

1. Log in as automation user to npmjs.com
2. Go to Account Settings → Access Tokens
3. Click "Generate New Token" → "Automation"
4. Name: `github-actions-generacy-ai`
5. Scope: `Automation` (allows publish/unpublish)
6. Copy token immediately (shown only once)
7. Store as GitHub organization secret (see T002)

**Security Notes**:
- Automation tokens should have minimal required scope
- Enable 2FA on automation account if organization requires it
- Use granular access tokens (not legacy tokens)
- Set expiration if organization policy requires it

## Verification Outcomes

Document the results:

### ✅ Success Criteria Met
- [ ] Organization exists and is accessible
- [ ] Admin access confirmed
- [ ] All current members documented
- [ ] Automation user verified/identified
- [ ] Publish permissions confirmed
- [ ] Organization structure documented

### 🚨 Issues Found
[Document any issues discovered during verification]

### 📋 Next Steps
[List follow-up actions required before proceeding to T002]

## Notes

[Add any additional observations, concerns, or recommendations]

---

**Completion Date**: [FILL IN]
**Verified By**: [FILL IN]
**Ready for T002**: [yes/no]
