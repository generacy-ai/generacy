# T005 Quick Guide: Generate Marketplace Publishing PAT

**Task**: Generate Personal Access Token for VS Code Marketplace publishing
**Estimated Time**: 5-10 minutes

## Prerequisites

- Microsoft account: `chris@generacy.ai`
- Azure DevOps organization: `generacy-ai` (must be created first - see T004)
- Browser with access to Azure DevOps

## Step-by-Step Instructions

### 1. Sign In to Azure DevOps

1. Navigate to: https://aex.dev.azure.com/
2. Click "Sign in with GitHub" (recommended) OR enter `chris@generacy.ai`
3. Complete authentication

### 2. Navigate to Personal Access Tokens

Once signed in:
1. Navigate directly to: https://dev.azure.com/generacy-ai/_usersSettings/tokens

   OR manually:
   - Click your profile icon (top right)
   - Select "Personal access tokens"

### 3. Create New Token

1. Click the **"+ New Token"** button
2. Configure the token with the following settings:

#### Token Configuration

| Field | Value | Notes |
|-------|-------|-------|
| **Name** | `VS Code Marketplace Publishing` | Descriptive name for identification |
| **Organization** | `generacy-ai` | Select from dropdown |
| **Expiration** | Custom date: **2027-02-24** | Exactly 1 year from today |
| **Scopes** | Custom defined | See scope details below |

#### Scope Configuration

**CRITICAL**: You must select the correct scope for marketplace publishing:

1. Click **"Show all scopes"** (at the bottom)
2. Scroll down to find **"Marketplace"** section
3. Select: **Marketplace** → **Manage** ✓

**Only this scope is needed**. Do not select additional scopes unless specifically required.

### 4. Generate and Copy Token

1. Click **"Create"** button at the bottom
2. **IMMEDIATELY COPY** the generated token
   - Token format: Looks like `abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnop`
   - This is the **ONLY TIME** you will see the token value
   - ⚠️ If you lose it, you must regenerate a new token

3. Store the token temporarily in a secure location:
   - Password manager (recommended)
   - Secure note on your device
   - **DO NOT** commit to version control

### 5. Verify Token Creation

1. After creation, you should see the token in your token list
2. Verify the following details:
   - Name: `VS Code Marketplace Publishing`
   - Organization: `generacy-ai`
   - Expires: `2027-02-24`
   - Scope: `Marketplace (manage)`
   - Status: Active

### 6. Document Token Details

Record the following information in T005-progress.md:

```markdown
## Token Details

**Token Name**: VS Code Marketplace Publishing
**Expiration Date**: 2027-02-24
**Token Value**: [Copied to secure temporary location - DO NOT RECORD HERE]
**Verification**: ✓ Token appears in Azure DevOps token list
**Created**: 2026-02-24
**Scope**: Marketplace (Manage)
```

## Security Notes

⚠️ **IMPORTANT SECURITY GUIDELINES**:

1. **Never share the token** - Treat it like a password
2. **Never commit the token** to git repositories
3. **Never log the token** in application code or console
4. **Store securely** - Use GitHub Secrets (see T006)
5. **Rotate regularly** - Plan to regenerate before expiration
6. **Revoke if compromised** - Immediately revoke and regenerate if exposed

## Token Permissions

The "Marketplace (Manage)" scope grants:
- ✓ Ability to publish extensions to VS Code Marketplace
- ✓ Ability to update existing extensions
- ✓ Ability to unpublish extensions
- ✗ Does NOT grant access to Azure DevOps repos, pipelines, etc.

## Troubleshooting

### Issue: "Organization not found"
**Solution**: Ensure the `generacy-ai` organization exists. Complete T004 first.

### Issue: "Cannot find Marketplace scope"
**Solution**: Click "Show all scopes" at the bottom of the scopes section.

### Issue: "Token expired immediately"
**Solution**: Check the expiration date was set correctly to 2027-02-24 (1 year).

### Issue: "Lost the token value"
**Solution**:
1. Return to the token list
2. Click the token name
3. Click "Regenerate"
4. Copy the new token immediately

### Issue: "Need to extend expiration"
**Solution**: You cannot extend expiration. Create a new token with a longer expiration and revoke the old one after updating GitHub secrets.

## Next Steps

After completing this task:

1. ✓ Update T005-progress.md with completion details
2. → Proceed to **T006**: Store PAT as GitHub org secret (`VSCE_PAT`)
3. → The token will be used by CI/CD workflows in repos:
   - agency (issue 1.6)
   - generacy (issue 1.7)

## Verification Commands

After storing in GitHub secrets (T006), verify the token works:

```bash
# Set the token as environment variable
export VSCE_PAT="your-token-here"

# Test authentication (requires vsce installed)
npx vsce login generacy-ai

# Expected output:
# Personal Access Token for publisher 'generacy-ai': ****
# The Personal Access Token verification succeeded for the publisher 'generacy-ai'.
```

## References

- [Azure DevOps Personal Access Tokens Documentation](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
- [VS Code Publishing Extensions Guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce CLI Documentation](https://github.com/microsoft/vscode-vsce)

---

**Created**: 2026-02-24
**Last Updated**: 2026-02-24
