# Feature Specification: 5.4 — Publish Dev Container Feature to GHCR

**Branch**: `252-5-4-publish-dev` | **Date**: 2026-02-27 | **Status**: Draft

## Summary

Publish the Generacy Dev Container Feature as an OCI artifact to GitHub Container Registry (GHCR) at `ghcr.io/generacy-ai/generacy/generacy`. The feature bundles Node.js, GitHub CLI, Claude Code, Generacy CLI, and Agency MCP into a single installable unit for any Debian/Ubuntu-based dev container. Two release streams are maintained: `:preview` (from `develop`) for early adopters and `:1` (major version, from `main`) for stable users.

## User Stories

### US1: Dev container consumer pulls the stable feature

**As a** developer onboarding to a Generacy project,
**I want** to add `ghcr.io/generacy-ai/generacy/generacy:1` to my `devcontainer.json`,
**So that** my dev container automatically provisions all required AI development tools without manual setup.

**Acceptance Criteria**:
- [ ] `ghcr.io/generacy-ai/generacy/generacy:1` is publicly pullable without authentication
- [ ] Feature installs Node.js (if absent), GitHub CLI (if absent), Claude Code, Generacy CLI, and Agency MCP
- [ ] All installed tools are functional and on PATH after container creation
- [ ] Feature works on Python, Ubuntu, and TypeScript-Node base images

### US2: Dev container consumer pulls the preview feature

**As a** developer testing pre-release tooling,
**I want** to reference `ghcr.io/generacy-ai/generacy/generacy:preview` in my `devcontainer.json`,
**So that** I can evaluate upcoming changes before they reach the stable channel.

**Acceptance Criteria**:
- [ ] `:preview` tag is pushed on every merge to `develop` (when changesets exist)
- [ ] Preview feature installs `@preview`-tagged npm packages
- [ ] Preview feature is publicly accessible

### US3: Maintainer publishes a stable release

**As a** Generacy maintainer,
**I want** the feature to auto-publish on merge to `main` after npm packages are released,
**So that** the GHCR feature always matches the latest stable npm packages.

**Acceptance Criteria**:
- [ ] `release.yml` triggers `publish-devcontainer-feature.yml` with `mode: stable` after changesets publish
- [ ] `devcontainers/action@v1` generates correct semver tags (`:1`, `:1.0`, `:1.0.0`)
- [ ] No manual steps required beyond merging the PR

### US4: Maintainer publishes a preview release

**As a** Generacy maintainer,
**I want** the feature to auto-publish a `:preview` tag on every `develop` merge,
**So that** early adopters always have access to the latest in-progress tooling.

**Acceptance Criteria**:
- [ ] `publish-preview.yml` triggers `publish-devcontainer-feature.yml` with `mode: preview`
- [ ] Preview publish uses `oras` to push the `:preview` mutable tag
- [ ] Skipped when no changesets are present (no-op merge)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Publish feature to `ghcr.io/generacy-ai/generacy/generacy` via `publish-devcontainer-feature.yml` | P1 | Reusable workflow, called by both `release.yml` and `publish-preview.yml` |
| FR-002 | Stable publish uses `devcontainers/action@v1` to generate semver tags (`:1`, `:1.0`, `:1.0.0`) | P1 | Triggered on merge to `main` when changesets are published |
| FR-003 | Preview publish uses `oras` CLI to push mutable `:preview` tag | P1 | Triggered on merge to `develop` when changesets exist |
| FR-004 | GHCR package visibility is set to **public** after first publish | P1 | Manual one-time step in GitHub package settings |
| FR-005 | Feature installs Node.js via NodeSource if `node` is not on PATH | P2 | Configurable version via `nodeVersion` option (default: `22`) |
| FR-006 | Feature installs GitHub CLI via apt if `gh` is not on PATH | P2 | Skips if already present |
| FR-007 | Feature installs Claude Code via `npm install -g @anthropic-ai/claude-code` | P2 | Controlled by `installClaudeCode` option (default: `true`) |
| FR-008 | Feature installs `@generacy-ai/generacy` globally | P1 | Version controlled by `version` option |
| FR-009 | Feature installs `@generacy-ai/agency` globally | P2 | Controlled by `installAgency` option (default: `true`) |
| FR-010 | Feature verifies all installed tools are functional before completing | P2 | `--version` checks for each tool |
| FR-011 | Feature declares `installsAfter` for `common-utils` and `node` features | P3 | Ensures correct ordering when composed with other features |
| FR-012 | Validate feature installs correctly on Python, Ubuntu, and TypeScript-Node base images | P1 | Test via `devcontainer features test` with scenarios |
| FR-013 | Workflow permissions scoped to `contents: read` and `packages: write` | P1 | Least-privilege principle |
| FR-014 | Tag-triggered publish via `feature/v*` tags for manual stable releases | P3 | Fallback mechanism; primary path is automated via `release.yml` |

## Version Tagging Strategy

| Stream | Branch | Trigger | GHCR Tag | npm Tag | Workflow |
|--------|--------|---------|----------|---------|----------|
| **Stable** | `main` | Changesets publish | `:1`, `:1.0`, `:1.0.0` | `latest` | `release.yml` → `publish-devcontainer-feature.yml (stable)` |
| **Preview** | `develop` | Changesets exist | `:preview` (mutable) | `preview` | `publish-preview.yml` → `publish-devcontainer-feature.yml (preview)` |
| **Manual** | any | `feature/v*` tag | `:1`, `:1.0`, `:1.0.0` | N/A | `publish-devcontainer-feature.yml` (tag trigger) |

### Semver tagging behavior (stable)

The `devcontainers/action@v1` action reads `version` from `devcontainer-feature.json` (currently `0.1.0`) and produces OCI tags following the Dev Container Feature distribution spec:
- `ghcr.io/generacy-ai/generacy/generacy:0` (major)
- `ghcr.io/generacy-ai/generacy/generacy:0.1` (major.minor)
- `ghcr.io/generacy-ai/generacy/generacy:0.1.0` (exact)

Once the feature reaches `1.0.0`, the major tag becomes `:1` as referenced in the acceptance criteria.

### Preview tagging behavior

The `oras push` step overwrites the `:preview` tag on every publish. This is a mutable tag — consumers always get the latest preview build.

## Test Matrix

| Scenario | Base Image | Options | Validates |
|----------|-----------|---------|-----------|
| `test` (default) | Python 3.12 | All defaults | All five tools installed and on PATH |
| `defaults_python` | Python 3.12 | All defaults | All tools on Debian/Python base |
| `defaults_ubuntu` | Ubuntu base | All defaults | All tools on bare Ubuntu base |
| `all_disabled` | Python 3.12 | `installAgency: false`, `installClaudeCode: false` | Only Node, GH CLI, Generacy installed |
| `no_claude_code` | Python 3.12 | `installClaudeCode: false` | Claude Code absent, all others present |
| `no_agency` | Python 3.12 | `installAgency: false` | Agency absent, all others present |
| `node_20` | Python 3.12 | `nodeVersion: "20"` | Node.js 20.x installed |

Tests are run via:
```bash
devcontainer features test \
  --features generacy \
  --base-image mcr.microsoft.com/devcontainers/python:3.12 \
  --project-folder packages/devcontainer-feature
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Stable feature is publicly pullable | `ghcr.io/generacy-ai/generacy/generacy:1` resolves without auth | `docker pull` or `devcontainer build` from an unauthenticated context |
| SC-002 | Preview feature is publicly pullable | `ghcr.io/generacy-ai/generacy/generacy:preview` resolves without auth | Same as above |
| SC-003 | All test scenarios pass | 7/7 scenarios green | `devcontainer features test` in CI |
| SC-004 | Stable publish triggers automatically | Feature published on every `main` merge with changesets | Verify `release.yml` → `publish-devcontainer-feature.yml` chain |
| SC-005 | Preview publish triggers automatically | Feature published on every `develop` merge with changesets | Verify `publish-preview.yml` → `publish-devcontainer-feature.yml` chain |
| SC-006 | Feature install time | < 120 seconds on a clean base image | Measure in CI logs |
| SC-007 | All installed tools functional | `--version` succeeds for each tool | Verified by `install.sh` step 7 and test scripts |

## Implementation Checklist

- [ ] Trigger a test publish to GHCR (preview mode) by merging to `develop` with a changeset
- [ ] Verify the OCI artifact appears at `ghcr.io/generacy-ai/generacy/generacy:preview`
- [ ] Mark the GHCR package as **public** in GitHub package settings (`github.com/orgs/generacy-ai/packages/container/generacy%2Fgeneracy/settings`)
- [ ] Verify unauthenticated pull succeeds: `docker pull ghcr.io/generacy-ai/generacy/generacy:preview`
- [ ] Run `devcontainer features test` locally against all scenarios
- [ ] Test feature installation on Python, Ubuntu, and TypeScript-Node base images
- [ ] Trigger a stable publish by bumping `devcontainer-feature.json` version to `1.0.0` and merging to `main`
- [ ] Verify `:1`, `:1.0`, `:1.0.0` tags are created on GHCR
- [ ] Verify `generacy doctor` detects the feature correctly in a container built from the published feature
- [ ] Fix multi-repo template GHCR path (`ghcr.io/generacy-ai/features/generacy` → `ghcr.io/generacy-ai/generacy/generacy`)

## Assumptions

- The `@generacy-ai/generacy` and `@generacy-ai/agency` npm packages are published (dependencies 1.1, 1.4) before the first stable feature publish
- The CI/CD pipeline (issue #243) is operational and `release.yml` / `publish-preview.yml` are enabled on the repository
- GHCR package visibility can be toggled to public by an org admin (one-time manual step)
- All target base images are Debian/Ubuntu-based; Alpine and RHEL are not supported
- The `devcontainers/action@v1` action correctly handles the OCI artifact spec for semver tagging
- `GITHUB_TOKEN` has `packages: write` scope for GHCR pushes (automatic for GitHub-hosted runners)
- The `oras` CLI version 1.2.0 remains available and compatible for preview publishing

## Out of Scope

- Alpine, RHEL, or non-Debian base image support
- Publishing the feature to a separate `features` repository (feature lives in the monorepo)
- Automated integration tests that spin up a full dev container in CI (manual verification for now)
- VS Code extension (generacy-extension) packaging or publishing — handled separately
- Feature option to install specific Claude Code versions (uses `latest` always)
- Multi-architecture OCI manifests (arm64 support) — all tools are architecture-agnostic npm packages
- Automatic GHCR visibility toggle (must be done manually after first publish)

## Known Issues

- **Multi-repo template path mismatch**: The multi-repo onboarding template at `packages/templates/src/multi-repo/devcontainer.json.hbs` references `ghcr.io/generacy-ai/features/generacy` but the feature is published to `ghcr.io/generacy-ai/generacy/generacy`. This should be fixed as part of this work.

## Dependencies

| Dependency | Issue | Status | Impact |
|-----------|-------|--------|--------|
| CI/CD for generacy repo | #243 | Merged | Workflows must be active on `develop` and `main` branches |
| @generacy-ai/generacy npm package | 1.1 | Required | Feature installs this globally; must be published to npm |
| @generacy-ai/agency npm package | 1.4 | Required | Feature installs this globally; must be published to npm |

## File Inventory

| File | Purpose |
|------|---------|
| `packages/devcontainer-feature/src/generacy/devcontainer-feature.json` | Feature metadata, options, and version |
| `packages/devcontainer-feature/src/generacy/install.sh` | POSIX install script (runs as root in container) |
| `packages/devcontainer-feature/test/generacy/scenarios.json` | Test scenario definitions |
| `packages/devcontainer-feature/test/generacy/*.sh` | Test scripts for each scenario |
| `packages/devcontainer-feature/README.md` | Feature documentation |
| `.github/workflows/publish-devcontainer-feature.yml` | Reusable publish workflow (stable + preview) |
| `.github/workflows/release.yml` | Stable release pipeline (calls feature publish) |
| `.github/workflows/publish-preview.yml` | Preview release pipeline (calls feature publish) |

---

*Generated by speckit*
