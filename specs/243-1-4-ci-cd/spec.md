# Feature Specification: 1.4 — CI/CD for generacy repo

**Branch**: `243-1-4-ci-cd` | **Date**: 2026-02-26 | **Status**: Draft

## Summary

Set up comprehensive CI/CD pipelines for the generacy monorepo using GitHub Actions. The system provides three release streams: **PR CI** (lint, typecheck, build, test on every pull request), **preview publish** (snapshot npm packages with `@preview` tag and Dev Container Feature as `:preview` on merge to `develop`), and **stable publish** (versioned npm packages with `@latest` tag and Dev Container Feature as `:1` on merge to `main`). This relies on changesets for version management and pnpm workspaces for monorepo orchestration.

### Packages Published

| Package | Registry | Preview Trigger | Stable Trigger |
|---------|----------|-----------------|----------------|
| `@generacy-ai/generacy` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/orchestrator` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/workflow-engine` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/knowledge-store` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/templates` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/generacy-plugin-github-issues` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/generacy-plugin-github-actions` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/generacy-plugin-jira` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/generacy-plugin-claude-code` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/generacy-plugin-cloud-build` | npm | merge to `develop` | merge to `main` |
| `@generacy-ai/generacy-plugin-copilot` | npm | merge to `develop` | merge to `main` |
| Dev Container Feature (`generacy`) | GHCR | merge to `develop` | merge to `main` |

**Excluded from npm**: `generacy-extension` (published to VS Code Marketplace separately, see issue 1.7).

### Plan Reference

[onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 1.4

### Execution

**Phase:** 2
**Blocked by:**
- [ ] generacy-ai/generacy#242 — npm publishing setup

## User Stories

### US1: PR Quality Gate

**As a** contributor to the generacy repo,
**I want** every pull request to be automatically linted, typechecked, built, and tested,
**So that** code quality issues are caught before merge and the `develop` branch stays green.

**Acceptance Criteria**:
- [ ] PRs targeting `develop` or `main` trigger the CI workflow
- [ ] CI runs: lint (root + packages), build (root + packages), typecheck (packages), test (root + packages)
- [ ] CI fails fast on the first broken step
- [ ] Concurrent runs on the same branch are cancelled (only latest commit runs)
- [ ] `generacy-extension` is excluded from typecheck and test (no VS Code API in CI)
- [ ] `@generacy-ai/orchestrator` and `@generacy-ai/generacy` are excluded from test (require runtime dependencies not available in CI)

### US2: Changeset Enforcement

**As a** maintainer,
**I want** PRs to be checked for changesets,
**So that** contributors are reminded to document user-facing changes for the changelog.

**Acceptance Criteria**:
- [ ] PRs to `develop` trigger a changeset check
- [ ] A warning is emitted if no changeset `.md` file is present (non-blocking)
- [ ] PRs with changesets show a confirmation message

### US3: Preview Publishing

**As a** developer integrating with generacy packages,
**I want** preview versions published automatically when changes merge to `develop`,
**So that** I can test unreleased changes before they are promoted to stable.

**Acceptance Criteria**:
- [ ] Merges to `develop` that include changesets trigger preview publishing
- [ ] Snapshot versions are created via `pnpm changeset version --snapshot preview`
- [ ] All npm packages (except `generacy-extension`) are published with the `preview` dist-tag
- [ ] Dev Container Feature is published to GHCR with the `:preview` tag
- [ ] If no changesets are present, the publish step is skipped (no empty publishes)
- [ ] Preview publishes do not create git tags or commits

### US4: Stable Release Publishing

**As a** maintainer,
**I want** a release PR to be automatically created when changesets land on `main`, and packages published when the release PR is merged,
**So that** stable releases follow a controlled, auditable process.

**Acceptance Criteria**:
- [ ] Pushes to `main` with unreleased changesets create a "Version Packages" PR
- [ ] The release PR bumps versions in `package.json` files and updates changelogs
- [ ] Merging the release PR publishes all npm packages with the `@latest` tag
- [ ] Dev Container Feature is published to GHCR with the `:1` (major version) tag
- [ ] `generacy-extension` is excluded from npm publishing
- [ ] The `changesets/action@v1` handles the release PR lifecycle

### US5: Dev Container Feature Publishing

**As a** developer using Codespaces or Dev Containers,
**I want** the generacy Dev Container Feature published to GHCR,
**So that** I can reference it in `devcontainer.json` and get generacy tooling automatically.

**Acceptance Criteria**:
- [ ] Dev Container Feature is published to `ghcr.io/generacy-ai/generacy/generacy`
- [ ] Preview publishes tag as `:preview`
- [ ] Stable publishes tag as `:1` (major version)
- [ ] The `devcontainers/action@v1` action handles the publishing
- [ ] GHCR package is set to public visibility after first publish

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | **CI workflow** runs lint, build, typecheck, and test on PRs to `develop` and `main` | P1 | `.github/workflows/ci.yml` |
| FR-002 | CI uses `pnpm install --frozen-lockfile` to ensure reproducible installs | P1 | No lockfile drift in CI |
| FR-003 | CI uses Node.js 22 and pnpm with caching via `actions/setup-node` | P1 | Matches local dev environment |
| FR-004 | CI concurrency cancels in-progress runs on same ref | P1 | Saves runner minutes |
| FR-005 | CI excludes `generacy-extension` from typecheck/test; excludes `orchestrator` and `generacy` CLI from test | P1 | These packages require runtime deps unavailable in CI |
| FR-006 | **Changeset bot** warns on PRs to `develop` if no changeset is present | P2 | `.github/workflows/changeset-bot.yml` |
| FR-007 | **Preview publish workflow** triggers on push to `develop` | P1 | `.github/workflows/publish-preview.yml` |
| FR-008 | Preview publish creates snapshot versions via `pnpm changeset version --snapshot preview` | P1 | Only when changesets exist |
| FR-009 | Preview publish pushes to npm with `--tag preview` dist-tag | P1 | Uses `NPM_TOKEN` secret |
| FR-010 | Preview publish pushes Dev Container Feature to GHCR as `:preview` | P1 | Extends existing workflow or adds step |
| FR-011 | **Release workflow** triggers on push to `main` | P1 | `.github/workflows/release.yml` |
| FR-012 | Release workflow uses `changesets/action@v1` to create release PRs or publish | P1 | Automated version bumps + changelogs |
| FR-013 | Release workflow publishes npm packages with `@latest` tag | P1 | Uses `NPM_TOKEN` and `GITHUB_TOKEN` |
| FR-014 | Release workflow publishes Dev Container Feature to GHCR as `:1` | P1 | Major-version tag for stable |
| FR-015 | All workflows require `contents: read` permission minimum; release needs `contents: write` and `pull-requests: write` | P1 | Least-privilege principle |
| FR-016 | `generacy-extension` is excluded from all npm publish commands | P1 | Published to VS Code Marketplace via separate workflow |
| FR-017 | Changeset config ignores `generacy-extension` and uses `develop` as base branch | P1 | `.changeset/config.json` |
| FR-018 | Preview publish concurrency does NOT cancel in-progress (ensures every merge publishes) | P2 | Prevents skipped publishes |
| FR-019 | Dev Container Feature publish workflow has `packages: write` permission for GHCR | P1 | Required for `ghcr.io` push |

## Workflow Architecture

```
PR opened/updated → ci.yml (lint, build, typecheck, test)
                   → changeset-bot.yml (changeset check)

Merge to develop  → publish-preview.yml (snapshot npm + GHCR :preview)

Merge to main     → release.yml (release PR or npm @latest + GHCR :1)
```

### Workflow: `ci.yml` (PR CI)

**Trigger**: `pull_request` and `push` to `develop`/`main`
**Steps**:
1. Checkout, pnpm setup, Node 22 + cache, `pnpm install --frozen-lockfile`
2. Lint root (`pnpm lint`), lint packages (`pnpm -r run --if-present lint`)
3. Build root (`pnpm build`), build packages (`pnpm -r run --if-present build`)
4. Typecheck packages (`pnpm -r --filter '!generacy-extension' run --if-present typecheck`)
5. Test root (`pnpm test`), test packages (excluding `generacy-extension`, `orchestrator`, `generacy` CLI)

### Workflow: `changeset-bot.yml`

**Trigger**: `pull_request` (opened/synchronize) to `develop`
**Steps**: Check for `.changeset/*.md` files, emit GitHub Actions warning if none found.

### Workflow: `publish-preview.yml`

**Trigger**: `push` to `develop`
**Steps**:
1. Checkout, pnpm setup, Node 22 + cache (with npm registry-url)
2. Build all packages
3. Check if changesets exist; skip publish if none
4. `pnpm changeset version --snapshot preview`
5. `pnpm -r --filter '!generacy-extension' publish --tag preview --no-git-checks`
6. Publish Dev Container Feature to GHCR with `:preview` tag

### Workflow: `release.yml`

**Trigger**: `push` to `main`
**Steps**:
1. Checkout, pnpm setup, Node 22 + cache
2. Build all packages
3. `changesets/action@v1`: create release PR or publish to npm
4. On publish: push Dev Container Feature to GHCR with `:1` tag

### Workflow: `publish-devcontainer-feature.yml`

**Current trigger**: tag `feature/v*`
**Target**: Called from preview/release workflows, or integrated as a step
**Steps**: `devcontainers/action@v1` with `publish-features: true`, `base-path-to-features: packages/devcontainer-feature/src`

## Secrets and Permissions

| Secret | Scope | Used By |
|--------|-------|---------|
| `NPM_TOKEN` | Organization | `publish-preview.yml`, `release.yml` |
| `GITHUB_TOKEN` | Automatic | `release.yml`, `publish-devcontainer-feature.yml`, `changeset-bot.yml` |

| Permission | Workflows | Purpose |
|-----------|-----------|---------|
| `contents: read` | All | Checkout repository |
| `contents: write` | `release.yml` | Create release commits/tags |
| `pull-requests: write` | `release.yml` | Create/update release PR |
| `id-token: write` | `publish-preview.yml`, `release.yml` | npm provenance |
| `packages: write` | `publish-devcontainer-feature.yml` | Push to GHCR |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | PR CI runs on every PR | 100% of PRs to `develop`/`main` | GitHub Actions run history |
| SC-002 | CI catches lint/type/test failures | Blocks merge on failure | Required status check in branch protection |
| SC-003 | Preview packages published on develop merge | Every merge with changesets publishes | npm registry: `npm info <pkg> dist-tags` shows `preview` |
| SC-004 | Stable packages published on main merge | Release PR merged triggers publish | npm registry: `npm info <pkg> dist-tags` shows `latest` |
| SC-005 | Dev Container Feature available on GHCR | Both `:preview` and `:1` tags exist | `docker pull ghcr.io/generacy-ai/generacy/generacy:preview` |
| SC-006 | CI run time | < 5 minutes for PR CI | GitHub Actions run duration |
| SC-007 | No manual steps for npm publishing | Fully automated from merge | No SSH/manual `npm publish` required |
| SC-008 | Changeset warnings on PRs | Warning present when no changeset | PR annotations visible in GitHub UI |

## Dependencies

| Dependency | Status | Impact |
|------------|--------|--------|
| **1.1 — npm publishing setup** (generacy#242) | Blocked | `NPM_TOKEN`, package `publishConfig`, `@generacy-ai` org access required before publishing works |
| **1.2 — latency CI** (latency repo) | External | Plugins depend on `@generacy-ai/latency*` packages being published to npm |
| **1.3 — agency CI** (agency repo) | External | Dev Container Feature installs `@generacy-ai/agency` from npm |
| **pnpm 9.15.9** | Available | Monorepo package manager, pinned in `packageManager` field |
| **@changesets/cli** | Available | Installed as devDependency in root `package.json` |
| **Node.js 22** | Available | CI uses `actions/setup-node@v4` |

## Assumptions

- The `NPM_TOKEN` organization secret is configured with publish access to the `@generacy-ai` npm scope (set up in issue 1.1).
- The `@generacy-ai/latency*` and `@generacy-ai/agency` packages are published to npm before CI can install them (issues 1.2, 1.3).
- Branch protection rules on `develop` and `main` will be configured to require the CI workflow to pass before merge.
- The GHCR package `ghcr.io/generacy-ai/generacy/generacy` visibility will be manually set to public after the first publish.
- The `generacy-extension` package is excluded from all CI test/typecheck and npm publish steps (published separately via VS Code Marketplace).
- Packages that require runtime dependencies (`orchestrator`, `generacy` CLI) are excluded from CI test but are still built and linted.
- The `develop` branch is the base branch for changesets and the primary integration branch.
- The `main` branch is the stable release branch.

## Out of Scope

- **VS Code extension CI/CD** — Covered by issue 1.7 (separate Marketplace publish workflow).
- **Latency and agency repo CI/CD** — Issues 1.2 and 1.3 respectively; those repos have their own pipelines.
- **Docker image publishing** — The `docker/` directory is not part of this CI/CD scope.
- **End-to-end / integration testing** — CI runs unit tests only; E2E testing is a separate initiative.
- **Monorepo build optimization** (e.g., Turborepo, Nx) — Current `pnpm -r` approach is sufficient for the repo's size.
- **Automated dependency updates** (Dependabot/Renovate) — Separate concern.
- **Code coverage reporting/enforcement** — Not required for initial CI setup.
- **GitHub Environments or deployment protection rules** — May be added later.
- **npm provenance attestation** — `id-token: write` permission is set but provenance is not yet enforced.

## Implementation Checklist

- [ ] Verify `ci.yml` runs correctly on PRs (lint, build, typecheck, test)
- [ ] Verify `changeset-bot.yml` warns on PRs without changesets
- [ ] Verify `publish-preview.yml` publishes snapshot versions on develop merge
- [ ] Extend preview workflow to publish Dev Container Feature to GHCR as `:preview`
- [ ] Verify `release.yml` creates release PRs and publishes on main merge
- [ ] Extend release workflow to publish Dev Container Feature to GHCR as `:1`
- [ ] Set GHCR package visibility to public after first publish
- [ ] Configure branch protection rules requiring CI to pass
- [ ] Test full cycle: PR → develop merge (preview) → main merge (stable)

---

*Generated by speckit*
