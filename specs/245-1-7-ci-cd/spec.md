# Feature Specification: CI/CD for Generacy VS Code Extension

**Branch**: `245-1-7-ci-cd` | **Date**: 2026-02-28 | **Status**: Draft

## Summary

Implement GitHub Actions CI/CD pipelines to automatically build, test, package, and publish the Generacy VS Code extension (`generacy-ai.generacy`) to the VS Code Marketplace. The system supports two release streams: **preview** (pre-release on merge to `develop`) and **stable** (standard release on merge to `main`).

This integrates with the existing monorepo CI infrastructure while providing extension-specific build, packaging, and marketplace publishing via `@vscode/vsce`.

### Context

The Generacy monorepo already has CI (`ci.yml`), release (`release.yml`), and preview publishing (`publish-preview.yml`) workflows — but all three explicitly **exclude** `generacy-extension` from typecheck, test, and npm publish steps. A draft workflow template exists at `packages/generacy-extension/extension-publish.workflow.yml` but uses a tag-based trigger model (`extension-v*`) rather than the branch-merge model required by the issue specification. This spec defines the target-state workflows that replace the draft and integrate extension CI/CD into the monorepo's branch-based release process.

### Dependencies

| Dependency | Issue | Status | Required For |
|------------|-------|--------|-------------|
| Marketplace publisher account | #244 | Blocked | `VSCE_PAT` secret, actual publishing |
| Extension MVP | #250 | Blocked | Typecheck passing in CI |

### Release Streams

- **Preview**: On merge to `develop`, publish as VS Code pre-release (`vsce publish --pre-release`)
- **Stable**: On merge to `main`, publish as standard release (`vsce publish`)

## User Stories

### US1: Automated Preview Publishing

**As a** developer,
**I want** the extension to automatically publish a pre-release to the VS Code Marketplace when changes merge to `develop`,
**So that** testers can install and validate new features without manual packaging.

**Acceptance Criteria**:
- [x] Merging extension changes to `develop` triggers a publish workflow
- [x] The workflow builds, tests, packages, and publishes with `--pre-release`
- [x] If the version is already published, the workflow skips gracefully (green)

### US2: Automated Stable Publishing

**As a** maintainer,
**I want** the extension to automatically publish a stable release when changes merge to `main`,
**So that** end users receive validated updates on the VS Code Marketplace.

**Acceptance Criteria**:
- [x] Merging extension changes to `main` triggers a publish workflow
- [x] The workflow creates a git tag `extension-v{version}` and a GitHub Release with the `.vsix` attached
- [x] If the version is already published, the workflow skips gracefully

### US3: Extension-Specific PR CI

**As a** developer,
**I want** PRs that touch extension files to run extension-specific lint, build, and test checks,
**So that** I get fast feedback on extension changes without waiting for the full monorepo pipeline.

**Acceptance Criteria**:
- [x] PRs touching `packages/generacy-extension/**` trigger `extension-ci.yml`
- [x] The workflow runs lint, scoped build (with transitive deps), and test
- [ ] Typecheck is included once extension typecheck passes (blocked by #250)

### US4: Manual Publish Override

**As a** maintainer,
**I want** to manually trigger a publish via `workflow_dispatch` with a channel selector,
**So that** I can force-publish without touching extension files.

**Acceptance Criteria**:
- [x] `workflow_dispatch` accepts a `channel` input (preview or stable)
- [x] Branch-channel pairing is validated (preview from `develop`, stable from `main`)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `extension-ci.yml` for PR-scoped extension CI | P1 | Lint, build, test; typecheck deferred to #250 |
| FR-002 | Create `extension-publish.yml` for marketplace publishing | P1 | Core deliverable |
| FR-003 | Push trigger with `paths: packages/generacy-extension/**` filter | P1 | Prevents unnecessary publishes (Q1) |
| FR-004 | `workflow_dispatch` trigger with `channel` input | P1 | Manual override |
| FR-005 | Channel auto-detection: `develop` -> preview, `main` -> stable | P1 | |
| FR-006 | Branch-channel validation for `workflow_dispatch` | P1 | (Q7) |
| FR-007 | Version pre-check: skip publish if version already on marketplace | P1 | Green no-op (Q3) |
| FR-008 | VSCE auth via `VSCE_PAT` environment variable only | P1 | No `--pat` flag (Q10) |
| FR-009 | Scoped build with `pnpm --filter generacy-extension...` | P1 | Transitive workspace deps (Q4) |
| FR-010 | Git tag `extension-v{version}` on stable publish | P2 | Skip if exists (Q5) |
| FR-011 | GitHub Release with VSIX on stable publish | P2 | Auto-generated notes (Q6) |
| FR-012 | Concurrency `cancel-in-progress: false` for publish | P1 | Serialize publishes (Q9) |
| FR-013 | Remove `--filter '!generacy-extension'` from `ci.yml` test step | P1 | Typecheck exclusion retained pending #250 |
| FR-014 | Delete draft workflow `extension-publish.workflow.yml` | P2 | Superseded |
| FR-015 | Upload VSIX as build artifact (30-day retention) | P2 | Both channels |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Extension CI triggers on extension PRs | 100% | Verify `extension-ci.yml` runs on PRs touching `packages/generacy-extension/**` |
| SC-002 | Publish workflow triggers on merge to develop/main | 100% | Verify `extension-publish.yml` runs on push with paths filter |
| SC-003 | Version pre-check skips duplicate publishes | Green | Workflow exits green when version already published |
| SC-004 | Stable publish creates git tag and GitHub Release | Yes | Tag `extension-v{version}` and Release with VSIX |
| SC-005 | Extension visible on VS Code Marketplace | Yes | Requires #244 (VSCE_PAT) to be resolved first |

## Assumptions

- The `VSCE_PAT` secret will be configured in GitHub repo settings once #244 is resolved
- Extension typecheck will be fixed as part of #250 and re-enabled in CI at that time
- The `generacy-ai` publisher account exists on the VS Code Marketplace
- Root `.eslintrc.json` provides valid lint configuration for the extension

## Out of Scope

- Fixing extension typecheck errors (tracked by #250)
- Registering the marketplace publisher account (tracked by #244)
- Automated version bumping (versions are managed manually in `package.json`)
- Extension-specific changesets integration
- Filtered release notes (GitHub auto-generated is sufficient for now)

---

*Generated by speckit*
