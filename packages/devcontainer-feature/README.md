# Generacy Dev Container Feature

A [Dev Container Feature](https://containers.dev/implementors/features/) that installs Generacy AI development tooling into any dev container. Add one line to your `devcontainer.json` and get everything you need.

## Quick Start

Add the feature to your `devcontainer.json`:

```json
{
  "image": "mcr.microsoft.com/devcontainers/python:3.12",
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:1": {}
  }
}
```

Rebuild your container. That's it.

## What Gets Installed

| Tool | Condition | How |
|------|-----------|-----|
| **Node.js** | If `node` is not already on PATH | [NodeSource](https://deb.nodesource.com/) (version controlled by `nodeVersion`) |
| **GitHub CLI** | If `gh` is not already on PATH | [GitHub apt repository](https://cli.github.com/packages) |
| **Claude Code** | If `installClaudeCode` is `true` (default) | `npm install -g @anthropic-ai/claude-code` |
| **@generacy-ai/generacy** | Always | `npm install -g @generacy-ai/generacy` |
| **@generacy-ai/agency** | If `installAgency` is `true` (default) | `npm install -g @generacy-ai/agency` |

Node.js and GitHub CLI are skipped if they're already present in the base image (any version). This makes the feature composable with other features that may install these tools.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `version` | string | `"latest"` | Version of `@generacy-ai/generacy` to install |
| `agencyVersion` | string | `"latest"` | Version of `@generacy-ai/agency` to install |
| `installAgency` | boolean | `true` | Install the `@generacy-ai/agency` MCP server |
| `installClaudeCode` | boolean | `true` | Install Claude Code AI agent |
| `nodeVersion` | string | `"22"` | Node.js major version to install if Node.js is not already present |

## Examples

### All defaults

Installs everything with latest versions:

```json
{
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:1": {}
  }
}
```

### Pin specific versions

```json
{
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:1": {
      "version": "0.1.0",
      "agencyVersion": "0.0.1"
    }
  }
}
```

### Without Claude Code

```json
{
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:1": {
      "installClaudeCode": false
    }
  }
}
```

### Without Agency

```json
{
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:1": {
      "installAgency": false
    }
  }
}
```

### Use Node.js 20

```json
{
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy:1": {
      "nodeVersion": "20"
    }
  }
}
```

## Interaction with Other Features

This feature declares `installsAfter` for `ghcr.io/devcontainers/features/common-utils` and `ghcr.io/devcontainers/features/node`. If your `devcontainer.json` includes the official Node feature, it will install first, and this feature will detect the existing Node.js installation and skip its own Node.js install step.

```json
{
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "20" },
    "ghcr.io/generacy-ai/generacy/generacy:1": {}
  }
}
```

## Supported Base Images

The install script targets **Debian/Ubuntu-based** dev container images, which is the standard for most official dev container images. This includes:

- `mcr.microsoft.com/devcontainers/python`
- `mcr.microsoft.com/devcontainers/base:ubuntu`
- `mcr.microsoft.com/devcontainers/typescript-node`
- Other Debian/Ubuntu-based images

Alpine, RHEL, and other non-Debian distributions are not currently supported.

## Publishing

The feature is published to GitHub Container Registry (GHCR) as an OCI artifact via GitHub Actions.

### How to publish

Push a tag matching `feature/v*`:

```bash
git tag feature/v0.1.0
git push origin feature/v0.1.0
```

The [publish workflow](../../.github/workflows/publish-devcontainer-feature.yml) runs automatically and publishes to `ghcr.io/generacy-ai/generacy/generacy:<version>`.

### First-time setup

After the first publish, the GHCR package defaults to private. Go to the package settings on GitHub and mark it as **public** so that external dev containers can pull it.

## Testing

Tests use the [Dev Container CLI](https://github.com/devcontainers/cli).

### Run all tests

```bash
devcontainer features test \
  --features generacy \
  --base-image mcr.microsoft.com/devcontainers/python:3.12 \
  --project-folder packages/devcontainer-feature
```

### Test scenarios

| Scenario | Base Image | Options | Validates |
|----------|-----------|---------|-----------|
| `defaults_python` | Python 3.12 | All defaults | All tools installed |
| `defaults_ubuntu` | Ubuntu base | All defaults | All tools installed |
| `all_disabled` | Python 3.12 | Agency + Claude Code off | Only core tools present |
| `no_claude_code` | Python 3.12 | Claude Code off | Claude Code absent |
| `no_agency` | Python 3.12 | Agency off | Agency absent |
| `node_20` | Python 3.12 | Node.js 20 | Correct Node.js version |

## Directory Structure

```
packages/devcontainer-feature/
├── src/
│   └── generacy/
│       ├── devcontainer-feature.json   # Feature metadata and options
│       └── install.sh                  # POSIX install script (runs as root)
├── test/
│   └── generacy/
│       ├── test.sh                     # Default scenario test
│       ├── scenarios.json              # Test scenario definitions
│       ├── defaults_python.sh          # Python base image test
│       ├── defaults_ubuntu.sh          # Ubuntu base image test
│       ├── all_disabled.sh             # Disabled components test
│       ├── no_claude_code.sh           # No Claude Code test
│       ├── no_agency.sh                # No Agency test
│       └── node_20.sh                  # Node.js 20 test
└── README.md
```
