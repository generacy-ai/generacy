# npm Automation Token Details

**Created**: [YYYY-MM-DD]
**Created By**: [Your Name/Username]
**Token Type**: Automation (Read/Write)
**Purpose**: GitHub Actions automated publishing for @generacy-ai packages

## Permissions
- ✅ Read packages
- ✅ Publish packages
- ✅ Organization: @generacy-ai

## Used In
- GitHub Actions workflows in:
  - generacy-ai/latency (.github/workflows/publish-preview.yml, .github/workflows/release.yml)
  - generacy-ai/agency (.github/workflows/publish-preview.yml, .github/workflows/release.yml)
  - generacy-ai/generacy (.github/workflows/publish-preview.yml, .github/workflows/release.yml)

## Storage Locations
- ✅ GitHub organization secret: `NPM_TOKEN` (configured in T003)
- ✅ Password manager: [1Password/Bitwarden/LastPass/etc.]
- ✅ Backup location: [Optional secure backup location]

## Rotation Schedule
- **Next Rotation**: [YYYY-MM-DD] (1 year from creation)
- **Rotation Policy**: See `/workspaces/tetrad-development/docs/NPM_TOKEN_ROTATION.md`
- **Last Rotated**: [YYYY-MM-DD] (same as created initially)

## Security Notes
- Token has read/write access to all packages in @generacy-ai organization
- Token does not expire automatically (manual rotation required)
- In case of compromise, immediately follow emergency rotation procedure:
  1. Revoke token on npmjs.com
  2. Generate new token
  3. Update GitHub organization secret
  4. Verify all workflows still pass
  5. Document incident

## Token Metadata
- **Token ID**: [Token ID from npm, e.g., abc123def456]
- **Token Prefix**: npm_[first 4 chars]...
- **Created via**: npmjs.com web interface
- **Scope**: Organization-wide (@generacy-ai)

## Verification Commands
```bash
# DO NOT run these commands with the actual token in shell history
# Use environment variables or .envrc files

# Test authentication
npm whoami --registry=https://registry.npmjs.org/ --//registry.npmjs.org/:_authToken=$NPM_TOKEN

# Test publish access (dry-run)
npm publish --dry-run --//registry.npmjs.org/:_authToken=$NPM_TOKEN
```

## Access Control
- **Token Owner**: [Organization admin username]
- **Access Level**: Publish (includes read)
- **IP Restrictions**: None (required for GitHub Actions)
- **2FA Enforcement**: Organization-level 2FA applies to token creation

## Audit Log
| Date | Action | Performed By | Notes |
|------|--------|--------------|-------|
| [YYYY-MM-DD] | Token created | [Username] | Initial setup for T002 |
| [YYYY-MM-DD] | Added to GitHub | [Username] | Configured as org secret in T003 |
| [Future Date] | Token rotated | [Username] | Annual rotation |

## Emergency Contact
In case of security incident or compromised token:
1. Contact: [Security lead/Admin contact]
2. Revoke token immediately at: https://www.npmjs.com/settings/YOUR_USERNAME/tokens
3. Follow incident response procedure in security documentation

---

**Template Version**: 1.0
**Last Updated**: 2026-02-24

## Instructions for Use
1. Copy this template to `T002-npm-token-details.md` after generating token
2. Fill in all [bracketed] placeholders with actual values
3. Do NOT include the actual token value in this file
4. Keep this file in the specs directory (not committed to public repos if sensitive)
5. Update audit log whenever token is used/modified/rotated
