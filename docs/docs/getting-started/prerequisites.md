---
sidebar_position: 1
---

# Prerequisites

Before installing Generacy, make sure your system meets the following requirements and you have the necessary accounts set up.

## System Requirements

| Requirement | Minimum | Recommended | Notes |
|-------------|---------|-------------|-------|
| **Node.js** | 18.x | 20.x LTS | Required for the Generacy CLI |
| **npm** | 9.x | 10.x | Comes with Node.js |
| **Git** | 2.x | Latest | Must be initialized in your project (`git init`) |
| **Docker Desktop** | — | Latest | Optional for Level 1; required for Levels 2+ |
| **RAM** | 4 GB | 8 GB | Higher for running Docker containers |
| **Disk Space** | 500 MB | 1 GB | For CLI, dependencies, and project files |

### Verify Your Versions

```bash
node --version    # Should print v18.x or higher
npm --version     # Should print 9.x or higher
git --version     # Should print 2.x or higher
```

## OS-Specific Notes

### macOS

- Install Node.js via [Homebrew](https://brew.sh/): `brew install node`
- Docker Desktop for Mac is available at [docker.com](https://www.docker.com/products/docker-desktop/)
- Xcode Command Line Tools provides Git: `xcode-select --install`

### Linux

- Install Node.js via your package manager or [NodeSource](https://github.com/nodesource/distributions)
- Docker Engine works as an alternative to Docker Desktop — see [Docker Engine install docs](https://docs.docker.com/engine/install/)
- Git is typically pre-installed; if not: `sudo apt-get install git` (Debian/Ubuntu) or `sudo dnf install git` (Fedora)

### Windows (WSL2)

- **WSL2 is required.** Generacy does not support native Windows.
- Install WSL2 following the [Microsoft docs](https://learn.microsoft.com/en-us/windows/wsl/install)
- Install Node.js inside WSL2 (not on Windows host)
- Docker Desktop for Windows with WSL2 backend is recommended

## Required Accounts

You'll need these accounts to use Generacy:

| Account | Purpose | Where to Sign Up |
|---------|---------|-----------------|
| **GitHub** | Repository access, token-based authentication | [github.com](https://github.com/) |
| **Anthropic** | API key for AI agent capabilities | [console.anthropic.com](https://console.anthropic.com/) |

You'll set up credentials for these accounts in the [Authentication](./authentication.md) step.

## Optional Tools

These are not required but improve the development experience:

- **[VS Code](https://code.visualstudio.com/)** — recommended editor with Generacy extension support
- **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** — required for Level 2+ adoption; optional for Level 1
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** or another MCP-compatible AI assistant — needed when you reach the [First Workflow](./first-workflow.md) step

## Next Steps

Once you've confirmed your system meets the requirements, proceed to [Installation](./installation.md) to install the Generacy CLI.
