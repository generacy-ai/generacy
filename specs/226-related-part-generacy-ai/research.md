# Research: Dev Container Feature Implementation

## Dev Container Feature Specification

### How Features Work

A [Dev Container Feature](https://containers.dev/implementors/features/) is a self-contained unit distributed as an OCI artifact. At container build time, the devcontainer CLI:

1. Pulls the OCI artifact from a registry (e.g., GHCR)
2. Extracts `devcontainer-feature.json` (metadata + options)
3. Runs `install.sh` inside the container with options as environment variables
4. Option names are uppercased: `nodeVersion` → `$NODEVERSION`

### Publishing with `devcontainers/action@v1`

The [devcontainers/action](https://github.com/devcontainers/action) GitHub Action:
- Reads `devcontainer-feature.json` from the `base-path-to-features` directory
- Uses the `version` field in the JSON to tag the OCI artifact
- Publishes to GHCR at `ghcr.io/<org>/<repo>/<feature-id>:<version>`
- The git tag is only a workflow trigger — the action ignores it for versioning

### Install Script Conventions

Per the [authoring guide](https://containers.dev/guide/author-a-feature):
- Must use `#!/bin/sh` (not bash — some base images lack bash)
- Must use `set -e` for fail-fast
- Options are injected as uppercase environment variables
- `$_REMOTE_USER` is set by the devcontainer spec (the user who will use the container)
- Scripts run as root during build

### Non-Root User Detection

The standard pattern used by official features (e.g., `common-utils`):
```sh
# $_REMOTE_USER is set by devcontainer spec
USERNAME="${_REMOTE_USER:-""}"
if [ -z "$USERNAME" ] || [ "$USERNAME" = "root" ]; then
    USERNAME=$(awk -F: '$3 >= 1000 && $3 < 65534 { print $1; exit }' /etc/passwd)
fi
if [ -z "$USERNAME" ]; then
    USERNAME=root
fi
```

This finds the first non-root, non-system user with UID >= 1000 (skipping `nobody` at 65534).

## Existing Infrastructure Comparison

### Current Dockerfile Approach (tetrad-development)

The existing Dockerfile installs Claude Code via:
```dockerfile
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root
```

This requires a `USER` directive which devcontainer features don't have. The feature will use `npm install -g @anthropic-ai/claude-code` instead (per Q2 resolution).

### GitHub CLI Installation

The existing Dockerfile uses apt repository setup:
```dockerfile
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh
```

The feature will use the same apt approach for GitHub CLI (standard for Debian/Ubuntu-based containers).

### Node.js Installation

The existing Dockerfile uses `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm` as base (Node pre-installed). The feature targets arbitrary base images and must install Node.js if not present, using NodeSource:
```sh
curl -fsSL https://deb.nodesource.com/setup_${NODEVERSION}.x | bash -
apt-get install -y nodejs
```

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Claude Code install method | `npm install -g` | Deterministic, no user-switching, consistent with other packages |
| Node.js detection | Skip if any `node` on PATH | Standard feature pattern; composable with official Node feature |
| GitHub CLI detection | Skip if any `gh` on PATH | No minimum version needed |
| Agency version | Separate `agencyVersion` option | Independent release cycles |
| Error handling | Fail-fast (`set -e`) | Loud failures > silent failures |
| Non-root user fallback | UID >= 1000 | Standard pattern from official features |

## Test Infrastructure

The `devcontainer features test` CLI:
- Reads `test/<feature-id>/test.sh` for default scenario
- Reads `test/<feature-id>/scenarios.json` for additional scenarios
- Each scenario specifies options and optionally a different base image
- Test scripts should use `check` helper function or exit codes

### scenarios.json Format
```json
{
  "scenario-name": {
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
    "features": {
      "generacy": {
        "version": "latest",
        "installAgency": false
      }
    }
  }
}
```
