# Quickstart: CLI claude-login and open commands

**Feature**: #496 | **Date**: 2026-04-29

## Prerequisites

- A Generacy cluster initialized in the current directory (`generacy init` completed)
- Docker running with the cluster started (`generacy up`)
- The `.generacy/cluster.json` file present in the project directory

## Commands

### `generacy claude-login`

Authenticate Claude Max inside the orchestrator container.

```bash
# From your project directory (must contain .generacy/)
generacy claude-login
```

**What happens**:
1. Resolves the cluster from your current directory
2. Runs `claude /login` inside the orchestrator container
3. On macOS/Windows: auto-opens the authentication URL in your browser
4. On Linux: prints the URL for you to open manually
5. Follow the prompts in your terminal to complete authentication

**Example output** (Linux):
```
Open this URL in your browser:
https://claude.ai/oauth/authorize?code=abc123...

Waiting for authentication...
Successfully authenticated!
```

### `generacy open`

Open the cluster's project page on generacy.ai.

```bash
# From your project directory
generacy open

# Or specify a cluster explicitly
generacy open --cluster my-cluster-id
```

**What happens**:
1. Resolves the cluster from cwd (or `--cluster` flag)
2. Opens `{cloudUrl}/clusters/{clusterId}` in your default browser

## Error Messages

| Error | Cause | Fix |
|-------|-------|-----|
| `No Generacy cluster found in /path or any parent directory` | No `.generacy/` directory in cwd ancestry | `cd` to your project directory or run `generacy init` |
| `Cluster configuration is corrupted` | `.generacy/cluster.json` is missing or invalid | Re-run `generacy init` |
| `Cluster 'xyz' not found in registry` | `--cluster` ID doesn't match any known cluster | Run `generacy status` to list clusters |
| `Cluster 'xyz' is not running` | Docker containers are stopped | Run `generacy up` to start the cluster |
| `Docker is not running` | Docker daemon isn't accessible | Start Docker Desktop or the Docker daemon |

## Troubleshooting

**Q: `claude-login` shows garbled output / no colors**
A: This is expected. stdout is piped for URL detection, which strips TTY escape codes. The authentication flow still works correctly.

**Q: Browser doesn't open on macOS**
A: Ensure you have a default browser set. The command uses the system `open` command. Try running `open https://example.com` manually to verify.

**Q: `claude-login` hangs after printing the URL**
A: The command is waiting for you to complete authentication in your browser. Open the URL, authenticate, then return to the terminal.
