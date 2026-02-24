# Feature Specification: Dev Container Feature for External Developer Onboarding

**Branch**: `226-related-part-generacy-ai` | **Date**: 2026-02-24 | **Status**: Draft

## Related

Part of generacy-ai/tetrad-development#6 (Dev Container Infrastructure Refactor)

## Summary

Create a [Dev Container Feature](https://containers.dev/implementors/features/) that external developers can add to their `devcontainer.json` to get all Generacy tooling installed with a single line. The feature packages Node.js, GitHub CLI, Claude Code, and the `@generacy-ai/generacy` and `@generacy-ai/agency` npm packages into a composable, distributable unit published to GitHub Container Registry (GHCR).

This is distinct from the internal dev container setup at `tetrad-development/.devcontainer/` — that configuration is for the core Generacy team. This feature targets external developers who need Generacy tooling in their own projects.

## User Stories

### US1: External Developer Onboarding

**As an** external developer adopting Generacy workflows,
**I want** to add a single feature reference to my `devcontainer.json`,
**So that** my dev container automatically includes all Generacy tooling without manual installation steps.

**Acceptance Criteria**:
- [ ] Adding `"ghcr.io/generacy-ai/generacy/generacy:1": {}` to `features` in any `devcontainer.json` installs all tools
- [ ] No manual post-creation steps are required — tooling is available immediately on container start
- [ ] Works with any Debian/Ubuntu-based dev container image (Python, Node, Go, Ubuntu, etc.)

### US2: Selective Tool Installation

**As a** developer who only needs specific Generacy components,
**I want** to configure which tools the feature installs via options,
**So that** I can minimize container build time and image size for my use case.

**Acceptance Criteria**:
- [ ] Setting `"installClaudeCode": false` skips Claude Code installation
- [ ] Setting `"installAgency": false` skips the `@generacy-ai/agency` package
- [ ] Setting `"version": "1.2.3"` pins the `@generacy-ai/generacy` package to that version
- [ ] Setting `"nodeVersion": "20"` installs Node.js 20 instead of the default 22

### US3: Idempotent Installation

**As a** developer with a base image that already includes Node.js or GitHub CLI,
**I want** the feature to detect existing installations and skip redundant installs,
**So that** my container builds are fast and don't conflict with my base image's tooling.

**Acceptance Criteria**:
- [ ] If `node` is already on `$PATH`, Node.js installation is skipped
- [ ] If `gh` is already on `$PATH`, GitHub CLI installation is skipped
- [ ] Feature works correctly when layered with the official `ghcr.io/devcontainers/features/node` feature

### US4: Feature Publishing and Distribution

**As a** Generacy maintainer,
**I want** to publish the feature to GHCR via a GitHub Actions workflow triggered by tags,
**So that** external developers can reference a stable, versioned feature URL.

**Acceptance Criteria**:
- [ ] Pushing a `feature/v*` tag triggers the publish workflow
- [ ] The feature is published to `ghcr.io/generacy-ai/generacy/generacy:<version>`
- [ ] The workflow uses `devcontainers/action@v1` with the correct base path

### US5: Feature Verification and Testing

**As a** Generacy maintainer,
**I want** automated tests that verify the feature installs correctly on multiple base images,
**So that** regressions are caught before publishing.

**Acceptance Criteria**:
- [ ] `test.sh` verifies all expected binaries are available (`node`, `gh`, `claude`, `generacy`, `agency`)
- [ ] Tests pass on `mcr.microsoft.com/devcontainers/python:3.12` base image
- [ ] Tests pass on `mcr.microsoft.com/devcontainers/base:ubuntu` base image
- [ ] `scenarios.json` defines test configurations including option variations

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `devcontainer-feature.json` with feature metadata and options schema | P1 | Id: `generacy`, version: `0.1.0` |
| FR-002 | Create `install.sh` that installs Node.js if not present | P1 | Use NodeSource, version controlled by `$NODEVERSION` option |
| FR-003 | `install.sh` installs GitHub CLI if not present | P1 | Use GitHub's official apt repository |
| FR-004 | `install.sh` installs Claude Code when `$INSTALLCLAUDECODE` is `true` | P1 | Must handle non-root user context via `su - $USERNAME` |
| FR-005 | `install.sh` installs `@generacy-ai/generacy` globally via npm | P1 | Version controlled by `$VERSION` option, default `latest` |
| FR-006 | `install.sh` installs `@generacy-ai/agency` globally when `$INSTALLAGENCY` is `true` | P1 | Same version as generacy package |
| FR-007 | `install.sh` verifies all installations succeeded | P1 | Check each binary is available on PATH |
| FR-008 | Script uses `#!/bin/sh` and `set -e` per feature convention | P1 | POSIX-compatible, fail-fast |
| FR-009 | Script handles both root and non-root execution contexts | P1 | Dev container features run as root during build |
| FR-010 | Feature declares `installsAfter` for ordering with common features | P2 | After `common-utils` and `node` features |
| FR-011 | Create GitHub Actions workflow for publishing to GHCR | P1 | Triggered by `feature/v*` tags |
| FR-012 | Create test suite using devcontainer CLI test framework | P2 | `test.sh` and `scenarios.json` |
| FR-013 | Create README with usage documentation and options reference | P2 | Include quick start and all option descriptions |
| FR-014 | Directory structure follows devcontainer feature conventions | P1 | `src/generacy/` and `test/generacy/` under `packages/devcontainer-feature/` |

## Technical Design

### Directory Structure

```
packages/devcontainer-feature/
├── src/
│   └── generacy/
│       ├── devcontainer-feature.json    # Feature metadata and options
│       └── install.sh                    # Installation script
├── test/
│   └── generacy/
│       ├── test.sh                       # Verification script
│       └── scenarios.json                # Test configurations
└── README.md                             # Usage documentation
```

### Feature Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `version` | string | `"latest"` | Version of `@generacy-ai/generacy` to install |
| `installAgency` | boolean | `true` | Also install `@generacy-ai/agency` MCP server |
| `installClaudeCode` | boolean | `true` | Install Claude Code AI agent |
| `nodeVersion` | string | `"22"` | Node.js major version (skipped if already present) |

### Install Script Flow

```
1. Check for Node.js → if missing, install via NodeSource ($NODEVERSION)
2. Check for GitHub CLI → if missing, install from GitHub apt repo
3. If $INSTALLCLAUDECODE == "true":
   a. Detect non-root user ($USERNAME or $_REMOTE_USER)
   b. Install Claude Code via official installer as that user
   c. Ensure claude binary is on PATH
4. Install @generacy-ai/generacy@$VERSION globally via npm
5. If $INSTALLAGENCY == "true":
   a. Install @generacy-ai/agency@$VERSION globally via npm
6. Verify all expected binaries are on PATH
```

### Key Implementation Details

- **User detection**: Dev container features run as root. The script must detect the configured non-root user (via `$_REMOTE_USER` or fallback to the first non-root user in `/etc/passwd`) for Claude Code installation, which expects to run as a normal user.
- **NodeSource installation**: Use the NodeSource setup script for the specified major version. This is the standard approach for getting specific Node.js versions on Debian/Ubuntu.
- **GitHub CLI installation**: Use GitHub's official apt repository (`https://cli.github.com/packages`) for reliable, up-to-date installs.
- **Idempotent checks**: Use `command -v <binary>` to detect existing installations before attempting to install.

### Publishing Workflow

```yaml
Trigger: push tags matching 'feature/v*'
Action: devcontainers/action@v1 with publish-features: true
Path: packages/devcontainer-feature/src
Registry: ghcr.io/generacy-ai/generacy/generacy
Post-publish: manually mark GHCR package as public
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Clean install on Python base image | All 5 tools available | `devcontainer features test` with Python 3.12 image |
| SC-002 | Clean install on Ubuntu base image | All 5 tools available | `devcontainer features test` with Ubuntu image |
| SC-003 | Install with Node.js pre-installed | Skips Node install, all tools available | Test with `devcontainers/features/node` layered |
| SC-004 | Install with options disabled | Only selected tools installed | Test with `installClaudeCode: false`, `installAgency: false` |
| SC-005 | Container build time (clean) | Under 5 minutes | Timed `devcontainer features test` |
| SC-006 | Feature publish workflow | Successful GHCR push | Tag-triggered workflow completes without error |

## Assumptions

- Target base images are Debian/Ubuntu-based (the standard for dev containers)
- The `@generacy-ai/generacy` and `@generacy-ai/agency` packages are published to the public npm registry
- Claude Code's official install script (`https://claude.ai/install.sh`) remains stable and supports non-interactive installation
- GitHub CLI's apt repository and NodeSource's setup scripts remain available at their current URLs
- Feature consumers have internet access during container build (no air-gapped support)
- The `devcontainers/action@v1` GitHub Action handles OCI artifact packaging and GHCR push
- Features run as root during the dev container build phase

## Out of Scope

- **Alpine/non-Debian base image support** — Dev container features conventionally target Debian/Ubuntu
- **Offline/air-gapped installation** — Requires network access for npm, apt, and script downloads
- **Automatic public index submission** — Submitting to `devcontainers/devcontainers.github.io` is a future task after the feature is stable
- **CI/CD integration testing** — Testing in real GitHub Codespaces or VS Code Remote Containers environments
- **Internal team dev container changes** — The `tetrad-development/.devcontainer/` setup is managed separately
- **Auto-configuration of Claude Code API keys or MCP settings** — Users configure credentials post-installation
- **Windows container support** — Dev container features target Linux containers only
- **Version auto-update mechanism** — Users must rebuild their container to get new versions

---

*Generated by speckit*
