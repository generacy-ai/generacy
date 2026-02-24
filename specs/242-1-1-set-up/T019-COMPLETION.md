# Task T019 Completion Report

**Task**: Create stable release workflow for latency
**Status**: ✅ Complete
**Date**: 2026-02-24

## Objectives

Create a stable release workflow that:
- Triggers on push to main branch
- Uses changesets/action for automated version management
- Creates "Version Packages" PR when changesets exist
- Publishes to npm with @latest tag when Version PR is merged

## Implementation

### Created Files

- `/workspaces/latency/.github/workflows/release.yml` - Stable release workflow

### Workflow Configuration

The workflow includes:

1. **Trigger**: Push to `main` branch
2. **Permissions**:
   - `contents: write` - For creating version commits and tags
   - `pull-requests: write` - For creating Version Packages PR
   - `id-token: write` - For npm provenance
3. **Setup Steps**:
   - Checkout with full history (fetch-depth: 0)
   - pnpm setup (v9.15.5)
   - Node.js 20 with npm registry configuration
   - Install dependencies with frozen lockfile
   - Build packages
4. **Release Step**:
   - Uses `changesets/action@v1`
   - Version command: `pnpm changeset version`
   - Publish command: `pnpm changeset publish`
   - Commit message: "chore: version packages"
   - PR title: "chore: version packages"
   - Environment: GITHUB_TOKEN, NODE_AUTH_TOKEN, NPM_TOKEN

### Key Design Decisions

1. **Build Before Changesets Action**: Added explicit build step to ensure packages are built before changesets action runs (following preview workflow pattern)

2. **Permissions**: Included all necessary permissions:
   - `contents: write` for version commits and git tags
   - `pull-requests: write` for creating Version Packages PR
   - `id-token: write` for npm provenance support

3. **Token Configuration**: Set both `NODE_AUTH_TOKEN` and `NPM_TOKEN` for compatibility with setup-node and changesets publish

4. **Consistent Pattern**: Followed the same structure as preview workflow for consistency

## Verification

✅ Workflow file created at correct path
✅ YAML syntax verified (manual inspection)
✅ Committed to develop branch
✅ Follows plan specifications from plan.md
✅ Matches pattern from existing preview workflow
✅ No dependency verification needed (latency is first in chain)

## Git Commit

```
commit 00f3b33
Author: [Author]
Date:   [Date]

    ci: add stable release workflow for latency

    - Trigger on push to main branch
    - Use changesets/action@v1 for version management
    - Create "Version Packages" PR when changesets exist
    - Publish to npm with @latest tag when Version PR is merged
    - Include proper permissions for contents and pull requests
    - Use build step before publish
    - Configure NPM_TOKEN for npm authentication

    Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

## How It Works

### First Push to Main with Changesets

1. Developer merges PR with changesets from develop to main
2. Workflow triggers on push to main
3. Changesets action detects pending changesets
4. Creates/updates "Version Packages" PR with:
   - Updated package.json version
   - Generated CHANGELOG.md entries
   - Removed consumed changeset files

### Merging Version Packages PR

1. Maintainer reviews and merges Version Packages PR
2. Workflow triggers again on push to main
3. Changesets action detects no pending changesets but sees version bump
4. Builds packages
5. Publishes to npm with @latest tag
6. Creates git tags for published versions

### Idempotency

The workflow is idempotent:
- If package version already exists on npm, publish step is skipped
- Re-running the workflow is safe
- No manual cleanup needed after failures

## Next Steps

This task is part of Phase 3C: Stable Release Workflows. Related tasks:

- **T020**: Create stable release workflow for agency (includes dependency verification)
- **T021**: Create stable release workflow for generacy (includes dependency verification)
- **T025**: Enable branch protection for latency/main (requires T019 completion)

## Testing

The workflow will be tested as part of:
- **T040**: Test stable release for latency (manual validation task)

Testing will verify:
1. Version Packages PR creation
2. Changelog generation
3. Package publishing to npm
4. Git tag creation
5. Workflow re-run idempotency

## Notes

- No dependency verification script needed for latency (it's the base package)
- Agency and generacy workflows will include dependency verification steps
- Build step is critical - must complete before changesets action runs
- Workflow uses same pnpm version (9.15.5) as preview workflow for consistency
