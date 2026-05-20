# Quickstart: Fix stale @latest dist-tag

## What changed

One step replaced in `.github/workflows/release.yml`:
- **Removed**: Single-package `Add @stable dist-tag` step (redundant)
- **Added**: `Advance @latest dist-tag for all stable releases` step (loops over all published packages)

## Verification after merge

### 1. Check the next stable release CI run

After merge to `main`, the next changeset-driven release will run the new step. In the GitHub Actions log, look for:

```
Setting @generacy-ai/generacy@0.1.x as @latest
Setting @generacy-ai/orchestrator@0.1.x as @latest
...
```

### 2. Verify dist-tags via npm

```bash
# Check a specific package
npm view @generacy-ai/generacy dist-tags

# Check all packages at once
for pkg in generacy orchestrator workflow-engine knowledge-store cluster-relay \
           control-plane credhelper credhelper-daemon activation-client config \
           generacy-plugin-claude-code generacy-plugin-cloud-build \
           generacy-plugin-copilot generacy-plugin-github-actions \
           generacy-plugin-github-issues generacy-plugin-jira; do
  echo "=== @generacy-ai/$pkg ==="
  npm view @generacy-ai/$pkg dist-tags
done
```

Expected: `@latest` and `@stable` point at the same version (e.g., `0.1.3`).

### 3. Verify preview doesn't touch @latest

After a preview publish (push to `develop`), verify:
```bash
npm view @generacy-ai/generacy dist-tags
```
`@latest` should NOT change. Only `@preview` should update.

## One-time manual cleanup

Run this ONCE after the workflow fix merges, to fix the currently-stale `@latest` tags without waiting for each package to get a new stable release:

```bash
# Requires npm login with publish permissions to @generacy-ai scope
for pkg in generacy orchestrator workflow-engine knowledge-store cluster-relay \
           control-plane credhelper credhelper-daemon activation-client config \
           generacy-plugin-claude-code generacy-plugin-cloud-build \
           generacy-plugin-copilot generacy-plugin-github-actions \
           generacy-plugin-github-issues generacy-plugin-jira; do
  stable=$(npm view @generacy-ai/$pkg dist-tags.stable)
  echo "Setting @generacy-ai/$pkg@$stable as @latest"
  npm dist-tag add @generacy-ai/$pkg@$stable latest
done
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `npm dist-tag add` returns 403 | Token lacks dist-tag permission | Verify `NPM_TOKEN` has publish access to `@generacy-ai` scope |
| `jq` parse error in CI | `publishedPackages` output empty or malformed | Check that changesets actually published (look for `published == 'true'`) |
| `@latest` still stale after release | Package wasn't in the changeset | Package needs a changeset entry to be included in the next release |
