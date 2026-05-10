# Feature Specification: Auto-publish cluster images on push to develop

**Branch**: `559-problem-github-workflows` | **Date**: 2026-05-10 | **Status**: Draft

## Summary

The `publish-cluster-base-image.yml` and `publish-cluster-microservices-image.yml` workflows in generacy are `workflow_dispatch` only — no automatic trigger. Every merge to the cluster-base or cluster-microservices `develop` branch sits unpublished until someone manually dispatches the workflow. This causes stale `:preview` images and delays feature availability by hours or days.

The fix is to move each publish workflow into its respective template repo (cluster-base, cluster-microservices) so that a standard `on: push: branches: [develop]` trigger fires naturally, while retaining manual dispatch for one-off rebuilds from other branches.

## Problem

The publish workflows live in **generacy-ai/generacy** but build source from **generacy-ai/cluster-base** (and cluster-microservices). Adding `on: push` to these workflows would trigger on pushes to *generacy*'s develop — wrong source repo. This cross-repo mismatch means automatic publishing is impossible without either moving the workflow or adding a cross-repo dispatch mechanism.

Surfaced during testing of cluster-base#21 (bootstrap-mode work): merge landed 2026-05-10 but `:preview` image was still from 2026-05-04. Same lag affected cluster-base#19 two days earlier.

## User Stories

### US1: Developer merging to cluster-base

**As a** developer merging changes to cluster-base's develop branch,
**I want** the `:preview` Docker image to be automatically rebuilt and pushed,
**So that** I can immediately test my changes in downstream clusters without manually triggering a workflow.

**Acceptance Criteria**:
- [ ] Push to cluster-base `develop` triggers image build within minutes
- [ ] `:preview` and `:sha-<short>` tags are pushed to GHCR
- [ ] No manual intervention required

### US2: Developer doing one-off builds

**As a** developer needing to publish an image from a non-default branch,
**I want** to manually dispatch the workflow with a custom ref,
**So that** I can test feature branches as container images without merging first.

**Acceptance Criteria**:
- [ ] `workflow_dispatch` with `ref` input still works
- [ ] Tag mapping: custom ref produces `:sha-<short>` tag (no `:preview`/`:stable` unless from develop/main)

### US3: Release manager publishing stable images

**As a** release manager merging to cluster-base's main branch,
**I want** the `:stable` image to be automatically built and pushed,
**So that** production-channel clusters receive the latest stable image without manual dispatch.

**Acceptance Criteria**:
- [ ] Push to cluster-base `main` triggers image build
- [ ] `:stable` and `:sha-<short>` tags are pushed to GHCR

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Move `publish-cluster-base-image.yml` into `generacy-ai/cluster-base` repo with `on: push: branches: [develop, main]` trigger | P1 | Approach A from issue |
| FR-002 | Move `publish-cluster-microservices-image.yml` into `generacy-ai/cluster-microservices` repo with same trigger pattern | P1 | Same pattern |
| FR-003 | Retain `workflow_dispatch` trigger with `ref` input for manual one-off builds | P1 | Existing UX preserved |
| FR-004 | Tag mapping: `develop` -> `:preview`, `main` -> `:stable`, all pushes -> `:sha-<short>` | P1 | Matches current behavior |
| FR-005 | Remove the moved workflow files from generacy repo | P2 | Cleanup after move |
| FR-006 | Workflow uses `docker/build-push-action@v6`, `docker/login-action@v3`, `docker/setup-buildx-action@v3` | P2 | Keep existing action versions |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Auto-publish latency | < 10 min from merge to image available | Time between merge commit and GHCR tag timestamp |
| SC-002 | Zero manual dispatches needed for develop/main | 100% automatic | Workflow run history shows `push` trigger events |
| SC-003 | Manual dispatch still functional | Works on demand | Successful manual dispatch from Actions tab |

## Assumptions

- No organizational policy requires publish workflows to live in the generacy monorepo
- `secrets.GITHUB_TOKEN` with `packages: write` is available in cluster-base and cluster-microservices repos (standard for GHCR within the same org)
- The workflow is fully self-contained — no references to generacy source tree files
- cluster-base and cluster-microservices repos allow GitHub Actions workflows

## Out of Scope

- Modifying the Docker build logic or Dockerfile contents
- Changing the GHCR image names or registry
- Adding CI/CD for other image variants
- Notification/alerting on build failures (follow-up)
- Caching optimization for Docker builds (follow-up)

## Design Decision

**Approach A: Move workflows to their respective repos** (recommended)

Rationale:
- Workflow lives next to the code it publishes — smallest conceptual model
- Standard `on: push` trigger works naturally — no cross-repo dispatch complexity
- No additional secrets or PATs needed (GITHUB_TOKEN suffices for same-org GHCR)
- Self-contained workflow has no dependencies on generacy source tree

Rejected alternatives:
- **B) Forwarder workflow**: Adds an extra hop, requires cross-repo PAT, more moving parts
- **C) repository_dispatch**: Requires PAT with `repo` scope, adds event plumbing, harder to debug

## Related

- generacy-ai/generacy#538 — same fix pattern applied to `publish-preview.yml` for npm publishing
- generacy-ai/cluster-base#21 — the merge that surfaced this lag (bootstrap-mode work)
- generacy-ai/cluster-base#19 — earlier merge that also sat unpublished

---

*Generated by speckit*
