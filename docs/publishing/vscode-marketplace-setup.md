# VS Code Marketplace Publisher Setup

**Last Updated**: 2026-02-24
**Status**: Active
**Publisher ID**: `generacy-ai`

## Overview

This document describes the setup and configuration of the `generacy-ai` publisher account for publishing VS Code extensions to the Visual Studio Code Marketplace. This one-time setup enables automated publishing of extensions through CI/CD pipelines for both the Agency and Generacy VS Code extensions.

**Purpose**: Establish organizational identity and authentication infrastructure for VS Code extension publishing.

**Scope**: Publisher account registration, Personal Access Token (PAT) management, GitHub secret configuration, and ongoing maintenance procedures.

## Publisher Details

- **Publisher ID**: `generacy-ai`
- **Display Name**: Generacy
- **Description**: AI-powered development workflow tooling
- **Profile URL**: [https://marketplace.visualstudio.com/publishers/generacy-ai](https://marketplace.visualstudio.com/publishers/generacy-ai)
- **Status**: Active and verified
- **Created**: 2026-02-24

### Published Extensions

The following extensions are published under this publisher:
- `generacy-ai.agency` - Agency VS Code extension (planned)
- `generacy-ai.generacy` - Generacy VS Code extension (planned)

## Azure DevOps Organization

The publisher account is linked to an Azure DevOps organization, which is required for generating Personal Access Tokens (PATs) for marketplace publishing.

- **Organization Name**: `generacy-ai`
- **URL**: [https://dev.azure.com/generacy-ai](https://dev.azure.com/generacy-ai)
- **Purpose**: Hosts Personal Access Token for marketplace publishing authentication
- **Created**: 2026-02-24

## Access Control

### Direct Publisher Access

The following individuals have direct access to manage the publisher account and Azure DevOps organization:

- **@christrudelpw** (chris@generacy.ai) - Primary owner and administrator
- **@mikezouhri** - Co-administrator

### Capabilities with Direct Access

- Update publisher profile (display name, description, logo, website)
- Manually publish, update, or unpublish extensions
- Manage Personal Access Tokens in Azure DevOps
- Add or remove administrators
- View marketplace analytics and download statistics
- Respond to user reviews and support questions

### Requesting Access

If you need direct access to the publisher account:

1. Contact @christrudelpw or @mikezouhri
2. Provide justification for access (e.g., publisher profile updates, manual extension management)
3. Administrator will add you to both:
   - Azure DevOps organization as administrator
   - VS Code Marketplace publisher as co-owner
4. Update this documentation with new administrator details

### CI/CD Access

All repositories in the `generacy-ai` GitHub organization have access to the `VSCE_PAT` organization secret, which enables automated publishing through CI/CD workflows. No additional access requests are needed for repositories within the organization.

## Personal Access Token (PAT)

### Current Token Details

- **Name**: `VSCE_PAT_Marketplace_Publishing`
- **Organization**: generacy-ai (Azure DevOps)
- **Created**: 2026-02-24
- **Expires**: 2027-02-24 (1 year from creation)
- **Rotation Due**: 2027-02-10 (2 weeks before expiration)

### Scopes Granted

The PAT has minimal required permissions following the principle of least privilege:

- **Marketplace: Manage** - Publish, update, and unpublish extensions
- **Organization**: Limited to `generacy-ai` only (not "All accessible organizations")

### Security Notes

- PAT is stored only as a GitHub organization secret (never committed to code)
- PAT value is shown only once during generation and cannot be retrieved later
- If PAT is compromised, immediately revoke in Azure DevOps and generate a new one
- PAT should never be shared via Slack, email, or any other channel
- Access to GitHub organization secrets is restricted to organization administrators

### PAT Rotation Process

The PAT must be rotated annually before expiration. A GitHub issue is created 2 weeks before expiration as a reminder.

**Rotation Checklist**:

1. Navigate to [Azure DevOps Personal Access Tokens](https://dev.azure.com/generacy-ai/_usersSettings/tokens)
2. Click "New Token" to generate a new PAT
3. Configure token settings:
   - Name: `VSCE_PAT_Marketplace_Publishing`
   - Organization: `generacy-ai` (ensure "All accessible organizations" is NOT selected)
   - Expiration: 1 year from current date (365 days)
   - Scopes: Custom defined → **Marketplace: Manage** only
4. Generate token and immediately copy the value to a secure temporary location
5. Navigate to [GitHub Organization Secrets](https://github.com/organizations/generacy-ai/settings/secrets/actions)
6. Find the `VSCE_PAT` secret and click "Update"
7. Paste the new PAT value and save
8. Test authentication (see Verification Process section below):
   ```bash
   vsce login generacy-ai
   # Paste new PAT when prompted
   vsce ls-publishers
   # Should show generacy-ai in list
   ```
9. Once verified, navigate back to [Azure DevOps tokens page](https://dev.azure.com/generacy-ai/_usersSettings/tokens)
10. Delete/revoke the old PAT (find by creation date)
11. Create new rotation tracking issue for next year:
    - Title: "Rotate VSCE_PAT — expires [YYYY-MM-DD]"
    - Assignees: @christrudelpw, @mikezouhri
    - Due date: 2 weeks before new expiration
    - Include link to this document
12. Update the "Current Token Details" section above with new dates
13. Delete temporary copy of new PAT value

**Important**: Always create a NEW rotation tracking issue after rotating the PAT to ensure the next rotation is not missed.

## GitHub Secret

### Secret Configuration

- **Name**: `VSCE_PAT` (exact case-sensitive name)
- **Type**: Organization-level secret
- **Repository Access**: All repositories in `generacy-ai` organization
- **URL**: [GitHub Organization Secrets](https://github.com/organizations/generacy-ai/settings/secrets/actions)

### Usage in CI/CD

The `VSCE_PAT` secret is used in GitHub Actions workflows to authenticate with the VS Code Marketplace for automated publishing. Example usage:

```yaml
- name: Publish to VS Code Marketplace
  run: vsce publish
  env:
    VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

### Repositories Using This Secret

- **agency** (issue 1.6) - Agency VS Code extension CI/CD
- **generacy** (issue 1.7) - Generacy VS Code extension CI/CD

Additional repositories added to the `generacy-ai` organization will automatically have access to this secret.

## Verification Process

### Testing Authentication Locally

To verify that the PAT is working correctly:

1. Install the VS Code Extension Manager CLI globally:
   ```bash
   npm install -g @vscode/vsce
   ```

2. Verify installation:
   ```bash
   vsce --version
   ```

3. Test authentication:
   ```bash
   vsce login generacy-ai
   # When prompted, paste the VSCE_PAT value
   ```

4. Verify publisher access:
   ```bash
   vsce ls-publishers
   # Should display generacy-ai in the list
   ```

5. (Optional) Test package validation with dry-run:
   ```bash
   cd /path/to/extension
   vsce publish --dry-run
   # Validates packaging without actually publishing
   ```

### Verifying in CI/CD

When the Agency (1.6) and Generacy (1.7) extension CI/CD workflows are implemented, verify authentication by:

1. Triggering a publish workflow in GitHub Actions
2. Check workflow logs for successful authentication
3. Verify extension appears/updates on VS Code Marketplace
4. Confirm version number matches expected release

## Troubleshooting

### Authentication Failures

**Symptom**: `vsce login` fails or CI/CD publish step fails with authentication error

**Possible Causes**:
- PAT has expired
- PAT was revoked in Azure DevOps
- GitHub secret name is incorrect (must be exactly `VSCE_PAT`)
- GitHub secret value is incorrect or corrupted

**Solutions**:
1. Check PAT expiration date (see "Current Token Details" above)
2. Verify PAT exists in [Azure DevOps tokens list](https://dev.azure.com/generacy-ai/_usersSettings/tokens)
3. Verify GitHub secret exists at [organization secrets page](https://github.com/organizations/generacy-ai/settings/secrets/actions)
4. If PAT expired or revoked, follow PAT Rotation Process above
5. Test authentication locally with `vsce login generacy-ai`

### Publisher Not Found

**Symptom**: `vsce login generacy-ai` returns "Publisher 'generacy-ai' not found"

**Possible Causes**:
- Publisher ID is incorrect
- Publisher account was deleted or suspended
- Typo in publisher ID

**Solutions**:
1. Verify publisher ID by visiting [marketplace profile](https://marketplace.visualstudio.com/publishers/generacy-ai)
2. Check for typos (publisher ID is case-sensitive)
3. Contact VS Code Marketplace support if publisher account appears deleted

### Insufficient Permissions

**Symptom**: `vsce publish` fails with "Insufficient permissions" error

**Possible Causes**:
- PAT scopes are incorrect or insufficient
- PAT is not linked to the correct Azure DevOps organization
- Publisher account permissions changed

**Solutions**:
1. Verify PAT scopes include "Marketplace: Manage"
2. Check PAT is limited to `generacy-ai` organization
3. Verify user has administrator access to publisher account
4. Regenerate PAT with correct scopes using rotation process

### Package Validation Errors

**Symptom**: `vsce publish` or `vsce package` fails with validation errors

**Possible Causes**:
- Invalid or missing package.json fields
- Icon or logo file issues
- Missing required extension manifest fields
- Large file size or incorrect file structure

**Solutions**:
1. Run `vsce publish --dry-run` locally to identify issues
2. Review [VS Code extension manifest documentation](https://code.visualstudio.com/api/references/extension-manifest)
3. Check `package.json` has required fields: name, version, publisher, engines, displayName, description
4. Verify publisher field matches `generacy-ai`
5. Check `.vscodeignore` to exclude unnecessary files

### GitHub Secret Not Accessible in Workflow

**Symptom**: CI/CD workflow fails to access `VSCE_PAT` secret

**Possible Causes**:
- Secret repository access is not set to "All repositories"
- Workflow is running in a forked repository
- Secret name is misspelled in workflow file

**Solutions**:
1. Verify secret repository access at [organization secrets page](https://github.com/organizations/generacy-ai/settings/secrets/actions)
2. Check workflow YAML uses exact name: `secrets.VSCE_PAT`
3. Organization secrets are not accessible from forked repositories for security reasons
4. Ensure workflow runs on `generacy-ai` organization repositories only

## Maintenance Tasks

### Annual Maintenance

- **PAT Rotation** (required annually): Follow PAT Rotation Process when GitHub issue reminder triggers
- **Access Review** (recommended annually): Review administrator list and remove inactive users
- **Documentation Review** (recommended annually): Update this document with any changes to processes or URLs

### Quarterly Maintenance

- **Marketplace Activity Review**: Check publisher dashboard for download metrics and user feedback
- **Extension Updates**: Review published extensions for needed updates or security patches
- **Policy Compliance**: Check for VS Code Marketplace policy changes that may affect extensions

### As-Needed Maintenance

- **Adding Administrators**: Follow "Requesting Access" process when new team members need publisher access
- **Updating Publisher Profile**: Update display name, description, logo, or website as branding evolves
- **Extension Lifecycle**: Publish, update, or unpublish extensions as development progresses
- **Incident Response**: Follow security procedures if PAT is compromised or unauthorized activity detected

## Links and Resources

### Primary Resources

- **Publisher Profile**: [https://marketplace.visualstudio.com/publishers/generacy-ai](https://marketplace.visualstudio.com/publishers/generacy-ai)
- **Azure DevOps Organization**: [https://dev.azure.com/generacy-ai](https://dev.azure.com/generacy-ai)
- **Azure DevOps PAT Management**: [https://dev.azure.com/generacy-ai/_usersSettings/tokens](https://dev.azure.com/generacy-ai/_usersSettings/tokens)
- **GitHub Organization Secrets**: [https://github.com/organizations/generacy-ai/settings/secrets/actions](https://github.com/organizations/generacy-ai/settings/secrets/actions)

### Official Documentation

- **VS Code Publishing Extensions**: [https://code.visualstudio.com/api/working-with-extensions/publishing-extension](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- **VS Code Extension Manifest**: [https://code.visualstudio.com/api/references/extension-manifest](https://code.visualstudio.com/api/references/extension-manifest)
- **Azure DevOps PATs**: [https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
- **vsce CLI Documentation**: [https://github.com/microsoft/vsce](https://github.com/microsoft/vsce)

### Internal References

- **Onboarding Buildout Plan**: [tetrad-development/docs/onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) (Issue 1.5)
- **Agency Extension CI/CD**: Issue 1.6 (depends on this setup)
- **Generacy Extension CI/CD**: Issue 1.7 (depends on this setup)

## Future Improvements

The following improvements are planned but out of scope for initial setup:

### 1. Shared Team Email Migration

**When**: After shared email (dev@generacy.ai or extensions@generacy.ai) is provisioned
**Effort**: ~30 minutes
**Benefits**: Reduces bus factor, more professional organizational ownership

**Steps**:
1. Create new Microsoft account with shared team email
2. Add as administrator to Azure DevOps organization
3. Add as co-owner to VS Code Marketplace publisher account
4. Transfer primary ownership from chris@generacy.ai to shared email
5. Verify both accounts have full access
6. Update this documentation with new primary account

### 2. Publisher Profile Branding

**When**: After logo and branding assets are finalized
**Effort**: ~15 minutes
**Benefits**: Professional appearance, brand recognition

**Items to Add**:
- Upload logo/icon to publisher profile
- Add website URL (generacy.ai)
- Expand description with tagline and value proposition
- Add social media links (GitHub, Twitter, etc.)
- Add support email or link

### 3. Automated PAT Rotation and Alerting

**When**: After multiple extensions are published and process is stable
**Effort**: 1-2 days
**Benefits**: Reduced manual overhead, improved security

**Approach**:
- Create GitHub Action to check PAT expiration via Azure DevOps API
- Send Slack notification when <30 days remaining
- Generate automated rotation reminder issues
- Consider automated rotation with secure key storage (e.g., HashiCorp Vault, Azure Key Vault)

### 4. Marketplace Analytics Dashboard

**When**: After 6 months of extensions being published
**Effort**: 2-4 days
**Benefits**: Better visibility into extension adoption and usage

**Features**:
- Aggregate download metrics across extensions
- Track install/uninstall trends over time
- Monitor user ratings and review sentiment
- Identify top-performing extensions and growth opportunities
- Export data for stakeholder reports

### 5. Automated Extension Testing Before Publish

**When**: After CI/CD publishing is established
**Effort**: 3-5 days
**Benefits**: Catch issues before they reach users

**Testing to Add**:
- Automated extension activation tests
- Command palette registration verification
- Settings schema validation
- Icon and asset validation
- Extension size and performance checks
- Compatibility testing across VS Code versions

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-02-24 | Initial documentation created | @christrudelpw |

## Appendix

### PAT Scopes Reference

The following table shows the Azure DevOps PAT scopes and what they enable:

| Scope | Permission Level | Use Case | Selected for VSCE_PAT |
|-------|-----------------|----------|----------------------|
| Marketplace | Manage | Publish, update, unpublish extensions | ✅ Yes |
| Marketplace | Acquire | Install extensions (not needed) | ❌ No |
| Code | Read | Read code repositories | ❌ No |
| Code | Full | Modify code repositories | ❌ No |
| Build | Read | View build pipelines | ❌ No |
| Release | Read | View release pipelines | ❌ No |
| Work Items | Read | View work items | ❌ No |

**Principle**: Only "Marketplace: Manage" is required for extension publishing. All other scopes are excluded to limit potential damage if PAT is compromised.

### Extension ID Format

VS Code extension IDs follow the format: `<publisher>.<extension-name>`

For Generacy extensions:
- Agency: `generacy-ai.agency`
- Generacy: `generacy-ai.generacy`

The publisher ID (`generacy-ai`) must match the registered publisher ID exactly. The extension name is defined in the `package.json` `name` field.

### vsce CLI Common Commands

```bash
# Install vsce globally
npm install -g @vscode/vsce

# Login to publisher account
vsce login <publisher-id>

# List publishers you have access to
vsce ls-publishers

# Package extension (creates .vsix file)
vsce package

# Publish extension
vsce publish

# Publish with specific version bump
vsce publish patch  # 1.0.0 -> 1.0.1
vsce publish minor  # 1.0.0 -> 1.1.0
vsce publish major  # 1.0.0 -> 2.0.0

# Publish specific version
vsce publish 1.2.3

# Unpublish extension (use with extreme caution)
vsce unpublish <publisher>.<extension>

# Validate packaging without publishing
vsce publish --dry-run

# Show extension info
vsce show <publisher>.<extension>

# Package with specific target (platform-specific extension)
vsce package --target win32-x64
```

### Contact Information

For questions or issues with the publisher account setup:

- **Primary Contact**: @christrudelpw (chris@generacy.ai)
- **Secondary Contact**: @mikezouhri
- **VS Code Marketplace Support**: [https://aka.ms/vscode-support](https://aka.ms/vscode-support)
- **Azure DevOps Support**: [https://developercommunity.visualstudio.com/](https://developercommunity.visualstudio.com/)

---

**Document Version**: 1.0
**Document Owner**: @christrudelpw
**Review Schedule**: Annually or as needed for process changes
