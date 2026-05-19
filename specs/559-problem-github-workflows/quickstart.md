# Quickstart: Auto-publish cluster images

## What This Does

A GitHub Actions cron workflow (`poll-cluster-images.yml`) runs every 5 minutes and checks if `cluster-base` or `cluster-microservices` repos have new commits that haven't been built into Docker images yet. If so, it dispatches the existing publish workflows automatically.

## Files

| File | Action |
|------|--------|
| `.github/workflows/poll-cluster-images.yml` | **NEW** — Cron poll workflow |
| `.github/workflows/publish-cluster-base-image.yml` | Unchanged |
| `.github/workflows/publish-cluster-microservices-image.yml` | Unchanged |

## Verification

### 1. Check the workflow is running

After merging to `develop`, verify the cron workflow appears in GitHub Actions:

```bash
gh run list --workflow=poll-cluster-images.yml --limit=5
```

### 2. Simulate a new commit detection

Push a commit to `cluster-base` develop, then wait ~5-20 minutes and check:

```bash
# Check if the publish workflow was dispatched
gh run list --workflow=publish-cluster-base-image.yml --limit=5

# Verify the new SHA tag exists in GHCR
gh api /orgs/generacy-ai/packages/container/cluster-base/versions \
  --jq '.[0].metadata.container.tags'
```

### 3. Verify deduplication

Run the poll workflow manually when images are already up-to-date:

```bash
gh workflow run poll-cluster-images.yml
```

Check the logs — all matrix entries should show "already published, skipping".

### 4. Manual dispatch still works

The existing publish workflows are unchanged:

```bash
gh workflow run publish-cluster-base-image.yml -f ref=develop
gh workflow run publish-cluster-microservices-image.yml -f ref=main
```

## Troubleshooting

### Poll workflow runs but never dispatches

1. Check if the `GITHUB_TOKEN` has cross-repo read access:
   ```bash
   gh api /repos/generacy-ai/cluster-base/commits/develop --jq '.sha'
   ```
2. Check if GHCR packages are accessible:
   ```bash
   gh api /orgs/generacy-ai/packages/container/cluster-base/versions --jq '.[0].metadata.container.tags'
   ```

### Poll workflow dispatches but publish fails

The poll workflow only triggers the dispatch — check the publish workflow's own run logs:
```bash
gh run list --workflow=publish-cluster-base-image.yml --limit=5
gh run view <run-id> --log
```

### Cron delays

GitHub Actions cron schedules can be delayed by 10-15 minutes under load. This is expected behavior — the workflow is self-healing and will catch up on the next cycle.

### Permission errors

If you see 403 errors on the GHCR API call, ensure the workflow has `packages: read` permission. If cross-repo access fails, a PAT with `contents: read` scope may be needed (stored as a repo secret).
