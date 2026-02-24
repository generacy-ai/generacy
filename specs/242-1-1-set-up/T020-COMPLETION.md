# Task T020 Completion Report

**Task**: Create stable release workflow for agency
**Status**: ✅ Complete
**Date**: 2026-02-24

## Objectives

Create a stable release workflow for the agency package that:
- Triggers on push to main branch
- Verifies @generacy-ai/latency is published with @latest tag
- Uses changesets/action for automated version management
- Creates "Version Packages" PR when changesets exist
- Publishes to npm with @latest tag when Version PR is merged

## Implementation

### Created Files

- `/workspaces/agency/.github/workflows/release.yml` - Stable release workflow

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
   - **Dependency Verification**: Runs `./packages/agency/scripts/verify-deps.sh latest`
   - Build packages
4. **Release Step**:
   - Uses `changesets/action@v1`
   - Version command: `pnpm changeset version`
   - Publish command: `pnpm changeset publish`
   - Commit message: "chore: version packages"
   - PR title: "chore: version packages"
   - Environment: GITHUB_TOKEN, NODE_AUTH_TOKEN, NPM_TOKEN

### Key Design Decisions

1. **Dependency Verification**: Added verification step to ensure @generacy-ai/latency is published with @latest tag before agency can be published. This prevents broken dependency chains.

2. **Build Before Changesets Action**: Added explicit build step to ensure packages are built before changesets action runs (following latency workflow pattern).

3. **Permissions**: Included all necessary permissions:
   - `contents: write` for version commits and git tags
   - `pull-requests: write` for creating Version Packages PR
   - `id-token: write` for npm provenance support

4. **Token Configuration**: Set both `NODE_AUTH_TOKEN` and `NPM_TOKEN` for compatibility with setup-node and changesets publish.

5. **Consistent Pattern**: Followed the same structure as latency release workflow for consistency.

6. **Verification Placement**: Dependency verification runs after install but before build, allowing early failure if dependencies are missing.

## Verification

✅ Workflow file created at correct path
✅ YAML syntax verified (manual inspection)
✅ Dependency verification step included
✅ Committed to develop branch
✅ Follows plan specifications from plan.md
✅ Matches pattern from latency release workflow
✅ Uses existing verify-deps.sh script from T014

## Git Commit

```
commit 8b3e52f
Author: [Author]
Date:   2026-02-24

    ci: add stable release workflow for agency

    - Trigger on push to main branch
    - Verify @generacy-ai/latency is published with @latest tag
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
3. **Dependency verification runs**: Checks that @generacy-ai/latency@latest is published
4. If verification fails, workflow stops with clear error message
5. Changesets action detects pending changesets
6. Creates/updates "Version Packages" PR with:
   - Updated package.json version
   - Generated CHANGELOG.md entries
   - Removed consumed changeset files

### Merging Version Packages PR

1. Maintainer reviews and merges Version Packages PR
2. Workflow triggers again on push to main
3. **Dependency verification runs again**: Ensures latency is still available
4. Changesets action detects no pending changesets but sees version bump
5. Builds packages
6. Publishes to npm with @latest tag
7. Creates git tags for published versions

### Dependency Chain Protection

The workflow prevents publishing agency if latency is not published:

- **Verification Step**: `./packages/agency/scripts/verify-deps.sh latest`
- **Checks**: @generacy-ai/latency@latest must exist on npm
- **Failure Behavior**: Workflow fails with clear error message
- **Publish Order Enforcement**: latency → agency → generacy

### Idempotency

The workflow is idempotent:
- If package version already exists on npm, publish step is skipped
- Re-running the workflow is safe
- Dependency verification is safe to run multiple times
- No manual cleanup needed after failures

## Differences from Latency Workflow

| Feature | Latency | Agency |
|---------|---------|--------|
| Dependency Verification | ❌ Not needed | ✅ Verifies latency@latest |
| Build Step | ✅ Yes | ✅ Yes |
| Changesets Action | ✅ v1 | ✅ v1 |
| Permissions | Same | Same |
| pnpm Version | 9.15.5 | 9.15.5 |

## Next Steps

This task is part of Phase 3C: Stable Release Workflows. Related tasks:

- **T021**: Create stable release workflow for generacy (will verify both latency and agency)
- **T026**: Enable branch protection for agency/main (requires T020 completion)

## Testing

The workflow will be tested as part of:
- **T041**: Test stable release for agency (manual validation task)
- **T043**: Test dependency chain publishing

Testing will verify:
1. Dependency verification works correctly
2. Version Packages PR creation
3. Changelog generation
4. Package publishing to npm
5. Git tag creation
6. Workflow re-run idempotency
7. Failure when latency@latest is missing

## Integration with Preview Workflow

This workflow complements the preview publish workflow (T017):

| Stream | Branch | Workflow | Dist-Tag | Verification |
|--------|--------|----------|----------|--------------|
| Preview | develop | publish-preview.yml | @preview | latency@preview |
| Stable | main | release.yml | @latest | latency@latest |

## Notes

- Dependency verification script created in T014
- Script path: `./packages/agency/scripts/verify-deps.sh`
- Build step is critical - must complete before changesets action runs
- Workflow uses same pnpm version (9.15.5) as preview workflow for consistency
- Verification runs before build to fail fast if dependencies are missing
- Agency depends only on latency (not generacy)
- Generacy workflow (T021) will verify both latency and agency

## Acceptance Criteria

All acceptance criteria from tasks.md met:

- [x] Create `release.yml` workflow
- [x] Trigger on push to main branch
- [x] Run dependency verification: `./packages/agency/scripts/verify-deps.sh latest`
- [x] Use changesets/action@v1
- [x] Version command: `pnpm changeset version`
- [x] Publish command: `pnpm changeset publish`
- [x] Commit message: "chore: version packages"
- [x] PR title: "chore: version packages"
- [x] Permissions: contents: write, pull-requests: write, id-token: write
- [x] Use GITHUB_TOKEN and NPM_TOKEN
- [x] Verify workflow syntax
- [x] Commit to develop branch
