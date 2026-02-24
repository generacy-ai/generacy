# Task T018 Completion Report

**Task**: Create preview publish workflow for generacy
**Status**: ✅ Complete
**Date**: 2026-02-24
**Commit**: 1dcc349

## Summary

Created the preview publish workflow (`publish-preview.yml`) for the generacy repository. This workflow automatically publishes preview versions to npm with the `@preview` dist-tag when changes are pushed to the `develop` branch.

## Changes Made

### Files Created
- `/workspaces/generacy/.github/workflows/publish-preview.yml` (75 lines)

### Workflow Features

1. **Trigger**: Automatic on push to `develop` branch
2. **Changeset Detection**: Checks for pending changesets and skips publish if none exist
3. **Dependency Verification**: Runs `./scripts/verify-deps.sh preview` to ensure `@generacy-ai/latency` and `@generacy-ai/agency` are published with `@preview` tag
4. **Snapshot Versioning**: Creates preview versions with format `*-preview.YYYYMMDDHHmmss`
5. **Build Step**: Runs `pnpm build` before publishing
6. **npm Publish**: Publishes to npm with `@preview` dist-tag using `NPM_TOKEN` secret
7. **Summary Output**: Provides GitHub Actions step summary with installation instructions

### Configuration Details

- **pnpm version**: 9.15.9 (matches CI workflow)
- **Node.js version**: 20
- **Registry**: https://registry.npmjs.org
- **Permissions**: `contents: read`, `id-token: write`
- **Environment Variables**: `NODE_AUTH_TOKEN`, `NPM_TOKEN`

## Workflow Steps

```yaml
1. Checkout code (fetch-depth: 0 for changeset history)
2. Setup pnpm (v9.15.9)
3. Setup Node.js (v20 with pnpm cache)
4. Install dependencies (frozen-lockfile)
5. Check for pending changesets (conditional)
6. Verify dependencies exist with @preview tag (conditional)
7. Create snapshot versions (conditional)
8. Build packages (conditional)
9. Publish to npm (conditional)
10. Output summary (conditional)
```

## Dependencies

This task depends on:
- **T013**: CI workflow for generacy (completed)
- **T015**: Dependency verification script (completed)

## Verification

### Syntax Validation
- ✅ Workflow file created successfully
- ✅ YAML structure matches agency workflow pattern
- ✅ All conditional steps properly configured
- ✅ verify-deps.sh script is executable and in correct location

### Differences from Agency Workflow
1. **pnpm version**: Updated to 9.15.9 (agency uses 9.15.5)
2. **verify-deps.sh path**: Simplified to `./scripts/verify-deps.sh` (no `packages/agency/` prefix)
3. **Package name**: Changed to `@generacy-ai/generacy` in summary

## Next Steps

1. **T021**: Create stable release workflow for generacy (pending)
2. **T024**: Update package.json for generacy publishing (pending)
3. **T039**: Test preview publish for generacy (manual validation task)

## Testing Recommendations

Before testing this workflow:
1. Ensure `@generacy-ai/latency@preview` is published
2. Ensure `@generacy-ai/agency@preview` is published
3. Create a test changeset in generacy repo
4. Push to develop and monitor workflow execution
5. Verify npm package is published with correct version format
6. Verify dependency verification step passes

## Notes

- This workflow will only publish if changesets are present
- Dependency verification ensures publish order (latency → agency → generacy)
- Snapshot versions include timestamp for uniqueness
- GitHub Actions summary provides user-friendly installation instructions
- Workflow is idempotent and safe to re-run

## References

- Agency workflow: `/workspaces/agency/.github/workflows/publish-preview.yml`
- CI workflow: `/workspaces/generacy/.github/workflows/ci.yml`
- Dependency verification: `/workspaces/generacy/scripts/verify-deps.sh`
- Tasks file: `/workspaces/generacy/specs/242-1-1-set-up/tasks.md`
