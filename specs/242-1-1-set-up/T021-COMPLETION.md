# T021 Completion Report: Create stable release workflow for generacy

**Task ID**: T021
**Status**: ✅ COMPLETE
**Date**: 2026-02-24
**Feature**: 242-1-1-set-up (Set up npm publishing for @generacy-ai packages)

## Summary

Successfully created and committed the stable release workflow (`release.yml`) for the @generacy-ai/generacy package. This workflow enables automated semantic versioning and publishing to npm with the `@latest` dist-tag when changes are merged to the `main` branch.

## Implementation Details

### Files Created
- `/workspaces/generacy/.github/workflows/release.yml` (49 lines)

### Workflow Configuration

**Trigger**: Push to `main` branch

**Key Steps**:
1. **Checkout**: Fetches full git history (required for changesets)
2. **Setup**: Configures pnpm (9.15.9), Node.js (20), and npm registry
3. **Install**: Installs dependencies with frozen lockfile
4. **Verify Dependencies**: Runs `./scripts/verify-deps.sh latest` to ensure @generacy-ai/latency and @generacy-ai/agency are published with `@latest` dist-tag
5. **Build**: Builds the package
6. **Release**: Uses `changesets/action@v1` to:
   - Create "Version Packages" PR when changesets are detected
   - Automatically publish to npm when PR is merged

**Permissions**:
- `contents: write` - Create version commits and tags
- `pull-requests: write` - Create/update "Version Packages" PR
- `id-token: write` - Enable npm provenance

**Environment Variables**:
- `GITHUB_TOKEN` - For git operations and PR creation
- `NODE_AUTH_TOKEN` & `NPM_TOKEN` - For npm publishing

### Architecture Consistency

This workflow follows the same pattern as:
- `/workspaces/latency/.github/workflows/release.yml` (base pattern)
- `/workspaces/agency/.github/workflows/release.yml` (with dependency verification)

The key difference from latency is the inclusion of the dependency verification step, ensuring that the publish order (latency → agency → generacy) is enforced.

### Dual-Stream Publishing

With this workflow, the @generacy-ai/generacy package now supports:

| Stream | Branch | Trigger | Dist-Tag | Version Format | Workflow |
|--------|--------|---------|----------|----------------|----------|
| **Preview** | develop | Push to develop | @preview | 0.0.0-preview.YYYYMMDDHHmmss | publish-preview.yml |
| **Stable** | main | Push to main | @latest | x.y.z (semver) | release.yml |

## Verification Steps Performed

1. ✅ File created at correct path
2. ✅ File is readable and well-formed
3. ✅ Workflow matches pattern from latency and agency repos
4. ✅ Includes dependency verification step (required for generacy)
5. ✅ Uses correct pnpm version (9.15.9, matching preview workflow)
6. ✅ Committed to develop branch with descriptive message

## Git Commit

**Branch**: 242-1-1-set-up
**Commit**: 3f6a95b
**Message**: ci: add stable release workflow for @generacy-ai/generacy

## Dependencies

**Depends on**: T018 (Create preview publish workflow for generacy)
**Blocks**: T027 (Enable branch protection for generacy/main)

## Next Steps

1. **T027**: Enable branch protection for generacy/main (manual task)
   - Require PR before merging
   - Require CI checks to pass (lint, test, build)
   - Prevent force pushes

2. **T030**: Create PUBLISHING.md documentation
   - Document how to create changesets
   - Explain preview vs stable release workflows
   - Include troubleshooting guidance

3. **T042**: Test stable release for generacy (manual validation)
   - Create PR from develop to main
   - Verify "Version Packages" PR is created
   - Verify dependency verification passes
   - Verify publish to npm with @latest tag

## Notes

- The workflow will not run until changes are merged to the `main` branch
- The dependency verification step ensures that @generacy-ai/latency and @generacy-ai/agency must be published with `@latest` before generacy can be published
- The changesets/action will only create a "Version Packages" PR if changesets are detected in the repository
- Once the "Version Packages" PR is merged, the workflow runs again and publishes the package to npm

## Related Documentation

- [Changesets Documentation](https://github.com/changesets/changesets)
- [changesets/action](https://github.com/changesets/action)
- [GitHub Actions Workflow Syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)

---

**Task Complete** ✅
