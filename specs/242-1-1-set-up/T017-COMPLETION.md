# T017 Completion Report

**Task**: Create preview publish workflow for agency
**Date**: 2026-02-24
**Status**: ✅ Complete

## Summary

Successfully created the preview publish workflow for the agency repository. The workflow automatically publishes snapshot versions to npm with the `@preview` dist-tag when changes are pushed to the develop branch, after verifying that all @generacy-ai/* dependencies are available.

## Files Created

- `/workspaces/agency/.github/workflows/publish-preview.yml`

## Implementation Details

### Workflow Features

1. **Trigger**: Runs on push to `develop` branch
2. **Changeset Detection**: Checks for pending changesets before proceeding
3. **Dependency Verification**: Validates that @generacy-ai/latency@preview is published before proceeding
4. **Snapshot Versioning**: Creates snapshot versions using `pnpm changeset version --snapshot preview`
5. **Build Step**: Runs `pnpm build` to compile packages
6. **Publishing**: Publishes to npm with `@preview` dist-tag using `pnpm changeset publish --no-git-tag --tag preview`
7. **Summary**: Adds a GitHub Actions summary with installation instructions

### Key Configuration

- **Node.js**: Version 20
- **pnpm**: Version 9.15.5
- **Registry**: https://registry.npmjs.org
- **Permissions**:
  - `contents: read` - for checking out code
  - `id-token: write` - for npm provenance
- **Secrets**: Uses `NPM_TOKEN` from GitHub organization secrets

### Workflow Logic

The workflow includes conditional execution:
- If no changesets are found, the workflow exits gracefully without publishing
- Dependency verification runs before versioning to ensure dependencies are available
- All build and publish steps only run if changesets are detected and dependencies verified
- This prevents unnecessary workflow runs and broken publishes

### Dependency Verification

The workflow includes a critical dependency verification step that:
- Runs the `./packages/agency/scripts/verify-deps.sh preview` script
- Verifies that @generacy-ai/latency@preview is published to npm
- Prevents agency from being published with missing dependencies
- Enforces the publish order: latency → agency → generacy

### Error Handling

- Uses `--frozen-lockfile` to ensure consistent dependencies
- Uses `--no-git-tag` to prevent git tagging on snapshot releases
- Includes `fetch-depth: 0` to ensure full git history for changeset detection
- Fails fast if dependency verification fails

## Verification

✅ Workflow file created at correct location
✅ YAML syntax verified (manual review)
✅ Follows same pattern as latency workflow (T016)
✅ Includes dependency verification step (T014)
✅ Committed to develop branch

## Comparison with T016 (Latency Workflow)

The agency workflow is based on the latency workflow with these key additions:

1. **Dependency Verification Step**: Added step to verify @generacy-ai/latency@preview
   ```yaml
   - name: Verify dependencies
     if: steps.check-changesets.outputs.has_changesets == 'true'
     run: |
       cd packages/agency
       ./scripts/verify-deps.sh preview
   ```

2. **Package Name**: Updated summary to reference @generacy-ai/agency

All other aspects (node version, pnpm version, changeset workflow, build process) are identical to ensure consistency across packages.

## Git Commit

```
commit ee7c17b
Author: [developer]
Date: 2026-02-24

ci: add preview publish workflow for agency package

- Triggers on push to develop branch
- Checks for pending changesets before publishing
- Verifies @generacy-ai/latency@preview dependency is available
- Creates snapshot versions with @preview dist-tag
- Builds packages and publishes to npm
- Includes summary step for visibility

Depends on T012 (CI workflow) and T014 (dependency verification script)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

## Dependencies

This task depended on:
- **T012**: CI workflow for agency (provides base CI structure)
- **T014**: Dependency verification script (verify-deps.sh)

## Next Steps

This task is complete. The workflow will be tested in T038 (Test preview publish for agency), which depends on T037 (Test preview publish for latency) completing first to ensure the dependency is available.

## Notes

- The workflow uses the same pnpm version (9.15.5) as specified in package.json
- The workflow is designed to be idempotent - can be safely re-run
- The summary step provides clear feedback to developers about successful publishes
- The changeset check prevents empty publishes when no changes are pending
- The dependency verification ensures publish order is maintained: latency → agency → generacy
- The script runs from `packages/agency` directory to access the verify-deps.sh script

## Integration with Publish Order

This workflow enforces the required publish order through dependency verification:
1. Latency must publish first (no dependencies)
2. Agency can only publish if latency@preview is available ← **This workflow**
3. Generacy can only publish if both latency@preview and agency@preview are available

This prevents broken dependency chains and ensures all packages are published in the correct order.

## Task Status: Complete ✅

All subtasks completed successfully. The workflow is ready for testing in Phase 6 (T038).
