# Feature Specification: CI/CD for Generacy VS Code Extension

**Branch**: `245-1-7-ci-cd` | **Date**: 2026-02-28 | **Status**: Draft

## Summary

Implement GitHub Actions CI/CD pipelines to automatically build, test, package, and publish the Generacy VS Code extension (`generacy-ai.generacy`) to the VS Code Marketplace. The system supports two release streams: **preview** (pre-release on merge to `develop`) and **stable** (standard release on merge to `main`). This integrates with the existing monorepo CI infrastructure while providing extension-specific build, packaging, and marketplace publishing via `@vscode/vsce`.

### Context

The Generacy monorepo already has CI (`ci.yml`), release (`release.yml`), and preview publishing (`publish-preview.yml`) workflows — but all three explicitly **exclude** `generacy-extension` from typecheck, test, and npm publish steps. A draft workflow template exists at `packages/generacy-extension/extension-publish.workflow.yml` but uses a tag-based trigger model (`extension-v*`) rather than the branch-merge model required by the issue specification. This spec defines the target-state workflows that replace the draft and integrate extension CI/CD into the monorepo's branch-based release process.

### Dependencies

| Dependency | Issue | Status | Required For |
|------------|-------|--------|-------------|
| Marketplace publisher registered | #244 (1.5) | Complete | Publishing to Marketplace |
| VS Code extension MVP | #250 (5.2) | Complete | Code to build/test/publish |
| `VSCE_PAT` GitHub secret | (part of #244) | Complete | Authenticated `vsce publish` |

## User Stories

### US1: Automated Preview Publishing

**As a** developer merging extension changes to `develop`,
**I want** the extension to be automatically published as a VS Code pre-release,
**So that** testers and early adopters can install preview builds directly from the Marketplace without manual packaging.

**Acceptance Criteria**:
- [ ] Merging to `develop` triggers a workflow that builds, tests, packages, and publishes the extension
- [ ] The extension is published with `--pre-release` flag via `vsce publish`
- [ ] The preview version is distinguishable from stable (uses pre-release version scheme)
- [ ] Failed builds do not publish; the pipeline stops on lint, build, typecheck, or test failure
- [ ] The VSIX artifact is uploaded to the workflow run for manual inspection

### US2: Automated Stable Publishing

**As a** maintainer merging a release to `main`,
**I want** the extension to be automatically published as a stable release on the VS Code Marketplace,
**So that** end users receive verified, production-quality updates through their normal VS Code update flow.

**Acceptance Criteria**:
- [ ] Merging to `main` triggers a workflow that builds, tests, packages, and publishes the extension
- [ ] The extension is published as a standard release (no `--pre-release` flag)
- [ ] A GitHub Release is created with the VSIX file attached and auto-generated release notes
- [ ] A git tag is created for the published version (e.g., `extension-v0.1.0`)
- [ ] The published version matches the `version` field in `packages/generacy-extension/package.json`

### US3: Extension CI on Pull Requests

**As a** developer submitting a PR that touches extension code,
**I want** the CI pipeline to validate my changes (lint, build, typecheck, test),
**So that** I have confidence my changes won't break the extension before merging.

**Acceptance Criteria**:
- [ ] PRs to `develop` or `main` that modify files in `packages/generacy-extension/` trigger extension CI checks
- [ ] The CI job runs lint, build, typecheck, and test for the extension package
- [ ] CI results are reported as GitHub check statuses on the PR
- [ ] No publishing occurs on PR builds (build and validate only)

### US4: Manual Workflow Dispatch

**As a** maintainer needing to re-publish or publish outside the normal merge flow,
**I want** to manually trigger the publish workflow from the GitHub Actions UI,
**So that** I can handle edge cases like failed publishes, hotfixes, or version corrections.

**Acceptance Criteria**:
- [ ] The publish workflow supports `workflow_dispatch` with a `channel` input (preview or stable)
- [ ] Manual dispatch runs the full pipeline: build, test, package, publish
- [ ] The workflow uses the current `package.json` version for the publish

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `extension-ci.yml` workflow triggered on PRs to `develop`/`main` when extension files change | P1 | Uses `paths` filter: `packages/generacy-extension/**` |
| FR-002 | CI workflow runs lint, build, typecheck, and test for the extension | P1 | Mirrors existing CI steps but scoped to extension |
| FR-003 | Create `extension-publish.yml` workflow triggered on push to `develop` | P1 | Preview/pre-release channel |
| FR-004 | Create `extension-publish.yml` job triggered on push to `main` | P1 | Stable release channel |
| FR-005 | Preview publish uses `vsce publish --pre-release --no-dependencies` | P1 | Flags extension as pre-release in Marketplace |
| FR-006 | Stable publish uses `vsce publish --no-dependencies` | P1 | Standard Marketplace release |
| FR-007 | Both publish paths authenticate via `VSCE_PAT` secret | P1 | Already configured in repo |
| FR-008 | Upload VSIX as workflow artifact on all builds (CI and publish) | P2 | 30-day retention; enables manual install/review |
| FR-009 | Create GitHub Release with VSIX attachment on stable publish | P1 | Uses `softprops/action-gh-release@v2` |
| FR-010 | Create and push git tag `extension-vX.Y.Z` on stable publish | P2 | Enables version tracking and rollback reference |
| FR-011 | Support `workflow_dispatch` for manual publishing | P2 | Input: `channel` (preview/stable) |
| FR-012 | Use `concurrency` groups to prevent parallel publishes | P1 | Group per channel to avoid race conditions |
| FR-013 | Remove `generacy-extension` exclusion from `ci.yml` typecheck/test steps | P1 | Extension should participate in monorepo CI |
| FR-014 | Use Node.js 22 and pnpm (matching existing workflows) | P1 | Consistency with `ci.yml` and `release.yml` |
| FR-015 | Use `pnpm install --frozen-lockfile` for reproducible installs | P1 | Prevent lockfile drift in CI |

## Technical Design

### Workflow Architecture

```
PR → develop/main
  └─ extension-ci.yml (paths: packages/generacy-extension/**)
       ├─ lint
       ├─ build
       ├─ typecheck
       ├─ test
       └─ package (vsce package) → upload VSIX artifact

Push → develop
  └─ extension-publish.yml (preview job)
       ├─ build + test
       ├─ vsce package --no-dependencies
       ├─ vsce publish --pre-release --no-dependencies
       └─ upload VSIX artifact

Push → main
  └─ extension-publish.yml (stable job)
       ├─ build + test
       ├─ vsce package --no-dependencies
       ├─ vsce publish --no-dependencies
       ├─ create git tag extension-vX.Y.Z
       ├─ create GitHub Release with VSIX
       └─ upload VSIX artifact
```

### Workflow Files

| File | Trigger | Purpose |
|------|---------|---------|
| `.github/workflows/extension-ci.yml` | PR to `develop`/`main` (path-filtered) | Validate extension changes |
| `.github/workflows/extension-publish.yml` | Push to `develop` (preview), push to `main` (stable), `workflow_dispatch` | Package and publish to Marketplace |

### Changes to Existing Workflows

| File | Change | Rationale |
|------|--------|-----------|
| `.github/workflows/ci.yml` | Remove `--filter '!generacy-extension'` from typecheck and test steps | Extension should be validated in monorepo CI alongside other packages |

### Version Strategy

- **Preview**: Publishes whatever version is in `package.json` with `--pre-release` flag. VS Code handles pre-release display and update channels independently.
- **Stable**: Publishes the version in `package.json` as a standard release. The workflow creates a git tag `extension-v{version}` for traceability.
- **Version bumps**: Managed manually in `package.json` before merging (consistent with the existing `PUBLISHING.md` process). Changesets are not used for the extension since it is excluded from npm publishing.

### Key Implementation Details

- **`--no-dependencies`**: Required because the extension uses esbuild to bundle all dependencies; `vsce` should not attempt to resolve/package npm dependencies separately.
- **Path filtering**: `extension-ci.yml` only triggers when files under `packages/generacy-extension/` change, avoiding unnecessary CI runs for unrelated monorepo changes.
- **Concurrency**: Publish jobs use concurrency groups (`extension-publish-preview`, `extension-publish-stable`) with `cancel-in-progress: false` to prevent incomplete publishes.
- **Permissions**: Publish workflow requires `contents: write` (for tags and releases) and read access for checkout. `VSCE_PAT` is provided via repository secret.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Extension visible on VS Code Marketplace | Listed and installable | Search "Generacy" in VS Code Extensions panel |
| SC-002 | Preview publish triggers on develop merge | 100% of merges with extension changes | GitHub Actions run history |
| SC-003 | Stable publish triggers on main merge | 100% of merges with extension changes | GitHub Actions run history |
| SC-004 | CI catches build failures before merge | All lint/build/typecheck/test failures block PR | PR check status on GitHub |
| SC-005 | VSIX artifact available on every workflow run | Present on all CI and publish runs | GitHub Actions artifact tab |
| SC-006 | GitHub Release created on stable publish | Release with VSIX attachment exists | GitHub Releases page |
| SC-007 | End-to-end publish time | < 5 minutes from merge to marketplace availability | Workflow duration + marketplace propagation |

## Assumptions

- The `VSCE_PAT` secret is already configured in the GitHub repository with `Marketplace > Manage` scope (completed as part of #244).
- The `generacy-ai` publisher account is registered and active on the VS Code Marketplace (completed as part of #244).
- The extension `package.json` contains all required Marketplace metadata (name, displayName, description, publisher, version, icon, repository, etc.).
- Version bumps in `package.json` are performed manually by the developer before merging; there is no automated version increment.
- The extension's `vscode:prepublish` script (`npm run build`) produces a correct production bundle via esbuild.
- The existing extension test suite (`vitest run`) is functional and can run in CI without VS Code runtime dependencies (or uses `@vscode/test-electron` for integration tests).
- `--no-dependencies` is the correct packaging mode since the extension bundles all dependencies via esbuild.

## Out of Scope

- **Automated version bumping**: No Changesets integration or auto-increment for the extension version. Developers manage `package.json` version manually.
- **Open VSX Registry publishing**: Only the official VS Code Marketplace is targeted. Open VSX support may be added later.
- **Extension integration testing in CI**: Full VS Code runtime integration tests (launching a VS Code instance) are not included. Only unit/component tests that run via `vitest` are executed.
- **Marketplace listing optimization**: Icon design, detailed README content, screenshot assets, and marketplace SEO are not part of this CI/CD spec.
- **Multi-platform builds**: The extension is platform-independent (TypeScript/JavaScript); no per-platform VSIX variants are produced.
- **Automated rollback**: If a publish produces a broken extension, rollback is manual (publish a new version or unpublish via `vsce`).
- **Notification/alerting**: No Slack, email, or other notification on publish success/failure beyond GitHub's built-in workflow notifications.
- **PAT rotation automation**: The `VSCE_PAT` secret must be manually rotated before expiry; no automated renewal is included.

---

*Generated by speckit*
