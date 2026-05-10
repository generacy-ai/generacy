# Feature Specification: Auto-publish cluster images on push

**Branch**: `559-problem-github-workflows` | **Date**: 2026-05-10 | **Status**: Draft

## Summary

Add a scheduled cron-poll workflow in the `generacy` repo that automatically detects new commits on `cluster-base` and `cluster-microservices` repos and dispatches the existing publish workflows. Replaces the current manual-dispatch-only pattern that leaves images stale after merges.

## Problem

[`.github/workflows/publish-cluster-base-image.yml`](https://github.com/generacy-ai/generacy/blob/develop/.github/workflows/publish-cluster-base-image.yml) is `workflow_dispatch:` only — no automatic trigger. Same hidden-tech-debt pattern we fixed for `publish-preview.yml` in #538: every cluster-base merge sits unpublished until someone remembers to manually trigger the workflow.

This bit during today's testing of [generacy-ai/cluster-base#21](https://github.com/generacy-ai/cluster-base/pull/21) (the `GENERACY_BOOTSTRAP_MODE=wizard` work) — the merge landed at 2026-05-10 but the `cluster-base:preview` image was still from 2026-05-04 (revision `2a76d23`), so the new entrypoint behavior wasn't live until someone manually dispatched a rebuild. Same lag would have hit the `.env.template` split (cluster-base#19) two days earlier.

## Why this is harder than the npm-publish fix

The `publish-preview.yml` fix in #538 was simple: add `on: push: branches: [develop]` because the workflow lives in the same repo as the code being published.

For cluster-base, the workflow lives in **generacy-ai/generacy** but the source lives in **generacy-ai/cluster-base** (per the `actions/checkout@v4 with: repository: generacy-ai/cluster-base` in the workflow). So `on: push: branches: [develop]` on this workflow would fire on pushes to *generacy*'s develop, not cluster-base's. Wrong source.

### Eliminated approaches (A/B/C)

Options A (move workflow to cluster-base), B (forwarder workflow in cluster-base), and C (`repository_dispatch` from cluster-base) are **ruled out**. Cluster-base is used as an upstream template — project repos add it as a remote and merge via `git merge --allow-unrelated-histories`. Any files added to cluster-base's tree (including `.github/workflows/`) propagate into downstream project repos on the next merge.

### Chosen approach: Option D — Scheduled poll from generacy

A cron-triggered GitHub Actions workflow in `generacy` that:
1. Runs every 5 minutes
2. For each (repo, branch) tuple: queries the repo's HEAD SHA and compares against GHCR's latest published `sha-*` tag
3. If SHA differs (new unpublished commit): dispatches the existing publish workflow
4. If SHA matches: exits cleanly (no-op)

This keeps all polling logic in `generacy`'s `.github/workflows/` where it never propagates to downstream repos.

## Design Decisions

- **Polling interval**: 5 minutes (GitHub cron delays can add 10-15 min, so actual latency is 5-20 min)
- **SHA state**: No external state — GHCR's published `sha-*` tags are the canonical record. Self-healing by design.
- **Branch coverage**: Both `develop` and `main` for each target repo (`:preview` and `:stable` tags respectively)
- **Deduplication**: Skip dispatch if SHA already has a published GHCR tag. Saves CI minutes.
- **Concurrency**: Per-(repo, branch) concurrency key to avoid parallel checks cancelling each other. `cancel-in-progress: false`.
- **Scope**: Both cluster-base and cluster-microservices handled symmetrically — one workflow, parameterized.

## User Stories

### US1: Automatic Image Publishing

**As a** developer merging to cluster-base or cluster-microservices,
**I want** the Docker image to be automatically rebuilt and published after my merge,
**So that** I don't have to remember to manually trigger the publish workflow.

**Acceptance Criteria**:
- [ ] Merging to `develop` on cluster-base triggers an automatic image publish within ~20 minutes
- [ ] Merging to `main` on cluster-base triggers an automatic `:stable` image publish within ~20 minutes
- [ ] Same behavior for cluster-microservices
- [ ] Manual `workflow_dispatch` still works for one-off builds from any branch
- [ ] Duplicate builds are avoided when SHA is already published

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Cron-poll workflow runs every 5 minutes | P1 | `schedule: - cron: '*/5 * * * *'` |
| FR-002 | Polls HEAD SHA of develop and main on cluster-base and cluster-microservices | P1 | Uses `gh api /repos/.../commits/<branch>` |
| FR-003 | Compares HEAD SHA against latest published `sha-*` tag in GHCR | P1 | Uses `gh api /orgs/.../packages/container/.../versions` or `docker manifest inspect` |
| FR-004 | Dispatches existing publish workflow when SHA differs | P1 | Uses `gh workflow run` |
| FR-005 | Skips dispatch when SHA already published | P1 | Prevents duplicate builds |
| FR-006 | Per-(repo, branch) concurrency key | P2 | `cancel-in-progress: false` |
| FR-007 | Workflow needs `packages: read` permission for GHCR queries | P1 | |
| FR-008 | Existing `workflow_dispatch` publish workflows unchanged | P1 | Manual path preserved |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Time from merge to published image | < 20 minutes (including cron delay) | Timestamp comparison |
| SC-002 | False positive dispatches (duplicate builds) | 0 under normal operation | CI logs |
| SC-003 | Missed publishes | 0 (self-healing on next poll cycle) | GHCR tag vs repo HEAD comparison |

## Assumptions

- GitHub Actions cron schedule delays are typically 0-15 minutes
- GHCR `sha-*` tag convention matches current publish workflows (7-char short SHA)
- `GITHUB_TOKEN` has sufficient permissions for cross-repo API calls and GHCR queries
- Both cluster-base and cluster-microservices follow the same branch/tag conventions

## Out of Scope

- Modifying the cluster-base or cluster-microservices repos (no files added to upstream templates)
- Changing the existing publish workflow logic (only adding a new trigger workflow)
- Webhook-based or third-party infrastructure solutions
- Notification on publish completion

## Test Plan

- [ ] Poll workflow detects a new unpublished commit and dispatches the publish workflow
- [ ] Poll workflow skips dispatch when HEAD SHA matches latest GHCR tag
- [ ] Both develop and main branches are monitored for each target repo
- [ ] Manual `workflow_dispatch` on existing publish workflows still works
- [ ] Concurrent poll runs for different (repo, branch) tuples don't cancel each other
- [ ] Verify `:preview`, `:stable`, and `:sha-XXXXX` tags are pushed correctly

## Related

- generacy-ai/generacy#538 — same fix pattern, applied to `publish-preview.yml` for npm publishing
- generacy-ai/cluster-base#21 — the merge that surfaced this lag today (bootstrap-mode work)
- generacy-ai/cluster-base#19 — the merge two days earlier that ALSO sat unpublished until today

---

*Generated by speckit*
