# Implementation Plan: Dev Container Feature for Generacy

## Summary

Create a [Dev Container Feature](https://containers.dev/implementors/features/) at `packages/devcontainer-feature/` that allows external developers to add Generacy tooling to any dev container with a single line in their `devcontainer.json`. The feature installs Node.js (if needed), GitHub CLI (if needed), Claude Code, `@generacy-ai/generacy`, and `@generacy-ai/agency` as global npm packages. A GitHub Actions workflow publishes the feature as an OCI artifact to GHCR.

## Technical Context

- **Language**: Shell script (`/bin/sh` — POSIX-compatible, no bash)
- **Distribution**: OCI artifact on GitHub Container Registry (GHCR)
- **Tooling**: `devcontainers/action@v1` for publishing, `devcontainer features test` for testing
- **Target platforms**: Debian/Ubuntu-based dev container images (standard for devcontainers)
- **Dependencies**: None beyond what the install script installs

## Architecture Overview

```
packages/devcontainer-feature/
├── src/
│   └── generacy/
│       ├── devcontainer-feature.json   # Feature metadata + options
│       └── install.sh                  # POSIX install script (runs as root)
├── test/
│   └── generacy/
│       ├── test.sh                     # Default scenario test
│       └── scenarios.json              # Additional test scenarios
└── README.md                           # Usage documentation

.github/
└── workflows/
    └── publish-devcontainer-feature.yml # Publish to GHCR on tag
```

The feature is self-contained — no TypeScript, no build step, no workspace dependencies. It does not need to be included in the pnpm workspace since it's purely shell scripts and JSON.

## Implementation Phases

### Phase 1: Feature Metadata (`devcontainer-feature.json`)

**File**: `packages/devcontainer-feature/src/generacy/devcontainer-feature.json`

Create the feature metadata with these options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `version` | string | `"latest"` | Version of `@generacy-ai/generacy` to install |
| `agencyVersion` | string | `"latest"` | Version of `@generacy-ai/agency` to install |
| `installAgency` | boolean | `true` | Install `@generacy-ai/agency` MCP server |
| `installClaudeCode` | boolean | `true` | Install `@anthropic-ai/claude-code` |
| `nodeVersion` | string | `"22"` | Node.js major version (skipped if Node already present) |

Key fields:
- `id`: `"generacy"`
- `version`: `"0.1.0"`
- `installsAfter`: `["ghcr.io/devcontainers/features/common-utils", "ghcr.io/devcontainers/features/node"]`

**Changes from spec**: Added `agencyVersion` option (per Q1 resolution — agency has independent release cycle at v0.0.0 vs generacy at v0.1.0).

### Phase 2: Install Script (`install.sh`)

**File**: `packages/devcontainer-feature/src/generacy/install.sh`

The script runs as root during container build. Structure:

```
#!/bin/sh
set -e

# 1. Resolve non-root username
# 2. Install Node.js (if not present)
# 3. Install GitHub CLI (if not present)
# 4. Install Claude Code (if enabled)
# 5. Install @generacy-ai/generacy
# 6. Install @generacy-ai/agency (if enabled)
# 7. Verify installations
```

#### Step 1: Resolve Non-Root Username

Uses `$_REMOTE_USER` (set by devcontainer spec), falling back to first user with UID >= 1000 in `/etc/passwd`, then root.

```sh
USERNAME="${_REMOTE_USER:-""}"
if [ -z "$USERNAME" ] || [ "$USERNAME" = "root" ]; then
    USERNAME=$(awk -F: '$3 >= 1000 && $3 < 65534 { print $1; exit }' /etc/passwd)
fi
if [ -z "$USERNAME" ]; then
    USERNAME=root
fi
```

#### Step 2: Install Node.js (conditional)

Skip if `node` is found on PATH (any version — per Q3 resolution). Otherwise, install from NodeSource using `$NODEVERSION`:

```sh
if ! command -v node > /dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODEVERSION}.x" | bash -
    apt-get install -y nodejs
fi
```

#### Step 3: Install GitHub CLI (conditional)

Skip if `gh` is found on PATH (any version — per Q4 resolution). Otherwise, install from GitHub's apt repository:

```sh
if ! command -v gh > /dev/null 2>&1; then
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    apt-get update
    apt-get install -y gh
fi
```

#### Step 4: Install Claude Code (conditional)

Only if `$INSTALLCLAUDECODE` is `"true"` (per Q2 resolution — npm install, not curl script):

```sh
if [ "$INSTALLCLAUDECODE" = "true" ]; then
    npm install -g @anthropic-ai/claude-code
fi
```

#### Step 5: Install Generacy

```sh
npm install -g "@generacy-ai/generacy@${VERSION}"
```

#### Step 6: Install Agency (conditional)

Only if `$INSTALLAGENCY` is `"true"`:

```sh
if [ "$INSTALLAGENCY" = "true" ]; then
    npm install -g "@generacy-ai/agency@${AGENCYVERSION}"
fi
```

#### Step 7: Verify Installations

Check that all expected binaries are available:

```sh
echo "Verifying installations..."
node --version
gh --version
generacy --version
if [ "$INSTALLCLAUDECODE" = "true" ]; then
    claude --version
fi
if [ "$INSTALLAGENCY" = "true" ]; then
    agency --version
fi
echo "Generacy dev container feature installed successfully."
```

### Phase 3: Test Suite

#### `test/generacy/test.sh` (default scenario)

Tests the default configuration (all options enabled):

```sh
#!/bin/sh
set -e

# Verify Node.js
node --version

# Verify GitHub CLI
gh --version

# Verify Claude Code
claude --version

# Verify Generacy
generacy --version

# Verify Agency
agency --version

echo "All default tests passed."
```

#### `test/generacy/scenarios.json`

Six test scenarios per Q11 resolution:

| Scenario | Base Image | Key Options |
|----------|-----------|-------------|
| `defaults_python` | Python 3.12 | All defaults |
| `defaults_ubuntu` | Ubuntu base | All defaults |
| `all_disabled` | Python 3.12 | `installAgency: false`, `installClaudeCode: false` |
| `no_claude_code` | Python 3.12 | `installClaudeCode: false` |
| `no_agency` | Python 3.12 | `installAgency: false` |
| `node_20` | Python 3.12 | `nodeVersion: "20"` |

Each scenario has a corresponding test assertion. The `all_disabled` scenario verifies that `generacy` and `gh` are present but `claude` and `agency` are not installed.

### Phase 4: GitHub Actions Workflow

**File**: `.github/workflows/publish-devcontainer-feature.yml`

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

Triggered by tags like `feature/v0.1.0`. The `devcontainers/action@v1` reads the version from `devcontainer-feature.json` (per Q10 resolution — tag is just a trigger).

Published to: `ghcr.io/generacy-ai/generacy/generacy:0.1.0`

### Phase 5: Documentation (README.md)

**File**: `packages/devcontainer-feature/README.md`

Contents:
1. **Quick Start** — minimal `devcontainer.json` example
2. **Options** — table of all options with types, defaults, descriptions
3. **What Gets Installed** — list of tools and conditions
4. **Examples** — common configurations (minimal, custom versions, disabled components)
5. **Interaction with Other Features** — note about `installsAfter` and the official Node feature
6. **Publishing** — how to trigger a publish (tag format, GHCR package visibility)
7. **Testing** — how to run tests locally with `devcontainer features test`

## Key Technical Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Claude Code install | `npm install -g @anthropic-ai/claude-code` | Deterministic, no user-switching complexity, consistent with other packages (Q2) |
| 2 | Agency versioning | Separate `agencyVersion` option | Independent repos and release cycles — `agency@0.0.0` vs `generacy@0.1.0` (Q1) |
| 3 | Node.js detection | Skip if any `node` on PATH | Standard composable feature pattern; version enforcement is user's responsibility (Q3) |
| 4 | Error handling | `set -e` fail-fast for everything | Users can disable optional components via options rather than silently failing (Q7) |
| 5 | Non-root user fallback | UID >= 1000 threshold | Matches `common-utils` pattern, skips system accounts (Q9) |
| 6 | Shell | `/bin/sh` (POSIX) | Required by devcontainer feature spec — not all base images have bash |
| 7 | Workspace inclusion | Excluded from pnpm workspace | No TypeScript, no build step, no npm dependencies — purely shell + JSON |

## Files to Create

| # | File | Description |
|---|------|-------------|
| 1 | `packages/devcontainer-feature/src/generacy/devcontainer-feature.json` | Feature metadata and options |
| 2 | `packages/devcontainer-feature/src/generacy/install.sh` | POSIX install script |
| 3 | `packages/devcontainer-feature/test/generacy/test.sh` | Default test scenario |
| 4 | `packages/devcontainer-feature/test/generacy/scenarios.json` | Additional test scenarios |
| 5 | `packages/devcontainer-feature/README.md` | Usage documentation |
| 6 | `.github/workflows/publish-devcontainer-feature.yml` | GHCR publish workflow |

## Files to Modify

None. This is a net-new package with no changes to existing files.

The `pnpm-workspace.yaml` does not need modification — `packages/*` already covers `packages/devcontainer-feature`, and since this package has no `package.json`, pnpm will ignore it naturally.

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| npm packages not yet published publicly | Documented as prerequisite. Feature will fail loudly at install time if packages aren't on npm (Q8: "not yet public, will be") |
| NodeSource repository changes | Well-established, used by millions. Fallback: official Node feature via `installsAfter` |
| GitHub CLI apt repo unavailable at build time | Transient — container rebuild will succeed. Fail-fast is preferable to silent skip |
| `devcontainers/action@v1` breaking changes | Pin to `@v1`. Monitor devcontainers/action releases |
| GHCR package private by default | Documented one-time manual step to mark as public (Q6) |
| Feature tested only on Debian/Ubuntu | Standard for devcontainers. Document this limitation in README |

## Acceptance Criteria Mapping

| Criterion | Phase |
|-----------|-------|
| Feature source files at `packages/devcontainer-feature/src/generacy/` | Phase 1-2 |
| `install.sh` handles Node.js, GitHub CLI, Claude Code, npm packages | Phase 2 |
| All options work correctly | Phase 2-3 |
| Feature installs on clean Python base image | Phase 3 (test scenario) |
| Feature installs on clean Ubuntu base image | Phase 3 (test scenario) |
| GitHub Action workflow publishes to GHCR | Phase 4 |
| README documents usage and options | Phase 5 |

## Supporting Artifacts

- [research.md](./research.md) — Technical research on devcontainer feature authoring, install conventions, and comparison with existing Dockerfile approach
