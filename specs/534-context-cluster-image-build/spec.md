# Feature Specification: Cluster Image Build Workflows

**Branch**: `534-context-cluster-image-build` | **Date**: 2026-05-07 | **Status**: Draft

## Summary

Move the Docker image build/publish pipelines for `cluster-base` and `cluster-microservices` out of the template repos and into this repo's GitHub Actions workflows. The template repos currently contain `.github/workflows/` files that get copied into user-project repos during creation, causing `403 Resource not accessible by integration` errors because the Generacy-AI GitHub App lacks `Workflows: write` permission.

## Context

The cluster image build pipeline currently lives in the template repos themselves (`generacy-ai/cluster-base/.github/workflows/publish-cluster-image.yml` and the same path in `cluster-microservices`). This is a problem because the worker template-copies the entire tree into newly-created user-project repos, and GitHub Apps need a separate `Workflows: write` permission to create trees containing `.github/workflows/*` paths — a permission the Generacy-AI App installation does not have. Result: project creation on the preview channel fails with `403 Resource not accessible by integration` on `git/trees`.

The sister fix issues delete the workflows from the template repos:
- generacy-ai/cluster-base#16
- generacy-ai/cluster-microservices#10

This issue tracks moving the build/publish jobs to a place where they don't bleed into user repos.

## Scope

Add two GitHub Actions workflows under `.github/workflows/` in this repo:

1. **`publish-cluster-base-image.yml`** — manually triggered (`workflow_dispatch`), checks out `generacy-ai/cluster-base` at a specified ref, builds the Docker image from its `Dockerfile`, pushes to the registry with channel-aware tags.
2. **`publish-cluster-microservices-image.yml`** — same shape, against `generacy-ai/cluster-microservices`.

### Inputs

```yaml
inputs:
  ref:
    description: "Branch to build (develop or main)"
    type: choice
    options: [develop, main]
    required: true
```

### Tagging

| Source ref | Image tag |
|---|---|
| `develop` | `preview` |
| `main` | `stable` |

Tags should match the worker's `CHANNEL_BRANCH_MAP`: `stable->main`, `preview->develop`. Once published, the default `docker-compose.yml` in each template repo references `image: <registry>/<name>:stable` (or `:preview`).

Optionally also push an immutable tag based on commit SHA (`:sha-abcdef0`) for debugging traceability — nice to have, not required for v1.5.

### Trigger Choice

Manual (`workflow_dispatch`) only. The base images don't change often enough to warrant push-triggered rebuilds. Automatic rebuilds via `push:` filters can be added in a follow-up.

### Cross-repo Checkout

`actions/checkout@v4` against a public template repo just works. If either template repo becomes private, the workflow needs a token with `contents: read` on those repos — either a fine-grained PAT stored as a secret, or a GitHub App token.

## User Stories

### US1: Unblocked Project Creation

**As a** Generacy platform operator,
**I want** the cluster image build workflows to live in the main generacy repo instead of the template repos,
**So that** project creation via the GitHub App no longer fails with `403` errors due to workflow files being copied into user repos.

**Acceptance Criteria**:
- [ ] Template repos (`cluster-base`, `cluster-microservices`) have their `.github/workflows/` removed
- [ ] Equivalent build/publish workflows exist in this repo
- [ ] Fresh project creation on the preview channel succeeds end-to-end

### US2: Channel-Tagged Image Publishing

**As a** developer building or deploying clusters,
**I want** to manually trigger image builds with a branch selector that maps to channel tags (`preview`/`stable`),
**So that** I can publish the correct image tag for each deployment channel without manual tagging.

**Acceptance Criteria**:
- [ ] Selecting `develop` produces `:preview` tagged images
- [ ] Selecting `main` produces `:stable` tagged images
- [ ] Images are pushed to the container registry (GHCR)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `publish-cluster-base-image.yml` workflow with `workflow_dispatch` trigger and `ref` choice input | P1 | |
| FR-002 | `publish-cluster-microservices-image.yml` workflow with identical structure | P1 | |
| FR-003 | Cross-repo checkout of `generacy-ai/cluster-base` (or `cluster-microservices`) at specified ref | P1 | Uses `actions/checkout@v4` with `repository` param |
| FR-004 | Branch-to-tag mapping: `develop` -> `preview`, `main` -> `stable` | P1 | Matches worker `CHANNEL_BRANCH_MAP` |
| FR-005 | Docker build from the checked-out repo's `Dockerfile` | P1 | |
| FR-006 | Push to GHCR (`ghcr.io/generacy-ai/<name>`) | P1 | Path of least resistance; same auth as Actions |
| FR-007 | Optional SHA-based immutable tag (`:sha-<short>`) | P2 | Nice to have for debugging traceability |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Workflow runs successfully | Both workflows pass via "Run workflow" button | Manual trigger in GitHub Actions UI |
| SC-002 | Correct image tags produced | `develop` -> `:preview`, `main` -> `:stable` | Inspect GHCR tags after workflow run |
| SC-003 | Project creation unblocked | Preview-channel project creation succeeds in staging | End-to-end test after template repos drop their workflows |

## Assumptions

- GHCR is the chosen registry (path of least resistance, same auth as GitHub Actions)
- Template repos (`cluster-base`, `cluster-microservices`) are currently public, so cross-repo checkout needs no extra token
- The `GITHUB_TOKEN` provided by Actions has sufficient permissions to push to GHCR for the `generacy-ai` org
- Both template repos have a `Dockerfile` at their root

## Open Questions

- **Registry choice**: GHCR vs GAR (`us-central1-docker.pkg.dev/generacy-ai/...`). GHCR is simpler; GAR needs WIF setup. Defaulting to GHCR unless decided otherwise.
- **Private repos**: If template repos go private, a PAT or GitHub App token secret will be needed for cross-repo checkout.

## Out of Scope

- Automatic push-triggered rebuilds (follow-up)
- Multi-platform builds (e.g., ARM64)
- Build caching optimizations
- GAR registry setup and WIF authentication
- Changes to the template repos themselves (tracked in cluster-base#16 / cluster-microservices#10)

---

*Generated by speckit*
