# T005 Progress: Generate Marketplace Publishing PAT

**Task**: Generate Personal Access Token for VS Code Marketplace publishing
**Status**: In Progress
**Started**: 2026-02-24

## Objective

Generate a PAT in Azure DevOps with Marketplace publishing permissions and securely document it for GitHub secret storage.

## Steps Completed

- [x] Created progress tracking file

## Current Step

- [ ] Navigate to Azure DevOps PAT creation page
- [ ] Create new token with marketplace publishing permissions
- [ ] Document token details and expiration date

## Token Configuration Requirements

### Token Settings
- **Name**: "VS Code Marketplace Publishing"
- **Organization**: generacy-ai (Azure DevOps)
- **Expiration**: 1 year from creation (recommended for production use)
- **Scopes**:
  - Marketplace: **Manage** (required for publishing extensions)

### Security Notes
- Token will be copied immediately after generation (only shown once)
- Token will be stored as GitHub organization secret: `VSCE_PAT`
- Exact expiration date will be recorded in YYYY-MM-DD format

## Token Details

**Token Name**: [To be recorded]
**Expiration Date**: [To be recorded - YYYY-MM-DD]
**Token Value**: [Copied to secure temporary location]
**Verification**: [Token appears in Azure DevOps token list]

## Next Steps

1. Navigate to https://dev.azure.com/generacy-ai/_usersSettings/tokens
2. Click "New Token" button
3. Configure token with settings above
4. Generate and immediately copy token
5. Verify token in list
6. Proceed to T006 (Store PAT as GitHub org secret)

## Issues & Blockers

None at this time.

---

**Last Updated**: 2026-02-24
