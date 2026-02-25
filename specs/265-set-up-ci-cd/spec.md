# Feature Specification: Set up CI/CD and npm publishing

Configure automated CI and npm publishing for the generacy repo's @generacy-ai scoped packages.

**Branch**: `265-set-up-ci-cd` | **Date**: 2026-02-25 | **Status**: Draft

## Summary

Set up a complete CI/CD pipeline for the generacy monorepo using GitHub Actions and Changesets. This includes continuous integration (lint, test, build) on all PRs, preview snapshot publishing to npm on merges to `develop`, and stable release publishing via Changesets' version-management workflow on merges to `main`. The pipeline covers the 6 active workspace packages under the `@generacy-ai` scope, while respecting the existing devcontainer feature workflow and the 6 excluded plugin packages that depend on the external `@generacy-ai/latency` repo.

### Context

- Replaces cross-repo issue #242 (closed). Previous PR #259 was closed due to destructive changes to root `package.json` and excessive spec bloat.
- The existing `.github/workflows/publish-devcontainer-feature.yml` must not be modified.
- The monorepo is ESM-only (`"type": "module"` in all packages) — no `require()` calls anywhere.
- The publish dependency chain across repos is: latency -> agency -> generacy (this repo publishes last).

### Repository structure (relevant packages)

**Active workspace packages** (included in `pnpm-workspace.yaml`):
| Package | Directory | Has `publishConfig`? |
|---------|-----------|---------------------|
| `@generacy-ai/generacy` | `packages/generacy` | No (needs adding) |
| `@generacy-ai/orchestrator` | `packages/orchestrator` | No (needs adding) |
| `@generacy-ai/workflow-engine` | `packages/workflow-engine` | No (needs adding) |
| `@generacy-ai/knowledge-store` | `packages/knowledge-store` | No (needs adding) |
| `@generacy-ai/templates` | `packages/templates` | Yes |
| `generacy-extension` | `packages/generacy-extension` | N/A (VS Code ext, not npm) |

**Excluded packages** (depend on `@generacy-ai/latency-*` via `workspace:*`):
- `generacy-plugin-claude-code`, `generacy-plugin-cloud-build`, `generacy-plugin-copilot`, `github-actions`, `github-issues`, `jira`

These are excluded from `pnpm-workspace.yaml` and should NOT be published by these workflows.

## User Stories

### US1: Developer opens a PR

**As a** developer,
**I want** automated CI checks (lint, test, build) to run on every pull request,
**So that** I get fast feedback on code quality before review.

**Acceptance Criteria**:
- [ ] CI workflow triggers on PRs targeting `develop` and `main`
- [ ] CI runs lint, test, and build for root and all active workspace packages
- [ ] CI uses `pnpm install --frozen-lockfile` to ensure reproducible installs
- [ ] CI status checks are visible on the PR and block merge when failing
- [ ] CI completes within a reasonable time (~5 minutes)

### US2: Developer merges to develop

**As a** developer,
**I want** preview snapshot versions published to npm when changes merge to `develop`,
**So that** dependent repos (agency, latency) and internal consumers can test pre-release versions.

**Acceptance Criteria**:
- [ ] Preview publish triggers only on push to `develop` (not PRs)
- [ ] Publishing only occurs when `.changeset/*.md` files are present (skip docs-only, config-only changes)
- [ ] Snapshot versions use `@preview` dist-tag with datetime format: `0.1.0-preview.20260225143022`
- [ ] All active `@generacy-ai/*` packages with changes are published
- [ ] Re-running the workflow skips already-published versions (idempotent)

### US3: Maintainer creates a stable release

**As a** maintainer,
**I want** Changesets to automate versioning and stable publishing when changes merge to `main`,
**So that** stable releases are consistent, documented, and require minimal manual steps.

**Acceptance Criteria**:
- [ ] On push to `main`, the `changesets/action` creates or updates a "Version Packages" PR
- [ ] The "Version Packages" PR bumps versions and updates changelogs based on changeset files
- [ ] Merging the "Version Packages" PR triggers npm publish with `@latest` dist-tag
- [ ] All active `@generacy-ai/*` packages with version bumps are published
- [ ] Publish uses `--access public` for scoped packages

### US4: Developer documents changes

**As a** developer,
**I want** a standardized way to describe my changes for versioning,
**So that** changelogs are generated automatically and version bumps are predictable.

**Acceptance Criteria**:
- [ ] `@changesets/cli` is available via `pnpm changeset`
- [ ] `.changeset/config.json` is configured with `baseBranch: "develop"` and `access: "public"`
- [ ] Developers can run `pnpm changeset` to create changeset files describing their changes
- [ ] Changeset files are committed as part of the PR

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `.github/workflows/ci.yml` — lint, test, build on PRs and pushes to `develop`/`main` | P1 | Use `pnpm install --frozen-lockfile`, Node 20, pnpm 9 |
| FR-002 | CI must run root-level lint, test, and build (`pnpm lint`, `pnpm test`, `pnpm build`) | P1 | Root has its own `src/` with message routing code |
| FR-003 | CI must run workspace-level lint, test, and build via `pnpm -r --filter './packages/*' run build` (and lint, test) | P1 | Only active workspace packages; use pnpm recursive with filter |
| FR-004 | Install `@changesets/cli` as root devDependency | P1 | Only change to root `package.json` — do NOT modify scripts or other deps |
| FR-005 | Create `.changeset/config.json` with `baseBranch: "develop"`, `access: "public"` | P1 | Standard Changesets config |
| FR-006 | Create `.github/workflows/publish-preview.yml` — snapshot publish on push to `develop` | P1 | Only when `.changeset/*.md` files exist; `@preview` dist-tag |
| FR-007 | Preview versions use datetime-based snapshot format: `X.Y.Z-preview.YYYYMMDDHHmmss` | P1 | Via `changeset version --snapshot preview` |
| FR-008 | Create `.github/workflows/release.yml` — stable release on push to `main` | P1 | Uses `changesets/action` to create Version Packages PR |
| FR-009 | Merging Version Packages PR triggers npm publish with `@latest` dist-tag | P1 | Handled by `changesets/action` publish command |
| FR-010 | Add `publishConfig: { "access": "public" }` to `@generacy-ai/generacy`, `@generacy-ai/orchestrator`, `@generacy-ai/workflow-engine`, `@generacy-ai/knowledge-store` | P1 | `@generacy-ai/templates` already has it |
| FR-011 | Do NOT add `publishConfig` to `generacy-extension` (VS Code ext) or excluded plugin packages | P1 | Extension publishes to VS Code Marketplace separately |
| FR-012 | All publish workflows require `NPM_TOKEN` secret (org-level) | P1 | Set as GitHub Actions secret |
| FR-013 | Publish workflows must be idempotent — re-runs skip already-published versions | P2 | npm publish with `--no-git-checks`; catch "already published" errors |
| FR-014 | Dependency verification before publish — check `@generacy-ai/agency-*` and `@generacy-ai/latency-*` deps are on npm | P2 | ESM-compatible (use `npm view` or `fetch()`, not `require()`) |
| FR-015 | Do NOT modify `.github/workflows/publish-devcontainer-feature.yml` | P1 | Explicitly stated constraint |
| FR-016 | Configure branch protection on `main`: require PR, require CI status checks | P2 | Manual GitHub settings step; document in spec |
| FR-017 | Sync `main` to match `develop` before enabling branch protection | P2 | One-time manual step; main currently has only initial commits |
| FR-018 | CI workflow should use a matrix or sequential strategy to handle root + packages efficiently | P3 | Prefer single job for simplicity unless build times warrant splitting |

## Technical Design

### 1. CI Workflow (`.github/workflows/ci.yml`)

```yaml
name: CI
on:
  pull_request:
    branches: [develop, main]
  push:
    branches: [develop, main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm -r run lint
      - run: pnpm build
      - run: pnpm -r run build
      - run: pnpm test
      - run: pnpm -r run test
```

### 2. Changesets Config (`.changeset/config.json`)

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
  "ignore": [
    "generacy-extension"
  ]
}
```

Key decisions:
- `ignore: ["generacy-extension"]` — VS Code extension is not published to npm
- `access: "public"` — all scoped packages are public
- `baseBranch: "develop"` — changesets are relative to develop
- `updateInternalDependencies: "patch"` — auto-bump workspace dependents

### 3. Preview Publish (`.github/workflows/publish-preview.yml`)

Triggers on push to `develop`. Steps:
1. Check for `.changeset/*.md` files — exit early if none
2. `changeset version --snapshot preview` — applies snapshot versions
3. `pnpm -r run build` — rebuild with new versions
4. `pnpm -r publish --tag preview --access public --no-git-checks` — publish snapshots

### 4. Stable Release (`.github/workflows/release.yml`)

Triggers on push to `main`. Uses `changesets/action`:
- **version command**: `pnpm changeset version` — creates "Version Packages" PR with bumped versions and changelogs
- **publish command**: `pnpm -r publish --access public` — publishes when Version Packages PR is merged

### 5. Package changes

Add to each publishable package's `package.json`:
```json
"publishConfig": {
  "access": "public"
}
```

Packages to update: `generacy`, `orchestrator`, `workflow-engine`, `knowledge-store`.

### 6. Root `package.json` change

Only addition:
```json
"devDependencies": {
  "@changesets/cli": "^2.27.0"
}
```

No changes to `scripts`, `dependencies`, or any other fields.

### 7. Dependency verification script

Before publish steps, verify external `@generacy-ai` dependencies are available:
```bash
npm view @generacy-ai/agency-kit version || echo "WARNING: agency-kit not found on npm"
npm view @generacy-ai/latency version || echo "WARNING: latency not found on npm"
```

This is a non-blocking check (warning only) since the excluded plugin packages that depend on latency are not in the active workspace.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | CI runs on every PR | 100% of PRs | GitHub Actions run history |
| SC-002 | CI catches lint/test/build failures | Blocks merge on failure | Test with intentional failure |
| SC-003 | Preview publish on develop merge | Publishes when changesets present | Check npm registry for `@preview` tag |
| SC-004 | Preview publish is skipped when no changesets | 0 publishes on non-changeset merges | GitHub Actions logs show skip |
| SC-005 | Stable release creates Version Packages PR | PR created on push to main | GitHub PR list |
| SC-006 | Stable publish on Version Packages merge | Packages appear with `@latest` tag | Check npm registry |
| SC-007 | Idempotent re-runs | No errors on re-run | Re-run workflow manually |
| SC-008 | CI build time | < 5 minutes | GitHub Actions timing |

## Assumptions

- `NPM_TOKEN` secret will be configured at the GitHub organization level before workflows are enabled
- The `@generacy-ai` npm scope is already claimed and the token has publish access
- Node 20 and pnpm 9 are used consistently (matching `engines` field and lockfile)
- The 6 excluded plugin packages (latency-dependent) will remain excluded from workspace and publishing
- `main` branch will be synced to `develop` before branch protection is enabled (one-time manual step)
- The `latency` and `agency` repos will set up their own CI/CD independently; this spec does not publish those packages
- All active workspace packages have working `lint`, `test`, and `build` scripts
- The `generacy-extension` package is published to VS Code Marketplace via a separate workflow, not npm

## Out of Scope

- Publishing `generacy-extension` to VS Code Marketplace (separate workflow)
- Publishing the devcontainer feature (handled by existing `publish-devcontainer-feature.yml`)
- Publishing the 6 excluded plugin packages (depend on `@generacy-ai/latency-*` from separate repo)
- Docker image builds and publishing (orchestrator Dockerfile exists but is out of scope)
- Setting up CI/CD for the `latency` or `agency` repos
- Modifying root `package.json` scripts or dependencies (only `@changesets/cli` added to devDependencies)
- Automated changelog generation beyond what Changesets provides by default
- Release notifications (Slack, email, etc.)
- Code coverage reporting or badge integration
- Monorepo-level caching or build optimization beyond pnpm's built-in cache
- npm provenance or package signing

---

*Generated by speckit*
