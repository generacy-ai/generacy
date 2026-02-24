# T003: Configure GitHub Organization Secret for NPM Publishing

**Status**: Ready for execution
**Date**: 2026-02-24
**Task**: Set up `NPM_TOKEN` as GitHub organization secret

## Prerequisites

- [ ] GitHub organization admin access to `generacy-ai`
- [ ] NPM token from T002 (automation token with read/write permissions)
- [ ] Access to the following repositories: `latency`, `agency`, `generacy`

## Step-by-Step Instructions

### 1. Navigate to Organization Secrets

1. Open your browser and go to: [GitHub Organization Secrets](https://github.com/organizations/generacy-ai/settings/secrets/actions)
2. Sign in if prompted with an account that has admin access to the `generacy-ai` organization

### 2. Create New Organization Secret

1. Click the **"New organization secret"** button (green button, top right)
2. You will see a form with the following fields:

### 3. Configure Secret Details

Fill in the form as follows:

**Name**:
```
NPM_TOKEN
```
⚠️ Important: Use exactly this name (all caps, underscore) - this is what the GitHub Actions workflows will reference.

**Secret**:
- Paste the NPM token you generated in T002
- The token should start with `npm_` (automation token format)
- Do NOT include quotes or extra whitespace
- The token should look like: `npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

**Repository access**:
- Select **"Public repositories"** (radio button option)
- This ensures the secret is available to `latency`, `agency`, and `generacy` repositories

### 4. Save the Secret

1. Click the **"Add secret"** button
2. You should see a success message confirming the secret was created
3. The secret should now appear in the organization secrets list with:
   - Name: `NPM_TOKEN`
   - Updated: [current timestamp]
   - Repository access: Public repositories

### 5. Verify Secret Availability

For each of the three repositories, verify the secret is accessible:

#### Latency Repository
1. Navigate to: https://github.com/generacy-ai/latency/settings/secrets/actions
2. Scroll to **"Organization secrets"** section
3. Confirm `NPM_TOKEN` is listed with "Public repositories" access

#### Agency Repository
1. Navigate to: https://github.com/generacy-ai/agency/settings/secrets/actions
2. Scroll to **"Organization secrets"** section
3. Confirm `NPM_TOKEN` is listed with "Public repositories" access

#### Generacy Repository
1. Navigate to: https://github.com/generacy-ai/generacy/settings/secrets/actions
2. Scroll to **"Organization secrets"** section
3. Confirm `NPM_TOKEN` is listed with "Public repositories" access

## Verification Checklist

- [ ] Secret named `NPM_TOKEN` created in organization
- [ ] Secret value is the automation token from T002 (starts with `npm_`)
- [ ] Repository access set to "Public repositories"
- [ ] Secret appears in `latency` repository secrets list
- [ ] Secret appears in `agency` repository secrets list
- [ ] Secret appears in `generacy` repository secrets list

## Security Notes

✅ **Good Practices**:
- Organization-level secret reduces duplication and management overhead
- Public repository scope limits exposure to only necessary repos
- Automation token provides appropriate read/write permissions without full account access

⚠️ **Security Reminders**:
- Never commit the NPM token to the repository
- Never log or echo the token value in CI workflows
- Rotate the token if it's ever exposed or compromised
- Use `${{ secrets.NPM_TOKEN }}` in GitHub Actions workflows (never hardcode)

## Troubleshooting

### Secret not appearing in repository
- Ensure the repository is set to "Public" visibility
- Verify you selected "Public repositories" for repository access
- Check organization permissions (Settings → Member privileges → Base permissions)

### Permission errors during workflow runs
- Verify the NPM token has publish permissions for `@generacy-ai` scope
- Check that the token hasn't expired
- Confirm the token is an automation token, not a classic token

### Secret update needed
- Go back to organization secrets: https://github.com/organizations/generacy-ai/settings/secrets/actions
- Click "Update" next to `NPM_TOKEN`
- Paste the new token value
- Save changes

## Next Steps

After completing this task:
- ✅ T003 completed - Organization secret configured
- ➡️ Proceed to T004: Create `.changeset/config.json` in each repository
- ➡️ T005: Implement GitHub Actions workflows for preview and stable releases

## References

- [GitHub Actions: Encrypted Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [npm: Creating and viewing access tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens)
- [Changesets: GitHub Action](https://github.com/changesets/action)
