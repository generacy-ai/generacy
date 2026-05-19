# Quickstart: Manual Preview Release

## After This Change

Preview publishing no longer triggers automatically on push to `develop`. You must manually dispatch it.

## How to Trigger a Preview Release

### Option 1: GitHub CLI

```bash
gh workflow run publish-preview.yml --ref develop
```

To watch the run:

```bash
gh run list --workflow=publish-preview.yml --limit=1
gh run watch <run-id>
```

### Option 2: GitHub Actions UI

1. Go to **Actions** tab in the repository
2. Select **Publish Preview** workflow in the left sidebar
3. Click **Run workflow** button
4. Select `develop` branch (or another branch)
5. Click **Run workflow**

## What Gets Published

Both jobs run in sequence:
1. **publish-npm** — builds all packages, applies changeset snapshot versioning, publishes to npm with `preview` tag
2. **publish-devcontainer-feature** — publishes the devcontainer feature in preview mode (runs after publish-npm completes)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "workflow does not exist" error | Ensure the workflow file is on the default branch or the target ref |
| No changeset files found | The workflow auto-generates a synthetic changeset — this is expected |
| publish-devcontainer-feature skipped | Check that publish-npm succeeded — it's a `needs` dependency |

## Reverting to Auto-Publish

When the spawn-refactor is complete and you want to restore auto-publishing, change the trigger back:

```yaml
on:
  push:
    branches: [develop]
```
