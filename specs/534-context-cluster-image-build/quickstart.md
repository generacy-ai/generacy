# Quickstart: Cluster Image Build Workflows

## Overview

Two GitHub Actions workflows for building and publishing cluster Docker images to GHCR.

## Usage

### Trigger a Build

1. Go to **Actions** tab in the `generacy-ai/generacy` repo
2. Select either:
   - **Publish cluster-base image**
   - **Publish cluster-microservices image**
3. Click **Run workflow**
4. Select the branch:
   - `develop` — publishes `:preview` tag
   - `main` — publishes `:stable` tag
5. Click **Run workflow** button

### Verify the Image

```bash
# Check the published image tags
docker pull ghcr.io/generacy-ai/cluster-base:preview
docker pull ghcr.io/generacy-ai/cluster-microservices:stable

# Or check by SHA tag
docker pull ghcr.io/generacy-ai/cluster-base:sha-abc1234
```

### View Published Images

Visit the GitHub Packages page:
- `https://github.com/orgs/generacy-ai/packages/container/package/cluster-base`
- `https://github.com/orgs/generacy-ai/packages/container/package/cluster-microservices`

## Workflow Files

| File | Image |
|------|-------|
| `.github/workflows/publish-cluster-base-image.yml` | `ghcr.io/generacy-ai/cluster-base` |
| `.github/workflows/publish-cluster-microservices-image.yml` | `ghcr.io/generacy-ai/cluster-microservices` |

## Troubleshooting

### 403 on GHCR push
- Ensure the workflow has `packages: write` permission
- Ensure the `GITHUB_TOKEN` has access to GHCR for the `generacy-ai` org

### Cross-repo checkout fails
- The template repo may have been made private
- Add a fine-grained PAT with `contents: read` on the template repo as a repo secret
- Pass the token via `actions/checkout`'s `token` parameter

### Image not found after build
- Check the Actions run logs for build/push errors
- Verify the correct branch was selected (`develop` vs `main`)
- Ensure the template repo has a `Dockerfile` at its root
