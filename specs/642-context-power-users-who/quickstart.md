# Quickstart: `generacy registry-login` / `registry-logout`

## Prerequisites

- Node.js >= 22
- Docker installed and running
- A Generacy cluster initialized (`.generacy/` directory exists)

## Usage

### Authenticate with a Private Registry

```bash
cd ~/Generacy/my-project
generacy registry-login ghcr.io
```

You'll be prompted for:
1. **Username** — your registry username (e.g., GitHub username)
2. **Token** — your registry token/password (input is hidden)

Output:
```
✓ Registry credentials saved for ghcr.io
✓ Forwarded to running cluster
```

### Pull Images After Login

All compose-invoking commands (`up`, `update`, `pull`) automatically detect the scoped config:

```bash
generacy update   # pulls private image, recreates containers
generacy up       # starts cluster with private image
```

### Remove Registry Credentials

```bash
generacy registry-logout ghcr.io
```

Output:
```
✓ Removed registry credentials for ghcr.io
✓ Removed from running cluster
```

### Offline Usage (Cluster Not Running)

If the cluster is stopped, only the local scoped config is written/removed. The next `generacy up` will use it automatically:

```bash
generacy registry-login ghcr.io
# ✓ Registry credentials saved for ghcr.io
# ⚠ Cluster is not running — credentials will be used on next start
```

## How It Works

- Credentials are stored at `<projectDir>/.generacy/.docker/config.json`
- `~/.docker/config.json` is **never** modified
- The CLI sets `DOCKER_CONFIG` when spawning `docker compose` commands
- If the cluster is running, credentials are also forwarded to the control-plane for container-side access

## Machine-Wide Auth

For machine-wide registry credentials (shared across all projects), use Docker directly:

```bash
docker login ghcr.io
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "No Generacy cluster found" | Run from project directory or use `generacy init` first |
| Cluster forward fails | Ensure cluster is running with `generacy status` |
| Pull still fails after login | Verify token permissions for the registry/org |
| Wrong credentials | Run `registry-logout` then `registry-login` again |

## Available Commands

```
generacy registry-login <host>    Authenticate with a private container registry
generacy registry-logout <host>   Remove registry credentials for this project
```
