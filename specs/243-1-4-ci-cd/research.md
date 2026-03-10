# Research: CI/CD Implementation for Generacy Monorepo

## Current State Analysis

### Existing Workflows (as of 2026-02-26)

All five workflow files already exist in `.github/workflows/`. The task is to **fix bugs, fill gaps, and extend** them — not to create them from scratch.

| Workflow | File | Status | Issues Found |
|----------|------|--------|--------------|
| CI | `ci.yml` | Mostly complete | None — meets spec |
| Changeset Bot | `changeset-bot.yml` | Complete | None |
| Publish Preview | `publish-preview.yml` | Has bugs | Changeset detection bug (matches README.md); no Dev Container Feature publish; no `--provenance` flag |
| Release | `release.yml` | Has bugs | Missing `registry-url` in setup-node; missing `NODE_AUTH_TOKEN`; no Dev Container Feature publish; no `--provenance` flag |
| Dev Container Feature | `publish-devcontainer-feature.yml` | Tag-only trigger | Needs conversion to reusable workflow (per Q1 answer) |

### Bug: Preview Changeset Detection (Q3)

**File**: `publish-preview.yml`, line 41
**Current**: `if ls .changeset/*.md 1>/dev/null 2>&1; then`
**Problem**: Matches `.changeset/README.md`, which always exists. Results in `has_changesets=true` even when no real changesets exist, leading to empty snapshot publishes.
**Fix**: Use `find .changeset -name '*.md' ! -name 'README.md'` (matches changeset-bot.yml pattern).

### Bug: Release npm Auth (Q5, Q12)

**File**: `release.yml`, lines 24-27
**Current**: `setup-node` has no `registry-url`. The `changesets/action` receives `NPM_TOKEN` in env but `.npmrc` is not configured.
**Problem**: npm publish will fail because `actions/setup-node` only writes the `.npmrc` auth token when `registry-url` is specified.
**Fix**: Add `registry-url: 'https://registry.npmjs.org'` to setup-node, and add `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the changesets step env.

### Gap: Dev Container Feature in Preview/Release (Q1, Q2, Q7)

**Decision (Q1)**: Convert `publish-devcontainer-feature.yml` to a reusable `workflow_call` workflow. Preview and release workflows call it.
**Decision (Q2)**: Use `oras push` directly for preview (`:preview` tag). Keep `devcontainers/action@v1` for stable (semver tags → `:1`).
**Decision (Q7)**: Gate the GHCR publish step on `steps.changesets.outputs.published == 'true'`.

### Gap: npm Provenance (Q4)

**Decision**: Add `--provenance` to publish commands in both preview and release workflows. The `id-token: write` permission is already set.

### Non-Issue: devcontainer-feature package.json (Q8)

No `package.json` exists in `packages/devcontainer-feature/`. pnpm doesn't see it as a workspace package, so it won't attempt npm publish. Adding a minimal `package.json` with `"private": true` is defense-in-depth.

## Technical Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Dev Container Feature integration | Reusable workflow (`workflow_call`) | DRY, single publish logic |
| Preview Feature tagging | `oras push` with `:preview` tag | `devcontainers/action` doesn't support arbitrary tags |
| Stable Feature tagging | `devcontainers/action@v1` | Semver → `:1` mapping is native |
| Changeset detection fix | `find ... ! -name 'README.md'` | Simple, matches existing changeset-bot pattern |
| npm provenance | Enable now with `--provenance` | Permission already set, one-line change |
| CI triggers | Keep both push + PR | Validates merge result, catches admin bypasses |
| CI step strategy | Single sequential job | Simpler, fails fast, fewer runner minutes |
| Preview concurrency | Accept skipped intermediate publishes | Latest always publishes, previews are transient |
| Changeset bot status check | Not required in branch protection | Not every PR needs a changeset |
| devcontainer-feature `package.json` | Add with `"private": true` | Defense-in-depth |

## OCI/ORAS Considerations for Preview Publish

The `devcontainers/action@v1` publishes Dev Container Features as OCI artifacts to GHCR. It reads `devcontainer-feature.json` and generates tags based on the `version` field (e.g., version `0.1.0` → tags `:0`, `:0.1`, `:0.1.0`).

For preview, we need a `:preview` tag which the action doesn't natively support. Using `oras` (OCI Registry As Storage) CLI:

```bash
# Install oras
curl -LO https://github.com/oras-project/oras/releases/download/v1.2.0/oras_1.2.0_linux_amd64.tar.gz
tar xzf oras_1.2.0_linux_amd64.tar.gz

# Login to GHCR
echo "$GITHUB_TOKEN" | oras login ghcr.io -u $GITHUB_ACTOR --password-stdin

# Package and push the feature
cd packages/devcontainer-feature/src/generacy
tar czf /tmp/generacy-feature.tgz .
oras push ghcr.io/generacy-ai/generacy/generacy:preview \
  --config /dev/null:application/vnd.devcontainers \
  /tmp/generacy-feature.tgz:application/vnd.devcontainers.layer.v1+tar
```

The OCI media types match what `devcontainers/action` uses, ensuring compatibility with Dev Container clients.

## Workflow Permission Matrix

| Workflow | contents | pull-requests | id-token | packages |
|----------|----------|---------------|----------|----------|
| ci.yml | read | — | — | — |
| changeset-bot.yml | read | — | — | — |
| publish-preview.yml | read | — | write | write (via reusable workflow) |
| release.yml | write | write | write | write (via reusable workflow) |
| publish-devcontainer-feature.yml | read | — | — | write |
