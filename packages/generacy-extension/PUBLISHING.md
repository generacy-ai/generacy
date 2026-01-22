# Publishing the Generacy VS Code Extension

This document describes how to publish the Generacy extension to the VS Code Marketplace.

## CI/CD Workflow Setup

**Important**: The GitHub Actions workflow file is located at:
- `packages/generacy-extension/extension-publish.workflow.yml`

This file needs to be moved to `.github/workflows/extension-publish.yml` to be active. It's stored outside the workflows directory in the repository to avoid permission issues with automated commits.

To activate the workflow:
```bash
# Manually copy the workflow file (requires workflow scope PAT or manual commit)
cp packages/generacy-extension/extension-publish.workflow.yml .github/workflows/extension-publish.yml
git add .github/workflows/extension-publish.yml
git commit -m "chore: add extension publishing workflow"
git push
```

## Prerequisites

### 1. Create Publisher Account

1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with your Microsoft account
3. Create a publisher with ID: `generacy-ai`
4. Verify the publisher is created successfully

### 2. Generate Personal Access Token (PAT)

1. Go to https://dev.azure.com/
2. Click on "User settings" → "Personal access tokens"
3. Click "New Token"
4. Configure:
   - **Name**: `VS Code Extension Publishing`
   - **Organization**: All accessible organizations
   - **Expiration**: 90 days (or custom)
   - **Scopes**: Select "Marketplace" → "Manage"
5. Copy the generated token (you won't see it again!)

### 3. Configure GitHub Secrets

Add the PAT to GitHub repository secrets:

1. Go to repository: https://github.com/generacy-ai/generacy
2. Navigate to Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add secret:
   - **Name**: `VSCE_PAT`
   - **Value**: [paste your PAT here]

## Publishing Process

### Option 1: Automated Publishing (Recommended)

Triggered automatically when you push a git tag:

```bash
# Bump version in package.json first
cd packages/generacy-extension
npm version patch  # or minor, or major

# Push with tags
git add .
git commit -m "chore: bump extension version to X.Y.Z"
git tag extension-vX.Y.Z  # e.g., extension-v0.1.0
git push origin main --tags
```

The GitHub Actions workflow will:
1. Build the extension
2. Run tests
3. Package the extension
4. Publish to VS Code Marketplace
5. Create a GitHub release with the VSIX file

### Option 2: Manual Publishing via GitHub Actions

1. Go to Actions tab in GitHub repository
2. Select "Publish VS Code Extension" workflow
3. Click "Run workflow"
4. Enter the version to publish
5. Click "Run workflow" button

### Option 3: Local Manual Publishing

For testing or emergency publishing:

```bash
cd packages/generacy-extension

# Package the extension
npx vsce package --no-dependencies

# Publish to marketplace
npx vsce publish --pat YOUR_PAT_HERE --no-dependencies
```

## Version Management

Follow [Semantic Versioning](https://semver.org/):

- **Major** (X.0.0): Breaking changes
- **Minor** (0.X.0): New features (backwards compatible)
- **Patch** (0.0.X): Bug fixes (backwards compatible)

### Updating the Version

1. Update version in `package.json`
2. Update `CHANGELOG.md` with release notes
3. Commit changes: `git commit -m "chore: prepare release X.Y.Z"`
4. Create git tag: `git tag extension-vX.Y.Z`
5. Push: `git push origin main --tags`

## Pre-Publication Checklist

Before publishing, verify:

- [ ] All tests pass: `pnpm test`
- [ ] Extension builds successfully: `pnpm run build`
- [ ] Package creation works: `npx vsce package --no-dependencies`
- [ ] Version number is updated in `package.json`
- [ ] `CHANGELOG.md` is updated with release notes
- [ ] README.md is up to date
- [ ] Icon (resources/icon.png) is present and correct (128x128 PNG)
- [ ] All commands are properly registered
- [ ] Extension can be installed and activated in VS Code

## Testing the Packaged Extension

Test the VSIX package locally before publishing:

```bash
# Install the packaged extension
code --install-extension generacy-extension-X.Y.Z.vsix

# Or test in a clean VS Code instance
code --extensionDevelopmentPath=/path/to/extension
```

## Post-Publication Verification

After publishing:

1. Wait 5-10 minutes for marketplace to update
2. Search for "Generacy" in VS Code Extensions
3. Verify:
   - Extension appears in search results
   - Icon and description are correct
   - Installation works
   - All features function as expected

## Troubleshooting

### Publishing Fails

**Error**: `ENOTFOUND marketplace.visualstudio.com`
- **Solution**: Check internet connection and marketplace status

**Error**: `Failed request: Unauthorized(401)`
- **Solution**: Verify PAT is valid and has correct scopes

**Error**: `The specified publisher 'generacy-ai' does not exist`
- **Solution**: Create publisher account at https://marketplace.visualstudio.com/manage

### Extension Not Appearing

- Clear VS Code extensions cache
- Wait up to 15 minutes for marketplace indexing
- Check marketplace status: https://status.dev.azure.com/

### Version Conflicts

**Error**: `Extension 'generacy-ai.generacy-extension' version 'X.Y.Z' already exists`
- **Solution**: Increment version number in package.json

## Resources

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
- [Azure DevOps PAT Documentation](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
