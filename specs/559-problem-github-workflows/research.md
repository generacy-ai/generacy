# Research: Auto-publish cluster images on push

## Technology Decisions

### TD1: GHCR Tag Query Method

**Decision**: Use GitHub Packages REST API via `gh api`

**Rationale**: The `gh` CLI is pre-installed on GitHub Actions runners and handles authentication automatically via `GITHUB_TOKEN`. The REST API endpoint `/orgs/{org}/packages/container/{package}/versions` returns version metadata including container tags.

**Alternatives considered**:
- `docker manifest inspect ghcr.io/generacy-ai/<image>:sha-<sha>` — Requires Docker login in the workflow. Simpler conceptually but adds a setup step and GHCR auth dance.
- `skopeo inspect` — Not pre-installed on runners. Adds complexity.
- GitHub GraphQL API — More powerful but unnecessary for a simple tag existence check.

### TD2: HEAD SHA Query

**Decision**: Use `gh api /repos/{owner}/{repo}/commits/{branch} --jq '.sha'`

**Rationale**: Single API call, returns the full 40-char SHA. We truncate to 7 chars client-side to match the existing `git rev-parse --short=7` convention in publish workflows.

**Alternative**: `git ls-remote` — Works but requires git on the runner (which exists) and a slightly different auth model. The `gh api` approach is more consistent with the GHCR query.

### TD3: Workflow Dispatch Method

**Decision**: `gh workflow run <filename> -f ref=<branch>`

**Rationale**: The existing publish workflows already accept a `ref` input via `workflow_dispatch`. Using `gh workflow run` dispatches them exactly as a human would from the Actions UI. No workflow modifications needed.

**Alternative**: `repository_dispatch` — Would require modifying the publish workflows to add a new trigger. Unnecessary since `workflow_dispatch` already exists.

### TD4: Matrix Strategy

**Decision**: Use `strategy.matrix` with explicit `include` entries

```yaml
strategy:
  matrix:
    include:
      - repo: cluster-base
        branch: develop
        image: cluster-base
        workflow: publish-cluster-base-image.yml
      - repo: cluster-base
        branch: main
        image: cluster-base
        workflow: publish-cluster-base-image.yml
      - repo: cluster-microservices
        branch: develop
        image: cluster-microservices
        workflow: publish-cluster-microservices-image.yml
      - repo: cluster-microservices
        branch: main
        image: cluster-microservices
        workflow: publish-cluster-microservices-image.yml
```

**Rationale**: Explicit `include` entries make the matrix self-documenting. Each entry maps directly to a (repo, branch, image, workflow) tuple. Adding a new repo/branch is a single new entry.

## Implementation Patterns

### Pattern: GHCR Tag Existence Check

```bash
# Get HEAD SHA (7-char short)
HEAD_SHA=$(gh api "/repos/generacy-ai/$REPO/commits/$BRANCH" --jq '.sha' | cut -c1-7)

# Check if sha-<SHA> tag exists in GHCR
TAG_EXISTS=$(gh api "/orgs/generacy-ai/packages/container/$IMAGE/versions" \
  --jq "[.[].metadata.container.tags[] | select(. == \"sha-$HEAD_SHA\")] | length")

if [ "$TAG_EXISTS" -gt 0 ]; then
  echo "sha-$HEAD_SHA already published"
else
  echo "New commit detected, dispatching build"
  gh workflow run "$WORKFLOW" -f "ref=$BRANCH"
fi
```

### Pattern: Concurrency Control

```yaml
concurrency:
  group: poll-cluster-${{ matrix.repo }}-${{ matrix.branch }}
  cancel-in-progress: false
```

`cancel-in-progress: false` ensures a running poll isn't cancelled by the next cron tick. Since the poll job is fast (< 30s), this should rarely matter, but it's defensive.

## Key References

- [GitHub Actions: schedule event](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule) — cron syntax, delay behavior
- [GitHub Packages REST API](https://docs.github.com/en/rest/packages/packages) — `/orgs/{org}/packages/container/{package}/versions`
- [gh workflow run](https://cli.github.com/manual/gh_workflow_run) — CLI dispatch
- generacy-ai/generacy#538 — precedent for auto-publish pattern (npm preview)
- Existing publish workflows — tag convention: `sha-$(git rev-parse --short=7 HEAD)`

## Cross-Repo API Access

The `GITHUB_TOKEN` in GitHub Actions has implicit read access to public repos in the same org. For GHCR package queries, `packages: read` permission is sufficient. For `gh workflow run` on the *same* repo (generacy), `actions: write` is needed — this dispatches a `workflow_dispatch` event on the publish workflow files that live in the generacy repo.

If cluster-base/cluster-microservices are private repos, the default `GITHUB_TOKEN` may not have cross-repo read access. In that case, a GitHub App token or PAT stored as a repo secret would be needed. However, the API calls are read-only (commit SHA query), so a fine-grained PAT with `contents: read` on both repos would suffice.
