# Implementation Plan: CI/CD for Generacy VS Code Extension

**Spec**: 245-1-7-ci-cd | **Date**: 2026-02-28 | **Status**: Draft

## Summary

Create two new GitHub Actions workflows and update the existing CI workflow to fully automate the build, test, package, and publish lifecycle for the Generacy VS Code extension (`generacy-ai.generacy`):

1. **`extension-ci.yml`** — Runs lint, build, typecheck, and test on PRs touching extension files.
2. **`extension-publish.yml`** — Publishes to the VS Code Marketplace on merge to `develop` (pre-release) or `main` (stable), with manual `workflow_dispatch` override.
3. **Update `ci.yml`** — Remove the `--filter '!generacy-extension'` exclusion so the extension participates in monorepo-wide CI.

The existing draft workflow at `packages/generacy-extension/extension-publish.workflow.yml` serves as a starting reference but will be substantially rewritten to incorporate the spec's requirements (paths filters, version pre-check, concurrency, branch validation, environment-variable auth, etc.).

## Technical Context

| Aspect | Detail |
|--------|--------|
| Language | YAML (GitHub Actions), TypeScript (extension) |
| Package manager | pnpm 9.x (monorepo, `packages/*` workspaces) |
| Node version | 22 (matches existing workflows) |
| Extension tooling | `@vscode/vsce@^2.22.0` (packaging + publishing) |
| Test framework | Vitest 3.x |
| Build tool | esbuild (CommonJS output for VS Code) |
| Lint | ESLint 8.x with root `.eslintrc.json` |
| Publisher ID | `generacy-ai` |
| Extension ID | `generacy-ai.generacy` |
| Secret required | `VSCE_PAT` (Azure DevOps PAT with Marketplace scope) |

## Architecture Overview

```
Push/PR to develop/main
        │
        ├─── ci.yml (existing, updated)
        │    └── Full monorepo: lint, build, typecheck, test
        │        (now includes extension in typecheck + test)
        │
        ├─── extension-ci.yml (new)
        │    └── Extension-focused: lint, build (scoped), typecheck, test
        │        Trigger: PR only, paths: packages/generacy-extension/**
        │
        └─── extension-publish.yml (new)
             └── Build → Version check → Publish → Tag → Release
                 Trigger: push to develop/main (with paths filter)
                          + workflow_dispatch with channel input
                 Concurrency: serialized, cancel-in-progress: false
```

## Implementation Phases

### Phase 1: Create `extension-ci.yml`

**File**: `.github/workflows/extension-ci.yml`

**Purpose**: Dedicated CI for the extension on PRs. Provides fast feedback on extension-specific changes without running the full monorepo pipeline.

**Triggers**:
```yaml
on:
  pull_request:
    branches: [develop, main]
    paths:
      - 'packages/generacy-extension/**'
```

**Job steps**:
1. Checkout (`actions/checkout@v4`)
2. Setup pnpm (`pnpm/action-setup@v4`)
3. Setup Node.js 22 with pnpm cache (`actions/setup-node@v4`)
4. Install dependencies (`pnpm install --frozen-lockfile`)
5. Lint extension (`pnpm --filter generacy-extension run lint`)
6. Build extension with dependencies (`pnpm --filter generacy-extension... run build`) — uses `...` suffix to include transitive workspace deps (per Q4 answer)
7. Typecheck extension (`pnpm --filter generacy-extension run typecheck`)
8. Test extension (`pnpm --filter generacy-extension run test`)

**Concurrency**: `group: ${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: true` (matches `ci.yml` pattern for PR workflows).

**Permissions**: `contents: read`

---

### Phase 2: Create `extension-publish.yml`

**File**: `.github/workflows/extension-publish.yml`

This is the core deliverable. It replaces the draft `extension-publish.workflow.yml`.

#### 2.1 — Triggers

```yaml
on:
  push:
    branches: [develop, main]
    paths:
      - 'packages/generacy-extension/**'
  workflow_dispatch:
    inputs:
      channel:
        description: 'Publish channel'
        required: true
        type: choice
        options:
          - preview
          - stable
```

- **Paths filter** (Q1): Only triggers when extension files change. `workflow_dispatch` provides escape hatch.
- **No tag trigger**: Tags are created by the workflow itself (not used as triggers).

#### 2.2 — Concurrency

```yaml
concurrency:
  group: extension-publish
  cancel-in-progress: false
```

Matches `publish-preview.yml` and `release.yml` pattern (Q9). Publishes are serialized.

#### 2.3 — Permissions

```yaml
permissions:
  contents: write   # For git tag creation and GitHub Release
```

#### 2.4 — Channel determination

A preliminary step derives the publish channel:
- Push to `develop` → `preview`
- Push to `main` → `stable`
- `workflow_dispatch` → uses the `channel` input

#### 2.5 — Branch-channel validation (Q7)

For `workflow_dispatch`, validate that:
- `channel=preview` only runs on `develop`
- `channel=stable` only runs on `main`

Fail with a clear error message if mismatched.

#### 2.6 — Build and test

1. Checkout
2. Setup pnpm v4 + Node.js 22 with cache
3. `pnpm install --frozen-lockfile`
4. `pnpm --filter generacy-extension... run build` (scoped with deps, Q4)
5. `pnpm --filter generacy-extension run test`

#### 2.7 — Version pre-check (Q3)

Before publishing, query the marketplace for the current published version and compare with `package.json`:

```bash
CURRENT_VERSION=$(node -p "require('./packages/generacy-extension/package.json').version")
# Use npx vsce show to check marketplace version
MARKETPLACE_VERSION=$(npx vsce show generacy-ai.generacy --json 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).versions[0].version" 2>/dev/null || echo "")

if [ "$CURRENT_VERSION" = "$MARKETPLACE_VERSION" ]; then
  echo "skip=true" >> $GITHUB_OUTPUT
  echo "Version $CURRENT_VERSION already published. Skipping."
fi
```

If the version matches, subsequent publish/tag/release steps are skipped (workflow exits green).

#### 2.8 — Package extension

```bash
cd packages/generacy-extension
npx vsce package --no-dependencies
```

Produces `generacy-extension-{version}.vsix`.

#### 2.9 — Publish to Marketplace

**Preview channel** (develop):
```bash
cd packages/generacy-extension
npx vsce publish --no-dependencies --pre-release
```

**Stable channel** (main):
```bash
cd packages/generacy-extension
npx vsce publish --no-dependencies
```

Authentication via `VSCE_PAT` environment variable only (Q10):
```yaml
env:
  VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

No `--pat` flag on the command line.

#### 2.10 — Git tag (stable only)

For stable publishes, create a git tag `extension-v{version}`:

```bash
VERSION=$(node -p "require('./packages/generacy-extension/package.json').version")
TAG="extension-v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists. Skipping tag creation."
else
  git tag "$TAG"
  git push origin "$TAG"
fi
```

Skip if tag exists (Q5). Log a warning but continue.

#### 2.11 — GitHub Release (stable only)

```yaml
- name: Create GitHub Release
  if: channel == 'stable' && steps.version-check.outputs.skip != 'true'
  uses: softprops/action-gh-release@v2
  with:
    tag_name: extension-v${{ steps.version.outputs.version }}
    name: Generacy Extension v${{ steps.version.outputs.version }}
    files: packages/generacy-extension/*.vsix
    generate_release_notes: true
```

Uses `v2` of the action (not `v1` as in the draft). Auto-generated release notes (Q6).

#### 2.12 — Upload VSIX artifact

Always upload the `.vsix` as a build artifact (both channels):

```yaml
- name: Upload VSIX artifact
  uses: actions/upload-artifact@v4
  with:
    name: generacy-extension-${{ steps.version.outputs.version }}.vsix
    path: packages/generacy-extension/*.vsix
    retention-days: 30
```

---

### Phase 3: Update `ci.yml`

**File**: `.github/workflows/ci.yml`

Remove the `--filter '!generacy-extension'` exclusion from two steps:

**Typecheck step** (line 45):
```yaml
# Before:
run: pnpm -r --filter '!generacy-extension' run --if-present typecheck

# After:
run: pnpm -r run --if-present typecheck
```

**Test step** (line 51):
```yaml
# Before:
run: pnpm -r --filter '!generacy-extension' --filter '!@generacy-ai/orchestrator' --filter '!@generacy-ai/generacy' run --if-present test

# After:
run: pnpm -r --filter '!@generacy-ai/orchestrator' --filter '!@generacy-ai/generacy' run --if-present test
```

Only the extension exclusion is removed. Other exclusions (`orchestrator`, `generacy`) remain (Q2).

---

### Phase 4: Clean up draft workflow

**Delete**: `packages/generacy-extension/extension-publish.workflow.yml`

The draft file is superseded by `.github/workflows/extension-publish.yml`. Leaving it would cause confusion.

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `.github/workflows/extension-ci.yml` | **Create** | Extension-specific CI for PRs |
| `.github/workflows/extension-publish.yml` | **Create** | Extension publish workflow (preview + stable) |
| `.github/workflows/ci.yml` | **Edit** | Remove `generacy-extension` filter exclusions |
| `packages/generacy-extension/extension-publish.workflow.yml` | **Delete** | Remove superseded draft workflow |

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Paths filter on publish triggers | Yes (`packages/generacy-extension/**`) | Prevents unnecessary marketplace publishes when unrelated packages change (Q1) |
| Build scope | `pnpm --filter generacy-extension...` | `...` suffix builds transitive workspace deps — pnpm-native, faster than full monorepo build (Q4) |
| Duplicate version handling | Skip gracefully (green no-op) | Query marketplace before publish; skip if version exists. Avoids noisy red failures (Q3) |
| Tag conflict handling | Skip tag creation, continue | Don't force-update tags or fail. Handles re-runs and retries gracefully (Q5) |
| Release notes | GitHub auto-generated | `generate_release_notes: true` — simple, scoped by `extension-v` tag prefix (Q6) |
| Branch-channel validation | Enforce pairing | Fail if `stable` from non-`main` or `preview` from non-`develop` (Q7) |
| VSCE auth | Environment variable only | Set `VSCE_PAT` env var, no `--pat` CLI flag. Recommended by vsce, avoids log exposure (Q10) |
| Concurrency | `cancel-in-progress: false` | Serialize publishes. Matches existing repo pattern in `release.yml` and `publish-preview.yml` (Q9) |
| CI redundancy | Accept | Publish workflow is self-contained (builds + tests independently of `ci.yml`). Simpler, no cross-workflow deps (Q11) |
| CI exclusion removal | Extension only | Only remove `--filter '!generacy-extension'`. Leave orchestrator/generacy exclusions intact (Q2) |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| `VSCE_PAT` secret not configured | Workflow will fail clearly at publish step. PUBLISHING.md documents PAT creation. Blocked by issue #244 (marketplace publisher registration). |
| Extension has no tests yet | `vitest run` with no test files exits 0 ("no tests found"). Not a blocker. Tests will be added as part of extension development. |
| Marketplace version check fails (API unavailable) | If `vsce show` fails, default to attempting publish. A duplicate-version error from `vsce publish` is acceptable as a fallback. |
| pnpm `...` filter doesn't resolve deps | Unlikely — this is documented pnpm behavior. If it fails, fall back to full `pnpm -r run build`. |
| `softprops/action-gh-release@v2` breaking changes | Pin to `v2`. This is a widely-used, stable action. |
| Lint fails on extension code | Root `.eslintrc.json` applies to all packages. Verify `pnpm --filter generacy-extension run lint` works before merging. |

## Prerequisites

- **Issue #244**: VS Code Marketplace publisher account (`generacy-ai`) must be registered
- **Issue #250**: Extension MVP must be functional (build, lint, typecheck pass)
- **Repository secret**: `VSCE_PAT` must be added to GitHub repository secrets

## Testing Strategy

1. **Local verification**: Run extension lint, build, typecheck, and test locally to confirm they pass:
   ```bash
   pnpm --filter generacy-extension run lint
   pnpm --filter generacy-extension... run build
   pnpm --filter generacy-extension run typecheck
   pnpm --filter generacy-extension run test
   ```

2. **CI workflow validation**: Push to a feature branch and open a PR touching extension files. Verify `extension-ci.yml` triggers and passes.

3. **Publish dry run**: Use `workflow_dispatch` with `channel=preview` on `develop` to test the full publish pipeline. Verify:
   - Version check step runs correctly
   - VSIX artifact is uploaded
   - If `VSCE_PAT` is configured: extension appears on marketplace

4. **Stable publish validation**: After merging to `main`, verify:
   - Git tag `extension-v{version}` is created
   - GitHub Release is created with VSIX attached
   - Extension is published as stable on marketplace
