# Quickstart: Fix `workspace:^` leak

## Prerequisites

- Node.js >=22
- pnpm 9.x
- npm registry access (NPM_TOKEN for publishing)

## Local Verification

### Check current state of published orchestrator

```bash
npm pack @generacy-ai/orchestrator@0.1.1
tar -xzf generacy-ai-orchestrator-0.1.1.tgz
jq '.dependencies | to_entries[] | select(.value | startswith("workspace:"))' package/package.json
rm -rf package generacy-ai-orchestrator-0.1.1.tgz
```

### Test the prepublishOnly guard locally

```bash
# From repo root
pnpm install

# Try a dry-run publish of orchestrator (should fail with workspace: error)
cd packages/orchestrator
pnpm publish --dry-run --no-git-checks
# Expected: ERROR from prepublishOnly if workspace: deps not rewritten

# The guard passes when pnpm properly rewrites deps:
cd ../..
pnpm publish --filter @generacy-ai/orchestrator --dry-run --no-git-checks
# Expected: pnpm rewrites workspace: → semver, guard passes
```

### Run the validation script standalone

```bash
cd packages/orchestrator
node ../../scripts/check-workspace-deps.js
# Expected: exits non-zero with list of workspace: deps (pre-publish context)
```

## Publishing Flow

1. Create a changeset:
   ```bash
   pnpm changeset
   # Select @generacy-ai/orchestrator, patch bump
   # Message: "fix: rewrite workspace: deps in published package"
   ```

2. Commit and push to develop, then merge to main

3. Release workflow runs automatically:
   - `pnpm changeset version` bumps orchestrator + dependents
   - `pnpm changeset publish --tag stable --provenance` publishes
   - `prepublishOnly` runs per-package, catching any `workspace:` leak

## Post-Publish Verification

```bash
# Verify the new orchestrator version
npm pack @generacy-ai/orchestrator@<new-version>
tar -xzf generacy-ai-orchestrator-<new-version>.tgz
grep -r "workspace:" package/package.json
# Expected: no output (no workspace: literals)

# End-to-end test
npx -y @generacy-ai/generacy@stable --version
# Expected: installs successfully, prints version
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `prepublishOnly` fails in CI | Ensure `pnpm changeset publish` runs from workspace root, not individual package dirs |
| Script path `../../scripts/` not found | Verify package is at `packages/<name>/` level; check cwd in CI logs |
| `workspace:` still in published tarball | Check that pnpm version supports workspace protocol rewrite; upgrade if needed |
| Changesets doesn't bump orchestrator | Ensure a changeset file exists that includes `@generacy-ai/orchestrator` |
