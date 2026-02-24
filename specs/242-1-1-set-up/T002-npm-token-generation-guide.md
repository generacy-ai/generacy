# T002: Generate npm Automation Token - Step-by-Step Guide

**Task Type**: Manual
**Depends on**: T001 (Verify npm organization access)
**Date**: 2026-02-24
**Status**: Ready to Execute

## Overview

This task generates an npm automation token that will be used by GitHub Actions workflows to publish packages to the @generacy-ai organization on npm. The token must have read/write permissions to allow automated publishing.

## Prerequisites

Before starting, ensure:
- ✅ T001 is complete (npm org access verified)
- ✅ You have admin access to the @generacy-ai organization on npmjs.com
- ✅ You have access to a secure password manager or secrets vault

## Step-by-Step Instructions

### Step 1: Log in to npm

1. Navigate to [https://www.npmjs.com/login](https://www.npmjs.com/login)
2. Log in with your organization admin credentials
3. Verify you see the @generacy-ai organization in your account

### Step 2: Navigate to Access Tokens

1. Click on your profile icon in the top-right corner
2. Select **"Access Tokens"** from the dropdown menu
3. You should see a page listing any existing tokens (if any)

**Direct URL**: [https://www.npmjs.com/settings/YOUR_USERNAME/tokens](https://www.npmjs.com/settings/YOUR_USERNAME/tokens)

### Step 3: Generate New Token

1. Click the **"Generate New Token"** button
2. Select token type: **"Automation"**
   - ⚠️ **Important**: Choose "Automation" not "Publish" or "Read-only"
   - Automation tokens can be used in CI/CD environments
   - They do not expire automatically

3. Set token permissions:
   - **Read and Publish**: Select this option
   - This allows the token to publish packages and read package metadata

4. (Optional) Add a description:
   - Suggested: `GitHub Actions - @generacy-ai package publishing`
   - This helps identify the token's purpose later

### Step 4: Copy Token to Secure Location

1. After clicking "Generate Token", npm will display the token **once**
2. ⚠️ **CRITICAL**: Copy the token immediately - you cannot view it again
3. Store the token securely in one of these locations:
   - Password manager (1Password, Bitwarden, LastPass, etc.)
   - Secure notes application
   - Encrypted file on your machine

**Token Format**: The token will look like:
```
npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Step 5: Document Token Details

Create or update the file `/workspaces/generacy/specs/242-1-1-set-up/T002-npm-token-details.md` with:

```markdown
# npm Automation Token Details

**Created**: 2026-02-24
**Created By**: [Your Name/Username]
**Token Type**: Automation (Read/Write)
**Purpose**: GitHub Actions automated publishing for @generacy-ai packages

## Permissions
- ✅ Read packages
- ✅ Publish packages
- ✅ Organization: @generacy-ai

## Used In
- GitHub Actions workflows in:
  - generacy-ai/latency
  - generacy-ai/agency
  - generacy-ai/generacy

## Rotation Schedule
- **Next Rotation**: 2027-02-24 (1 year)
- **Rotation Policy**: See `/workspaces/tetrad-development/docs/NPM_TOKEN_ROTATION.md`

## Security Notes
- Token stored as GitHub organization secret: `NPM_TOKEN`
- Token stored in [password manager/location]
- In case of compromise, immediately rotate following emergency procedure

## Token ID (for reference)
Token ID: [npm shows a token ID on the tokens page, record it here]
```

### Step 6: Verify Token (Optional but Recommended)

Test the token locally before adding to GitHub:

```bash
# Export the token (don't save this in your shell history)
export NPM_TOKEN='npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

# Test authentication
npm whoami --registry=https://registry.npmjs.org/ --//registry.npmjs.org/:_authToken=$NPM_TOKEN

# Test publish access (dry-run, doesn't actually publish)
cd /workspaces/tetrad-development/packages/latency
npm publish --dry-run --//registry.npmjs.org/:_authToken=$NPM_TOKEN
```

Expected output:
- `npm whoami` should return your username or the organization name
- `npm publish --dry-run` should show what would be published without errors

### Step 7: Mark Task Complete

Once the token is generated and securely stored:

1. Update this document with completion status
2. Keep the token ready for T003 (Configure GitHub organization secret)
3. Do NOT commit the actual token value to git
4. Update task status in `tasks.md`

## Security Best Practices

### ✅ DO:
- Store token in a secure password manager
- Use the token only in GitHub Actions secrets
- Rotate token annually (or if compromised)
- Use "Automation" type for CI/CD
- Document token creation date and purpose

### ❌ DON'T:
- Commit token to git repositories
- Share token in chat/email/Slack
- Store token in plain text files
- Use the same token for multiple purposes
- Use personal tokens instead of automation tokens

## Troubleshooting

### Problem: "Generate New Token" button is grayed out
**Solution**: You may not have sufficient permissions. Ensure you're logged in as an organization admin.

### Problem: Token doesn't have publish permissions
**Solution**: You must select "Read and Publish" when creating the token. If you selected "Read Only", delete and recreate.

### Problem: Lost token before saving
**Solution**: The token cannot be recovered. Delete the token from npm and generate a new one.

### Problem: Token verification fails
**Solution**:
1. Verify token was copied completely (no spaces or newlines)
2. Check that you're using the correct npm registry
3. Ensure your account has publish access to @generacy-ai

## Next Steps

After completing this task:
- **Immediate**: Proceed to T003 (Configure GitHub organization secret)
- **Within 1 hour**: Complete T004 (Document token rotation policy)
- **Before production**: Test token in GitHub Actions workflow

## Completion Checklist

- [ ] Logged into npmjs.com
- [ ] Navigated to Access Tokens page
- [ ] Generated new "Automation" type token
- [ ] Set "Read and Publish" permissions
- [ ] Copied token to secure location
- [ ] (Optional) Verified token works with `npm whoami`
- [ ] Documented token details in T002-npm-token-details.md
- [ ] Token ready for use in T003
- [ ] Updated tasks.md to mark T002 as complete

---

**Status**: ⏳ Pending Manual Execution
**Estimated Time**: 10-15 minutes
**Blocking**: T003, T004
