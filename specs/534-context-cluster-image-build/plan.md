# Implementation Plan: Cluster Image Build Workflows

**Feature**: Move Docker image build/publish pipelines for cluster-base and cluster-microservices into this repo's GitHub Actions
**Branch**: `534-context-cluster-image-build`
**Status**: Complete

## Summary

Add two `workflow_dispatch`-triggered GitHub Actions workflows to this repo that check out the `generacy-ai/cluster-base` and `generacy-ai/cluster-microservices` template repos, build their Docker images, and push to GHCR with channel-aware tags (`preview` for `develop`, `stable` for `main`). This eliminates the need for workflow files in the template repos, which caused `403 Resource not accessible by integration` errors during project creation.

## Technical Context

**Language/Version**: GitHub Actions YAML (runs-on `ubuntu-latest`)
**Primary Dependencies**: `actions/checkout@v4`, `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action` (or raw `docker` CLI)
**Storage**: GHCR (`ghcr.io/generacy-ai/cluster-base`, `ghcr.io/generacy-ai/cluster-microservices`)
**Testing**: Manual workflow dispatch + tag verification in GHCR
**Target Platform**: GitHub Actions runner (ubuntu-latest)
**Project Type**: CI/CD configuration (YAML workflows only)
**Constraints**: Must use `GITHUB_TOKEN` for auth (no additional secrets for public repos)

## Constitution Check

No constitution file found at `.specify/memory/constitution.md`. No gates to check.

## Project Structure

### Documentation (this feature)

```text
specs/534-context-cluster-image-build/
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Workflow input/output schemas
├── quickstart.md        # Usage guide
└── contracts/           # N/A (no API contracts)
```

### Source Code (repository root)

```text
.github/workflows/
├── publish-cluster-base-image.yml           # NEW — build & push cluster-base
├── publish-cluster-microservices-image.yml   # NEW — build & push cluster-microservices
├── ci.yml                                   # Existing
├── publish-preview.yml                      # Existing
├── publish-devcontainer-feature.yml         # Existing
├── release.yml                              # Existing
├── changeset-bot.yml                        # Existing
├── extension-ci.yml                         # Existing
└── extension-publish.yml                    # Existing
```

**Structure Decision**: Two new workflow YAML files in `.github/workflows/`. No source code changes — this is a pure CI/CD configuration task.

## Implementation Approach

### Workflow Shape (both workflows identical except for image name)

1. **Trigger**: `workflow_dispatch` with `ref` choice input (`develop` or `main`)
2. **Checkout**: `actions/checkout@v4` with `repository: generacy-ai/<name>` and `ref: ${{ inputs.ref }}`
3. **Tag mapping**: Shell step mapping `develop` -> `preview`, `main` -> `stable`
4. **GHCR login**: `docker/login-action@v3` using `GITHUB_TOKEN`
5. **Build & push**: `docker/build-push-action@v6` with channel tag + optional SHA tag
6. **Permissions**: `contents: read`, `packages: write`

### Tag Strategy

| Input ref | Primary tag | Optional tag |
|-----------|-------------|--------------|
| `develop` | `ghcr.io/generacy-ai/<name>:preview` | `ghcr.io/generacy-ai/<name>:sha-<short>` |
| `main` | `ghcr.io/generacy-ai/<name>:stable` | `ghcr.io/generacy-ai/<name>:sha-<short>` |

### Key Decisions

1. **Use `docker/build-push-action@v6`** over raw `docker build/push` — standardized, supports multi-tag, build caching, and metadata generation.
2. **Use `docker/login-action@v3`** for GHCR auth — cleaner than `echo | docker login` pattern used in `publish-devcontainer-feature.yml`.
3. **Include SHA tag** (P2 from spec) since it's trivial to add with the build-push action's `tags` parameter.
4. **No concurrency group needed** — manual dispatch with low frequency; no race condition risk.

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `.github/workflows/publish-cluster-base-image.yml` | Create | Build & push cluster-base image |
| `.github/workflows/publish-cluster-microservices-image.yml` | Create | Build & push cluster-microservices image |

**Total**: 2 new files, 0 modified files.
