# Quickstart: Verify @stable dist-tag

**Feature**: #656 | **Date**: 2026-05-19

## How It Works

On every merge to `main` that triggers a Changesets publish, the release workflow now:
1. Publishes packages to npm with `@latest` (unchanged behavior)
2. Adds the `@stable` dist-tag to `@generacy-ai/generacy` at the published version

## Verification

After the first release with this change, verify:

```bash
# Check all dist-tags
npm view @generacy-ai/generacy dist-tags

# Expected output includes:
# latest: <version>
# stable: <version>
# preview: 0.0.0-preview-<timestamp>

# Verify @stable resolves correctly
npm view @generacy-ai/generacy@stable version

# Verify @latest is still advanced
npm view @generacy-ai/generacy@latest version

# Both should show the same version
```

## Troubleshooting

### `@stable` tag not appearing

1. Check the GitHub Actions run for the `release` workflow
2. Look for the "Add @stable dist-tag" step output
3. If the step was skipped, `@generacy-ai/generacy` may not have been in `publishedPackages` (only other monorepo packages were versioned)

### npm auth error in dist-tag step

The step uses the same `NPM_TOKEN` as the publish step. If publish succeeded but dist-tag failed, the token may have been rotated mid-workflow (unlikely). Re-run the workflow.

### `@latest` not advancing

This change does NOT modify the publish step. If `@latest` isn't advancing, the issue is in the Changesets action configuration, not this change.
