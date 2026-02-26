# Implementation Plan: 1.4 — CI/CD for generacy repo

## Summary

The five GitHub Actions workflows already exist. This implementation **fixes bugs, fills gaps, and extends** them to match the specification. The key changes are:

1. **Fix preview changeset detection** — current glob matches `README.md`, causing false positives
2. **Fix release npm auth** — missing `registry-url` and `NODE_AUTH_TOKEN` will cause publish failures
3. **Add npm provenance** — `--provenance` flag to both publish workflows
4. **Convert Dev Container Feature workflow to reusable** — called from preview and release workflows
5. **Add Dev Container Feature preview publishing** — via `oras push` with `:preview` tag
6. **Add Dev Container Feature stable publishing** — gate on changesets `published` output
7. **Defense-in-depth** — add `package.json` with `"private": true` to devcontainer-feature

## Technical Context

- **Language**: YAML (GitHub Actions workflows), shell scripts
- **Package Manager**: pnpm 9.15.9
- **Node.js**: 22
- **Monorepo**: 11 npm packages + 1 VS Code extension + 1 Dev Container Feature
- **Version Management**: `@changesets/cli` (already installed)
- **Registries**: npm (`@generacy-ai` scope), GHCR (OCI artifacts)

### Key Dependencies

| Tool | Version | Purpose |
|------|---------|---------|
| `actions/checkout` | v4 | Git checkout |
| `actions/setup-node` | v4 | Node.js + npm auth |
| `pnpm/action-setup` | v4 | pnpm installation |
| `changesets/action` | v1 | Release PR + npm publish |
| `devcontainers/action` | v1 | Dev Container Feature publish (stable) |
| `oras` CLI | 1.2.x | Dev Container Feature publish (preview) |

## Architecture Overview

```
PR opened/updated ──→ ci.yml
                      ├── lint (root + packages)
                      ├── build (root + packages)
                      ├── typecheck (packages, excl. extension)
                      └── test (root + packages, excl. extension/orchestrator/generacy)

PR to develop ──────→ changeset-bot.yml
                      └── warn if no changeset (non-blocking)

Push to develop ────→ publish-preview.yml
                      ├── build all
                      ├── detect changesets (fixed: exclude README.md)
                      ├── snapshot version + npm publish --tag preview --provenance
                      └── calls publish-devcontainer-feature.yml (oras push :preview)

Push to main ───────→ release.yml
                      ├── build all
                      ├── changesets/action (release PR or npm publish --provenance)
                      └── if published: calls publish-devcontainer-feature.yml (:1 via devcontainers/action)

Reusable workflow ──→ publish-devcontainer-feature.yml
                      ├── input: tag (e.g. "preview" or "stable")
                      ├── preview mode: oras push :preview
                      └── stable mode: devcontainers/action@v1 (semver tags → :1)
```

## Implementation Phases

### Phase 1: Convert Dev Container Feature Workflow to Reusable

**File**: `.github/workflows/publish-devcontainer-feature.yml`

**Changes**:
- Add `workflow_call` trigger with inputs: `mode` (enum: `preview` | `stable`)
- Keep the existing `push.tags: ['feature/v*']` trigger as a fallback (treated as stable)
- For `preview` mode: install `oras`, login to GHCR, package feature as tarball, push with `:preview` tag
- For `stable` mode (and tag trigger): use existing `devcontainers/action@v1` logic
- Permissions: `contents: read`, `packages: write`

**Resulting workflow structure**:
```yaml
on:
  workflow_call:
    inputs:
      mode:
        required: true
        type: string  # 'preview' or 'stable'
  push:
    tags:
      - 'feature/v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      # Stable: use devcontainers/action
      - name: Publish Features (stable)
        if: inputs.mode == 'stable' || inputs.mode == ''
        uses: devcontainers/action@v1
        with:
          publish-features: true
          base-path-to-features: packages/devcontainer-feature/src
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      # Preview: use oras
      - name: Install oras (preview)
        if: inputs.mode == 'preview'
        run: |
          curl -sLO https://github.com/oras-project/oras/releases/download/v1.2.0/oras_1.2.0_linux_amd64.tar.gz
          tar xzf oras_1.2.0_linux_amd64.tar.gz -C /usr/local/bin oras

      - name: Publish Feature (preview)
        if: inputs.mode == 'preview'
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | oras login ghcr.io -u ${{ github.actor }} --password-stdin
          cd packages/devcontainer-feature/src/generacy
          tar czf /tmp/generacy-feature.tgz .
          oras push ghcr.io/generacy-ai/generacy/generacy:preview \
            --config /dev/null:application/vnd.devcontainers \
            /tmp/generacy-feature.tgz:application/vnd.devcontainers.layer.v1+tar
```

### Phase 2: Fix and Extend publish-preview.yml

**File**: `.github/workflows/publish-preview.yml`

**Changes**:
1. **Fix changeset detection** (bug): Replace `ls .changeset/*.md` with `find .changeset -name '*.md' ! -name 'README.md'`
2. **Add `--provenance`** to the publish command
3. **Add `packages: write` permission** (needed for the reusable workflow GHCR push)
4. **Call reusable workflow** for Dev Container Feature publish with `mode: preview`

**Note on reusable workflow invocation**: GitHub Actions requires `workflow_call` to be invoked from a separate job (not as a step). The publish-preview workflow will need two jobs:
- `publish-npm`: existing steps (checkout, build, changeset detection, snapshot version, npm publish)
- `publish-devcontainer-feature`: calls the reusable workflow, conditioned on changesets existing

**Updated structure**:
```yaml
permissions:
  contents: read
  id-token: write
  packages: write

jobs:
  publish-npm:
    runs-on: ubuntu-latest
    outputs:
      has_changesets: ${{ steps.changesets.outputs.has_changesets }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm -r run --if-present build
      - name: Check for changesets
        id: changesets
        run: |
          CHANGESET_FILES=$(find .changeset -name '*.md' ! -name 'README.md' 2>/dev/null | head -1)
          if [ -n "$CHANGESET_FILES" ]; then
            echo "has_changesets=true" >> $GITHUB_OUTPUT
          else
            echo "has_changesets=false" >> $GITHUB_OUTPUT
          fi
      - name: Version (snapshot)
        if: steps.changesets.outputs.has_changesets == 'true'
        run: pnpm changeset version --snapshot preview
      - name: Publish preview
        if: steps.changesets.outputs.has_changesets == 'true'
        run: pnpm -r --filter '!generacy-extension' publish --tag preview --no-git-checks --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

  publish-devcontainer-feature:
    needs: publish-npm
    if: needs.publish-npm.outputs.has_changesets == 'true'
    uses: ./.github/workflows/publish-devcontainer-feature.yml
    with:
      mode: preview
    secrets: inherit
```

### Phase 3: Fix and Extend release.yml

**File**: `.github/workflows/release.yml`

**Changes**:
1. **Add `registry-url`** to setup-node step (bug fix)
2. **Add `NODE_AUTH_TOKEN`** to changesets action env (bug fix)
3. **Add `--provenance`** to the publish command in changesets action
4. **Add `packages: write` permission** (for reusable workflow)
5. **Call reusable workflow** for Dev Container Feature publish, gated on `steps.changesets.outputs.published == 'true'`

**Updated structure**:
```yaml
permissions:
  contents: write
  pull-requests: write
  id-token: write
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    outputs:
      published: ${{ steps.changesets.outputs.published }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm -r run --if-present build
      - name: Create Release PR or Publish
        id: changesets
        uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm -r --filter '!generacy-extension' publish --no-git-checks --provenance
          title: 'chore: version packages'
          commit: 'chore: version packages'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

  publish-devcontainer-feature:
    needs: release
    if: needs.release.outputs.published == 'true'
    uses: ./.github/workflows/publish-devcontainer-feature.yml
    with:
      mode: stable
    secrets: inherit
```

### Phase 4: Add devcontainer-feature package.json

**File**: `packages/devcontainer-feature/package.json` (new)

**Content**:
```json
{
  "name": "devcontainer-feature",
  "private": true,
  "description": "Generacy Dev Container Feature (published to GHCR, not npm)"
}
```

This prevents accidental npm publishing if pnpm ever picks up this directory as a workspace package.

### Phase 5: Verify ci.yml and changeset-bot.yml

**Files**: `.github/workflows/ci.yml`, `.github/workflows/changeset-bot.yml`

Both workflows already meet the specification. No changes needed. Verification checklist:

**ci.yml** — confirmed:
- [x] Triggers on PR and push to develop/main (Q6: keep both)
- [x] Concurrency with cancel-in-progress (FR-004)
- [x] `pnpm install --frozen-lockfile` (FR-002)
- [x] Node 22 with pnpm cache (FR-003)
- [x] Lint root + packages (FR-001)
- [x] Build root + packages (FR-001)
- [x] Typecheck excluding `generacy-extension` (FR-005)
- [x] Test excluding `generacy-extension`, `orchestrator`, `generacy` (FR-005)
- [x] Sequential steps — fails fast (Q11: single job)
- [x] `contents: read` permission (FR-015)

**changeset-bot.yml** — confirmed:
- [x] Triggers on PR to develop (FR-006)
- [x] Correctly excludes README.md in changeset detection
- [x] Emits `::warning::` (non-blocking) (Q10: not a required check)

## Files Changed

| File | Action | Phase |
|------|--------|-------|
| `.github/workflows/publish-devcontainer-feature.yml` | Modify | 1 |
| `.github/workflows/publish-preview.yml` | Modify | 2 |
| `.github/workflows/release.yml` | Modify | 3 |
| `packages/devcontainer-feature/package.json` | Create | 4 |
| `.github/workflows/ci.yml` | No change | 5 |
| `.github/workflows/changeset-bot.yml` | No change | 5 |

## Key Technical Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Reusable workflow for Dev Container Feature (Q1→B) | DRY — single publish logic called from preview and release |
| 2 | `oras push` for preview feature (Q2→C) | `devcontainers/action` can't produce `:preview` tag natively |
| 3 | Fix changeset detection with `find` (Q3→A) | Matches changeset-bot.yml pattern, prevents false positives |
| 4 | Enable `--provenance` now (Q4→A) | Permission already set, one-line change, security best practice |
| 5 | Add `registry-url` + `NODE_AUTH_TOKEN` to release.yml (Q5/Q12→A) | Bug fix — npm publish will fail without it |
| 6 | Keep push + PR triggers on CI (Q6→A) | Validates merge result, catches admin bypasses |
| 7 | Gate GHCR publish on `published == 'true'` (Q7→A) | changesets/action provides this output for exactly this purpose |
| 8 | Add `"private": true` package.json to devcontainer-feature (Q8→A) | Defense-in-depth against accidental npm publish |
| 9 | Accept skipped intermediate preview publishes (Q9→A) | Previews are transient, latest always publishes |
| 10 | Changeset bot not required in branch protection (Q10→B) | Not every PR needs a changeset |
| 11 | Single sequential CI job (Q11→A) | Simpler, fails fast, fewer runner minutes |

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `oras push` OCI media types incompatible with Dev Container clients | Low | High | Use exact media types from `devcontainers/action` source code; test manually |
| `NPM_TOKEN` not configured (blocked by issue 242) | Known | Blocks publish | Workflows are correct but won't succeed until 242 is resolved |
| `oras` CLI download fails in CI | Low | Medium | Pin version, use checksum verification |
| Reusable workflow `secrets: inherit` leaks secrets | Low | Medium | Only `GITHUB_TOKEN` is used; no external secrets passed to GHCR step |
| Changeset snapshot version conflicts during concurrent preview publishes | Low | Low | Concurrency group limits to one running + one queued |
| `--provenance` flag breaks on forks (no `id-token` in fork PRs) | Low | Low | Provenance only runs on push workflows (not PR CI), which only trigger from the main repo |

## Spec Coverage Matrix

| Requirement | Implementation | Status |
|-------------|----------------|--------|
| FR-001 CI workflow | `ci.yml` (existing, no changes) | Complete |
| FR-002 frozen-lockfile | All workflows use `--frozen-lockfile` | Complete |
| FR-003 Node 22 + pnpm cache | All workflows configured | Complete |
| FR-004 CI concurrency | `ci.yml` has `cancel-in-progress: true` | Complete |
| FR-005 Extension/orchestrator/CLI exclusions | Filters in ci.yml | Complete |
| FR-006 Changeset bot | `changeset-bot.yml` (existing, no changes) | Complete |
| FR-007 Preview on push to develop | `publish-preview.yml` | Complete |
| FR-008 Snapshot versions | Fixed changeset detection + existing logic | Phase 2 |
| FR-009 npm preview tag | Existing `--tag preview` | Complete |
| FR-010 GHCR `:preview` tag | Reusable workflow with oras | Phase 1-2 |
| FR-011 Release on push to main | `release.yml` | Complete |
| FR-012 changesets/action | Existing + bug fixes | Phase 3 |
| FR-013 npm `@latest` tag | Existing publish command | Complete |
| FR-014 GHCR `:1` tag | Reusable workflow with devcontainers/action | Phase 1, 3 |
| FR-015 Permissions | Updated in Phase 2-3 | Phase 2-3 |
| FR-016 Extension excluded from npm | All publish commands filter it | Complete |
| FR-017 Changeset config | `.changeset/config.json` (existing, correct) | Complete |
| FR-018 Preview no cancel-in-progress | `cancel-in-progress: false` (existing) | Complete |
| FR-019 `packages: write` for GHCR | Added in Phase 2-3 | Phase 2-3 |

## Supporting Artifacts

- [research.md](./research.md) — Current state analysis, bug details, and technical decisions
