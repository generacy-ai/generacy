# Research: Cluster Image Build Workflows

## Technology Decisions

### 1. Docker Build Actions vs Raw CLI

**Decision**: Use `docker/build-push-action@v6` + `docker/login-action@v3` + `docker/setup-buildx-action@v3`

**Rationale**:
- Industry-standard GitHub Actions for Docker image building
- Built-in multi-tag support via `tags` parameter
- Integrated metadata generation via `docker/metadata-action`
- Supports build caching out of the box (can add later)
- Cleaner YAML than raw `docker build && docker push` commands

**Alternatives considered**:
- **Raw `docker build`/`docker push`**: Simpler but more verbose, no built-in multi-tag, manual GHCR auth. The existing `publish-devcontainer-feature.yml` uses raw `oras` CLI, but that's for OCI artifacts not Docker images.
- **`docker/metadata-action`**: Could auto-generate tags from Git metadata, but our mapping is simple enough to do inline. Could add later if tagging logic grows.

### 2. Registry: GHCR

**Decision**: Use GHCR (`ghcr.io/generacy-ai/<name>`)

**Rationale**:
- Path of least resistance — `GITHUB_TOKEN` has write access to GHCR packages in the same org
- No additional secrets or IAM setup required
- Matches existing GHCR usage in `publish-devcontainer-feature.yml`
- Images already referenced as `ghcr.io/generacy-ai/cluster-base` in scaffolder and cloud client

**Alternative rejected**:
- **GAR (Google Artifact Registry)**: Would require Workload Identity Federation setup, `google-github-actions/auth` action, separate credentials. Spec explicitly defers this.

### 3. Cross-repo Checkout

**Decision**: `actions/checkout@v4` with `repository` parameter

**Rationale**:
- Template repos (`cluster-base`, `cluster-microservices`) are currently public
- `actions/checkout@v4` supports `repository` param for cross-repo checkout of public repos with no extra tokens
- The `ref` parameter maps directly to the workflow input

**Future consideration**: If repos go private, add a fine-grained PAT or GitHub App token as a repo secret and pass via the `token` parameter.

### 4. Tag Mapping Strategy

**Decision**: Simple shell-based conditional in a workflow step

```yaml
- name: Determine image tag
  id: tag
  run: |
    if [ "${{ inputs.ref }}" = "develop" ]; then
      echo "channel=preview" >> "$GITHUB_OUTPUT"
    else
      echo "channel=stable" >> "$GITHUB_OUTPUT"
    fi
    echo "sha=sha-$(echo ${{ github.sha }} | cut -c1-7)" >> "$GITHUB_OUTPUT"
```

**Rationale**: Two-branch mapping doesn't warrant `docker/metadata-action` complexity. The spec's `CHANNEL_BRANCH_MAP` is `stable->main, preview->develop`, and this directly implements it.

### 5. Permissions Model

**Decision**: Minimal permissions — `contents: read`, `packages: write`

- `contents: read` — needed to check out the source repo
- `packages: write` — needed to push to GHCR
- No `id-token: write` needed (not using OIDC/WIF)

## Implementation Patterns

### Workflow Template

Both workflows follow the same pattern:
1. `workflow_dispatch` trigger with `ref` choice
2. Single job: `build-and-push`
3. Steps: checkout → setup-buildx → login → compute tags → build+push

### Consistency with Existing Workflows

- Matches `publish-preview.yml` pattern for manual dispatch
- Uses `@v4`/`@v3` action versions consistent with existing workflows
- Follows existing permissions block style (explicit, minimal)

## References

- [docker/build-push-action](https://github.com/docker/build-push-action) — v6
- [docker/login-action](https://github.com/docker/login-action) — v3
- [docker/setup-buildx-action](https://github.com/docker/setup-buildx-action) — v3
- [GitHub Packages GHCR docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- Existing workflow: `.github/workflows/publish-devcontainer-feature.yml` (GHCR auth pattern)
- Existing workflow: `.github/workflows/publish-preview.yml` (manual dispatch pattern)
