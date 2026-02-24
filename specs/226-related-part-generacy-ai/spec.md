# Feature Specification: ## Related
Part of generacy-ai/tetrad-development#6 (Dev Container Infrastructure Refactor)

## Summary

Create a [Dev Container Feature](https://containers

**Branch**: `226-related-part-generacy-ai` | **Date**: 2026-02-24 | **Status**: Draft

## Summary

## Related
Part of generacy-ai/tetrad-development#6 (Dev Container Infrastructure Refactor)

## Summary

Create a [Dev Container Feature](https://containers.dev/implementors/features/) that external developers can add to their `devcontainer.json` to get all Generacy tooling installed. This is the primary onboarding mechanism — a single line in their config.

## What is a Dev Container Feature?

A Feature is a self-contained install script + metadata that gets injected into any dev container at build time. It's the standard mechanism for composable devcontainer tooling. See [authoring guide](https://containers.dev/guide/author-a-feature).

## Developer Experience (Goal)

A developer adds this to their existing `devcontainer.json`:

```json
{
  "image": "mcr.microsoft.com/devcontainers/python:3.12",
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:1": {}
  }
}
```

That's it. Works with any base image. On container build, it installs:
- Node.js (if not already present)
- GitHub CLI (if not already present)
- Claude Code AI agent
- `@generacy-ai/generacy` npm package (global)
- `@generacy-ai/agency` npm package (global)

## Directory Structure

Create under `packages/devcontainer-feature/`:

```
packages/devcontainer-feature/
├── src/
│   └── generacy/
│       ├── devcontainer-feature.json
│       └── install.sh
├── test/
│   └── generacy/
│       ├── test.sh
│       └── scenarios.json
└── README.md
```

## `devcontainer-feature.json`

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

## `install.sh`

The install script should:

1. **Check for Node.js** — if `node` not found, install via NodeSource using `$NODEVERSION`
2. **Check for GitHub CLI** — if `gh` not found, install from GitHub's apt repo
3. **Install Claude Code** (if `$INSTALLCLAUDECODE` is true):
   - Detect non-root user (for Claude's install.sh which runs as user)
   - `curl -fsSL https://claude.ai/install.sh | su - $USERNAME -c bash`
   - Add to PATH
4. **Install npm packages** (global):
   - `npm install -g @generacy-ai/generacy@${VERSION}`
   - If `$INSTALLAGENCY` is true: `npm install -g @generacy-ai/agency@${VERSION}`
5. **Verify installations** — check that `generacy`, `agency`, `claude`, `gh` are all available

Important:
- Must work with any base image (Debian/Ubuntu-based is standard for devcontainers)
- Use `#!/bin/sh` and `set -e` per feature convention
- Options are available as capitalized env vars: `$VERSION`, `$INSTALLAGENCY`, `$INSTALLCLAUDECODE`, `$NODEVERSION`
- Handle both root and non-root execution contexts

## GitHub Action for Publishing

Add a workflow at `.github/workflows/publish-devcontainer-feature.yml`:

```yaml
name: Publish Dev Container Feature

on:
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
      - name: Publish Features
        uses: devcontainers/action@v1
        with:
          publish-features: true
          base-path-to-features: packages/devcontainer-feature/src
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Published to: `ghcr.io/generacy-ai/generacy/generacy:<version>`

After publishing, mark the GHCR package as public in package settings.

## Testing

Use the [devcontainer CLI](https://github.com/devcontainers/cli) for testing:

```bash
# Test with Python base
devcontainer features test \
  --features generacy \
  --base-image mcr.microsoft.com/devcontainers/python:3.12
```

`test/generacy/test.sh` should verify:
- `node --version` succeeds
- `gh --version` succeeds
- `claude --version` succeeds
- `generacy --version` succeeds
- `agency --version` succeeds (if installAgency is true)

## Future: Public Index

After the feature is stable, submit a PR to [devcontainers/devcontainers.github.io](https://github.com/devcontainers/devcontainers.github.io) to add it to `collection-index.yml` for discoverability in VS Code and GitHub Codespaces.

## Acceptance Criteria

- [ ] Feature source files exist at `packages/devcontainer-feature/src/generacy/`
- [ ] `install.sh` handles Node.js, GitHub CLI, Claude Code, and npm package installation
- [ ] All options work correctly (version, installAgency, installClaudeCode, nodeVersion)
- [ ] Feature installs successfully on a clean Python base image
- [ ] Feature installs successfully on a clean Ubuntu base image
- [ ] GitHub Action workflow publishes to GHCR
- [ ] README documents usage and options

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
