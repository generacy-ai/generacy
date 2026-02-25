# T006: Create GitHub Organization Secret - Quick Guide

**Task**: Store VSCE_PAT as GitHub Organization Secret
**Duration**: ~2 minutes
**Prerequisites**: GitHub organization owner/admin access, VSCE_PAT token from T005

## Step-by-Step Instructions

### 1. Access Organization Secrets Page

1. Navigate to: https://github.com/organizations/generacy-ai/settings/secrets/actions
2. Sign in with your GitHub account (requires organization owner/admin permissions)
3. You should see the "Actions secrets and variables" page

### 2. Create New Organization Secret

1. Click the **"New organization secret"** button (green button, top right)
2. Fill in the secret details:
   - **Name**: `VSCE_PAT`
   - **Secret**: Paste the PAT value from T005-MANUAL-ACTION-REQUIRED.md
3. Configure repository access:
   - Select **"All repositories"** (default option)
   - This allows both agency and generacy repositories to use the secret

### 3. Save the Secret

1. Click **"Add secret"** button at the bottom
2. Wait for confirmation message

### 4. Verify Secret Creation

After creation, verify:
- ✓ Secret name appears as `VSCE_PAT` in the organization secrets list
- ✓ Repository access shows "All repositories"
- ✓ Updated timestamp shows current date/time

## Important Notes

### Security
- ⚠️ **Never commit the PAT value to git**
- ⚠️ The secret value cannot be viewed after creation (only updated/deleted)
- ⚠️ Only organization owners/admins can manage organization secrets

### Repository Access
- "All repositories" means any workflow in any repo under generacy-ai org can use this secret
- Required for both:
  - `generacy-ai/agency` (issue 1.6)
  - `generacy-ai/generacy` (issue 1.7)

### PAT Expiration
- The PAT expires in 1 year from creation (Azure DevOps setting)
- You'll need to regenerate and update this secret before expiration
- Consider setting a calendar reminder for ~11 months from now

## Troubleshooting

### "New organization secret" button not visible
- **Cause**: Insufficient permissions
- **Solution**: Ensure you're logged in as an organization owner or admin

### Cannot access organization settings
- **Cause**: Not a member of generacy-ai organization or insufficient role
- **Solution**: Contact @christrudelpw or @mikezouhri for access

### Secret already exists
- **Cause**: VSCE_PAT was previously created
- **Solution**: Click on existing secret name to update the value instead

## Usage in CI/CD

Once created, workflows can access the secret using:

```yaml
- name: Publish to VS Code Marketplace
  run: vsce publish
  env:
    VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

## Completion

After successfully creating the secret:
1. ✓ Update T006-progress.md with completion status
2. ✓ Verify secret appears in organization secrets list
3. ✓ Move on to T007 (if applicable) or mark feature as complete

---

**Next Steps**: This completes the VS Code Marketplace publisher setup. The `VSCE_PAT` secret is now ready for use in CI/CD workflows for extension publishing.
