# Implementation Plan: Set up CI/CD and npm publishing

## Summary

Configure automated CI pipelines and npm publishing for the generacy monorepo's `@generacy-ai/*` scoped packages using GitHub Actions and Changesets. This involves creating three new workflows (CI, preview publish, stable release), initializing the Changesets toolchain, adding `publishConfig` to publishable packages, and pinning the pnpm version via `packageManager`.

## Technical Context

| Property | Value |
|----------|-------|
| Language | TypeScript (ESM) |
| Runtime | Node.js >=20 (current: v22.22.0) |
| Package manager | pnpm 9.15.9 (lockfile v9.0) |
| Monorepo tool | pnpm workspaces |
| CI platform | GitHub Actions |
| Versioning | Changesets (`@changesets/cli`) |
| Registry | npm (public, `@generacy-ai` scope) |

### Active Workspace Packages

| Package | Publishable | Has `publishConfig` |
|---------|-------------|---------------------|
| `@generacy-ai/workflow-engine` | Yes | **No** (needs adding) |
| `@generacy-ai/orchestrator` | Yes | **No** (needs adding) |
| `@generacy-ai/generacy` | Yes (CLI w/ bin) | **No** (needs adding) |
| `@generacy-ai/knowledge-store` | Yes | **No** (needs adding) |
| `@generacy-ai/templates` | Yes | Already has it |
| `generacy-extension` | **No** (VS Code ext) | N/A |
| Root `generacy` | **No** (`private: true`) | N/A |

### Dependency Chain (within workspace)

```
workflow-engine (no internal deps)
    ↓ workspace:^
orchestrator
    ↓ workspace:*
generacy (also depends on workflow-engine: workspace:*)

templates, knowledge-store (no internal deps)
```

Changesets + pnpm handle workspace protocol replacement and topological publish ordering automatically.

## Architecture Overview

```
PR → develop                    develop → (push)              main → (push)
    │                               │                             │
    ▼                               ▼                             ▼
 ci.yml                    publish-preview.yml               release.yml
 (lint, test, build)       (snapshot publish                 (changesets/action
  on all PRs +              @preview dist-tag                 creates "Version
  pushes to                 only if .changeset/*.md           Packages" PR;
  develop/main)             files present)                    merging PR triggers
                                                              stable publish)
```

### Existing Workflow (unchanged)
- `publish-devcontainer-feature.yml` — triggered by `feature/v*` tags, publishes devcontainer feature to GHCR

## Implementation Phases

### Phase 1: Changesets initialization

**Files created/modified:**
- `CREATE .changeset/config.json`
- `MODIFY package.json` (root) — add `@changesets/cli` to devDependencies, add `packageManager` field

#### 1.1 Create `.changeset/config.json`

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "develop",
  "updateInternalDependencies": "patch",
  "ignore": ["generacy-extension"]
}
```

Key decisions:
- `baseBranch: "develop"` — matches the team's branching model
- `access: "public"` — all `@generacy-ai/*` packages are public
- `ignore: ["generacy-extension"]` — VS Code extension is not published to npm
- `linked: []` — independent versioning; `updateInternalDependencies: "patch"` handles cascade
- `commit: false` — changesets/action handles commits in the release workflow

#### 1.2 Add `packageManager` to root `package.json`

Add `"packageManager": "pnpm@9.15.9"` to root package.json. This is auto-detected by `pnpm/action-setup@v4` and used by Corepack locally.

#### 1.3 Add `@changesets/cli` to root devDependencies

Add `@changesets/cli` to the root `devDependencies`. Do NOT modify any other dependencies or scripts in the root package.json per spec requirements.

#### 1.4 Run `pnpm install` to update the lockfile

---

### Phase 2: Package configuration

**Files modified:**
- `packages/generacy/package.json`
- `packages/orchestrator/package.json`
- `packages/workflow-engine/package.json`
- `packages/knowledge-store/package.json`

Add `"publishConfig": { "access": "public" }` to each package that doesn't already have it. `@generacy-ai/templates` already has this field — skip it.

Also add `publishConfig` to the excluded packages (they will be published later when their external dependencies are available):
- `packages/github-actions/package.json`
- `packages/generacy-plugin-cloud-build/package.json`
- `packages/generacy-plugin-copilot/package.json`
- `packages/generacy-plugin-claude-code/package.json`
- `packages/github-issues/package.json`
- `packages/jira/package.json`

---

### Phase 3: CI workflow

**Files created:**
- `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [develop, main]
  push:
    branches: [develop, main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint (root)
        run: pnpm lint

      - name: Lint (packages)
        run: pnpm -r run --if-present lint

      - name: Build (root)
        run: pnpm build

      - name: Build (packages)
        run: pnpm -r run --if-present build

      - name: Test (root)
        run: pnpm test

      - name: Test (packages)
        run: pnpm -r run --if-present test
```

Key decisions:
- **No path filters** — run on everything for simplicity (per Q4 answer)
- **`--if-present`** — skip packages missing a script; failing scripts still fail CI (per Q2)
- **Root first, then packages** — root `src/` has no workspace deps (per Q6)
- **`cancel-in-progress: true`** — no point running stale builds (per Q8)
- **Explicit `permissions: contents: read`** — least privilege (per Q9)
- **`ubuntu-latest`** — auto-updating, no OS-specific deps (per Q13)
- **No pnpm version in action** — auto-detected from `packageManager` field (per Q14)
- **Node 22** — matches current dev environment

---

### Phase 4: Preview publish workflow

**Files created:**
- `.github/workflows/publish-preview.yml`

```yaml
name: Publish Preview

on:
  push:
    branches: [develop]

concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  publish-preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build (root)
        run: pnpm build

      - name: Build (packages)
        run: pnpm -r run --if-present build

      - name: Check for changesets
        id: changesets
        run: |
          if ls .changeset/*.md 1>/dev/null 2>&1; then
            echo "has_changesets=true" >> $GITHUB_OUTPUT
          else
            echo "has_changesets=false" >> $GITHUB_OUTPUT
          fi

      - name: Version (snapshot)
        if: steps.changesets.outputs.has_changesets == 'true'
        run: pnpm changeset version --snapshot preview

      - name: Publish preview
        if: steps.changesets.outputs.has_changesets == 'true'
        run: pnpm -r --filter '!generacy-extension' publish --tag preview --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Key decisions:
- **Only publish when `.changeset/*.md` files exist** — avoids noise from docs-only changes
- **`--snapshot preview`** — produces versions like `0.1.0-preview.20260225143022`
- **`--filter '!generacy-extension'`** — explicitly exclude VS Code extension (per Q11)
- **`--no-git-checks`** — snapshot versioning modifies package.json without committing
- **`cancel-in-progress: false`** — prevent partial publishes (per Q8)
- **Ephemeral runner cleanup** — no git reset needed (per Q3)
- **`registry-url`** — required for `NODE_AUTH_TOKEN` to work with `setup-node`

---

### Phase 5: Stable release workflow

**Files created:**
- `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build (root)
        run: pnpm build

      - name: Build (packages)
        run: pnpm -r run --if-present build

      - name: Create Release PR or Publish
        id: changesets
        uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm -r --filter '!generacy-extension' publish --no-git-checks
          title: 'chore: version packages'
          commit: 'chore: version packages'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Key decisions:
- **`changesets/action@v1`** — creates "Version Packages" PR when changesets exist; publishes when PR is merged
- **`permissions: contents: write, pull-requests: write`** — needed to create PRs and push version commits (per Q9)
- **`cancel-in-progress: false`** — prevent partial publishes (per Q8)
- **`--filter '!generacy-extension'`** — exclude VS Code extension from publish

---

### Phase 6: Manual steps (documented, not automated)

These steps require human action and cannot be automated in the PR:

#### 6.1 Configure `NPM_TOKEN` secret

- Create a **granular access token** on npmjs.com scoped to `@generacy-ai/*` with read-write publish permissions (per Q7)
- Add as `NPM_TOKEN` in GitHub repo Settings → Secrets and variables → Actions

#### 6.2 Branch protection on `main`

- Require PR reviews before merging
- Require status checks to pass: `ci` job from the CI workflow
- These settings are configured in GitHub repo Settings → Branches → Branch protection rules

#### 6.3 Sync `main` to `develop`

- The spec notes `main` only has initial commits. It needs to be synced to match `develop`
- This should be done via a PR from `develop` → `main` after CI is in place

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Publish ordering | Changesets default | Changesets + pnpm handle topological ordering automatically (Q1) |
| Missing scripts | `--if-present` | Resilient for future packages; failing scripts still fail CI (Q2) |
| Snapshot cleanup | Ephemeral runner | No git reset needed — runner is discarded (Q3) |
| Path filters | None | Run CI on everything — simpler, no stale filters (Q4) |
| Lint strategy | Root + per-package independent | Root eslint ignores `packages/`; each package has own config (Q5) |
| Build order | Root first, then packages | Root has no workspace deps (Q6) |
| NPM token type | Granular access token | Scoped to `@generacy-ai/*`, least privilege (Q7) |
| Concurrency | Cancel CI, don't cancel publish | Stale CI is useless; partial publishes are dangerous (Q8) |
| Permissions | Explicit least-privilege | Matches existing workflow pattern (Q9) |
| Version linking | None | Independent versioning with `updateInternalDependencies: "patch"` (Q10) |
| Extension exclusion | Explicit `--filter` | Prevents accidental npm publish of VS Code extension (Q11) |
| Runner OS | `ubuntu-latest` | No OS-specific deps, auto-updates (Q13) |
| pnpm version | `packageManager` field | Auto-detected by action and Corepack (Q14) |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| `NPM_TOKEN` not configured | Publish workflows will fail gracefully; CI is unaffected |
| Extension accidentally published | Explicit `--filter '!generacy-extension'` in all publish commands |
| Excluded packages attempted publish | Excluded from workspace — `pnpm -r` won't reach them |
| Lockfile mismatch | `--frozen-lockfile` ensures CI uses exact lockfile versions |
| Race conditions on publish | Concurrency groups without cancellation on publish workflows |
| Root package.json bloat | Only add `@changesets/cli` to devDeps and `packageManager` field; no scripts/deps changes |

## Files Changed Summary

| File | Action | Description |
|------|--------|-------------|
| `.changeset/config.json` | Create | Changesets configuration |
| `package.json` (root) | Modify | Add `packageManager`, `@changesets/cli` devDep |
| `pnpm-lock.yaml` | Modify | Updated by `pnpm install` |
| `packages/generacy/package.json` | Modify | Add `publishConfig` |
| `packages/orchestrator/package.json` | Modify | Add `publishConfig` |
| `packages/workflow-engine/package.json` | Modify | Add `publishConfig` |
| `packages/knowledge-store/package.json` | Modify | Add `publishConfig` |
| `packages/github-actions/package.json` | Modify | Add `publishConfig` |
| `packages/generacy-plugin-cloud-build/package.json` | Modify | Add `publishConfig` |
| `packages/generacy-plugin-copilot/package.json` | Modify | Add `publishConfig` |
| `packages/generacy-plugin-claude-code/package.json` | Modify | Add `publishConfig` |
| `packages/github-issues/package.json` | Modify | Add `publishConfig` |
| `packages/jira/package.json` | Modify | Add `publishConfig` |
| `.github/workflows/ci.yml` | Create | CI pipeline |
| `.github/workflows/publish-preview.yml` | Create | Preview snapshot publishing |
| `.github/workflows/release.yml` | Create | Stable release via Changesets |
