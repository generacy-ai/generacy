# Feature Specification: Dev Container Feature for External Developer Onboarding

**Branch**: `226-related-part-generacy-ai` | **Date**: 2026-02-23 | **Status**: Draft

## Related

Part of generacy-ai/tetrad-development#6 (Dev Container Infrastructure Refactor)

## Summary

Create a [Dev Container Feature](https://containers.dev/implementors/features/) that external developers can add to their `devcontainer.json` to get the complete Generacy AI development toolchain installed automatically. This is the primary onboarding mechanism — a single line in their config gives them Node.js, GitHub CLI, Claude Code, and the Generacy/Agency npm packages. The feature will be published to GHCR via a GitHub Actions workflow and follow the standard Dev Container Feature authoring conventions.

## User Stories

### US1: External Developer Onboarding

**As an** external developer joining a Generacy-powered project,
**I want** to add a single feature reference to my `devcontainer.json`,
**So that** all Generacy tooling is automatically installed when my dev container builds, without manual setup.

**Acceptance Criteria**:
- [ ] Adding `"ghcr.io/generacy-ai/generacy/generacy:1": {}` to `devcontainer.json` features installs all required tools
- [ ] Works with any standard Debian/Ubuntu-based dev container image (Python, Node, Ubuntu, etc.)
- [ ] No manual post-build steps required — tools are available immediately on terminal open
- [ ] `generacy`, `agency`, `claude`, `gh`, and `node` commands are all on PATH after build

### US2: Configurable Installation

**As a** developer with specific environment requirements,
**I want** to configure which tools are installed and their versions,
**So that** I can tailor the feature to my project's needs without conflicts.

**Acceptance Criteria**:
- [ ] Can specify a pinned version of `@generacy-ai/generacy` (e.g., `"version": "1.2.3"`)
- [ ] Can disable Agency installation (`"installAgency": false`)
- [ ] Can disable Claude Code installation (`"installClaudeCode": false`)
- [ ] Can specify Node.js major version (`"nodeVersion": "20"`)
- [ ] Defaults install everything with latest versions and Node 22

### US3: Idempotent Dependency Installation

**As a** developer using a base image that already has Node.js or GitHub CLI,
**I want** the feature to detect existing installations and skip redundant installs,
**So that** the build is fast and doesn't create conflicts with my base image's tooling.

**Acceptance Criteria**:
- [ ] If `node` is already on PATH, Node.js installation is skipped
- [ ] If `gh` is already on PATH, GitHub CLI installation is skipped
- [ ] Existing installations are not overwritten or downgraded
- [ ] Feature works correctly with the `ghcr.io/devcontainers/features/node` feature already applied

### US4: Feature Publishing and Distribution

**As a** Generacy maintainer,
**I want** the feature automatically published to GHCR when I push a version tag,
**So that** external developers always have access to the latest stable feature.

**Acceptance Criteria**:
- [ ] Pushing a `feature/v*` tag triggers the publish workflow
- [ ] Feature is published to `ghcr.io/generacy-ai/generacy/generacy:<version>`
- [ ] Published feature is usable in any `devcontainer.json` referencing the GHCR path
- [ ] Workflow uses minimal permissions (read contents, write packages)

### US5: Feature Verification

**As a** Generacy maintainer,
**I want** automated tests that verify the feature installs correctly,
**So that** regressions are caught before publishing broken versions.

**Acceptance Criteria**:
- [ ] Test script verifies all tool binaries are present and executable
- [ ] Tests run against Python and Ubuntu base images
- [ ] Tests can be run locally via `devcontainer features test`
- [ ] Test scenarios cover default options and toggled-off options

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `devcontainer-feature.json` metadata at `packages/devcontainer-feature/src/generacy/` | P1 | Must follow [Dev Container Feature spec](https://containers.dev/implementors/features/) |
| FR-002 | Create `install.sh` that installs Node.js if not present | P1 | Use NodeSource; respect `$NODEVERSION` option (default: 22) |
| FR-003 | `install.sh` installs GitHub CLI if not present | P1 | Use GitHub's official apt repository |
| FR-004 | `install.sh` installs Claude Code when `$INSTALLCLAUDECODE` is true | P1 | Must handle non-root user context; use official installer |
| FR-005 | `install.sh` installs `@generacy-ai/generacy` globally via npm | P1 | Respect `$VERSION` option; default to `latest` |
| FR-006 | `install.sh` installs `@generacy-ai/agency` globally when `$INSTALLAGENCY` is true | P1 | Use same version as generacy package |
| FR-007 | `install.sh` verifies all installations succeed | P1 | Exit non-zero if any required tool is missing |
| FR-008 | `install.sh` uses `#!/bin/sh` and `set -e` | P1 | Dev Container Feature convention |
| FR-009 | `install.sh` handles both root and non-root execution | P1 | Feature scripts run as root; Claude install needs user context |
| FR-010 | Feature declares `installsAfter` ordering for `common-utils` and `node` features | P2 | Ensures correct install order if used alongside other features |
| FR-011 | Create GitHub Actions workflow for publishing to GHCR | P1 | Trigger on `feature/v*` tags |
| FR-012 | Create test script at `test/generacy/test.sh` | P1 | Verify all tool installations |
| FR-013 | Create `test/generacy/scenarios.json` for test matrix | P2 | Cover default and non-default option combinations |
| FR-014 | Create README documenting usage, options, and examples | P2 | Include quick-start snippet and option descriptions |
| FR-015 | `install.sh` works on Debian/Ubuntu-based images | P1 | Standard devcontainer base; uses `apt-get` |

## Technical Design

### Directory Structure

```
packages/devcontainer-feature/
├── src/
│   └── generacy/
│       ├── devcontainer-feature.json    # Feature metadata and options
│       └── install.sh                   # Main install script
├── test/
│   └── generacy/
│       ├── test.sh                      # Verification test script
│       └── scenarios.json               # Test scenario matrix
└── README.md                            # Usage documentation
```

### Feature Metadata (`devcontainer-feature.json`)

```json
{
  "id": "generacy",
  "version": "0.1.0",
  "name": "Generacy AI Development Tools",
  "documentationURL": "https://github.com/generacy-ai/generacy",
  "description": "Installs Generacy workflow tooling, Agency MCP server, Claude Code, and GitHub CLI for AI-driven development",
  "options": {
    "version": {
      "type": "string",
      "default": "latest",
      "description": "Version of @generacy-ai/generacy to install"
    },
    "installAgency": {
      "type": "boolean",
      "default": true,
      "description": "Also install @generacy-ai/agency MCP server"
    },
    "installClaudeCode": {
      "type": "boolean",
      "default": true,
      "description": "Install Claude Code AI agent"
    },
    "nodeVersion": {
      "type": "string",
      "default": "22",
      "description": "Node.js major version to install (skip if already present)"
    }
  },
  "installsAfter": [
    "ghcr.io/devcontainers/features/common-utils",
    "ghcr.io/devcontainers/features/node"
  ]
}
```

### Install Script Flow (`install.sh`)

```
1. Check for Node.js → if missing, install via NodeSource ($NODEVERSION)
2. Check for GitHub CLI → if missing, install from GitHub apt repo
3. If $INSTALLCLAUDECODE == "true":
   → Detect non-root user ($_REMOTE_USER or fallback)
   → Install Claude Code via official installer as that user
   → Ensure ~/.local/bin is on PATH
4. Install npm packages globally:
   → npm install -g @generacy-ai/generacy@$VERSION
   → If $INSTALLAGENCY == "true": npm install -g @generacy-ai/agency@$VERSION
5. Verify installations:
   → Check each expected binary exists on PATH
   → Exit 1 with descriptive error if any check fails
```

### Publishing Workflow

```yaml
# .github/workflows/publish-devcontainer-feature.yml
Trigger: push tags matching 'feature/v*'
Action: devcontainers/action@v1 with publish-features
Target: ghcr.io/generacy-ai/generacy/generacy:<version>
```

### Developer Experience

External developer adds to their `devcontainer.json`:

```json
{
  "image": "mcr.microsoft.com/devcontainers/python:3.12",
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:1": {}
  }
}
```

With custom options:

```json
{
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:1": {
      "version": "1.2.3",
      "installClaudeCode": false,
      "nodeVersion": "20"
    }
  }
}
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Feature installs on clean Python image | Pass | `devcontainer features test --base-image mcr.microsoft.com/devcontainers/python:3.12` |
| SC-002 | Feature installs on clean Ubuntu image | Pass | `devcontainer features test --base-image mcr.microsoft.com/devcontainers/base:ubuntu` |
| SC-003 | All tool binaries available post-install | 5/5 (node, gh, claude, generacy, agency) | `test.sh` verifying each `--version` command |
| SC-004 | Install script idempotency | No errors on re-run | Run feature install twice on same image |
| SC-005 | Option toggles work | Agency/Claude skip when disabled | Test scenarios with `installAgency: false` and `installClaudeCode: false` |
| SC-006 | Publishing workflow succeeds | Feature accessible via GHCR | Push `feature/v0.1.0` tag and verify `ghcr.io` pull |
| SC-007 | Feature install time | < 3 minutes on clean image | Time the `devcontainer features test` run |

## Assumptions

- Target dev container base images are Debian/Ubuntu-based (standard for VS Code devcontainers)
- `apt-get` is available in all target images
- `curl` is available or can be installed via apt
- The `@generacy-ai/generacy` and `@generacy-ai/agency` packages are published to the npm public registry
- Claude Code's official install script (`https://claude.ai/install.sh`) remains stable and available
- GitHub CLI's apt repository (`cli.github.com`) remains available
- NodeSource continues to provide Node.js packages via their setup script
- The `devcontainers/action@v1` GitHub Action handles OCI artifact publishing to GHCR
- Feature scripts run as root during container build (standard devcontainer behavior)
- The `_REMOTE_USER` variable is set by the devcontainer runtime to the non-root user

## Out of Scope

- **Non-Debian/Ubuntu base images** (Alpine, Fedora, etc.) — can be added later if needed
- **Windows container support** — devcontainers are Linux-based
- **Auto-configuration of Claude Code API keys** — users provide their own credentials
- **MCP server auto-start** — Agency server configuration is handled separately
- **VS Code extension installation** — handled by `devcontainer.json` customizations, not this feature
- **Public Dev Container Feature index submission** — future work after the feature is stable
- **Version pinning of GitHub CLI or Claude Code** — these install latest; pinning can be added later
- **Offline/air-gapped installation** — requires internet access for package downloads
- **CI/CD integration testing** — the publish workflow is tested manually; automated pipeline testing is future work
- **Monorepo workspace integration** — this feature package is standalone and not part of the pnpm workspace build

---

*Generated by speckit*
