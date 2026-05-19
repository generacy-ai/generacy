# Quickstart: CLI Cluster Lifecycle Commands (#494)

## Prerequisites

- Docker with Compose v2 installed
- Existing `.generacy/` directory (created by `generacy init` + `generacy launch`)
- Node.js >= 20

## Commands

### Start a cluster

```bash
cd my-project
generacy up
```

Runs `docker compose up -d` against `.generacy/docker-compose.yml`. Auto-registers the cluster in `~/.generacy/clusters.json` and updates `lastSeen`.

### Check cluster status

```bash
# Table view (all registered clusters)
generacy status

# JSON output
generacy status --json
```

Shows all clusters from the registry with their current state (running/stopped/partial/missing).

### Stop a cluster

```bash
generacy stop
```

Stops containers without removing them. Allows quick restart with `generacy up`.

### Remove containers (keep volumes)

```bash
generacy down

# Also remove named volumes
generacy down --volumes
```

### Update images

```bash
generacy update
```

Pulls latest images and recreates only containers whose images changed.

### Destroy a cluster

```bash
# Interactive confirmation
generacy destroy

# Skip confirmation
generacy destroy --yes
```

Removes containers, volumes, the entire `.generacy/` directory, and the registry entry. Run `generacy init` + `generacy launch` to recreate.

## Common Workflows

### Daily development

```bash
generacy up        # Start of day
# ... work ...
generacy stop      # End of day (fast restart tomorrow)
```

### Clean restart

```bash
generacy down
generacy up
```

### Full reset

```bash
generacy destroy --yes
generacy init
generacy launch
generacy up
```

## Error Messages

| Error | Cause | Fix |
|-------|-------|-----|
| "Docker Compose is not installed" | `docker compose` not found | Install Docker Desktop or Compose plugin |
| "Docker daemon is not running" | Docker service stopped | Start Docker |
| "No cluster found" | No `.generacy/cluster.yaml` in path | Run `generacy init` first |
| "Compose file missing" | `.generacy/docker-compose.yml` absent | Run `generacy launch` to generate it |
| "Cluster not yet activated" | No `.generacy/cluster.json` | Warning only; commands still work with fallback project name |

## JSON Output Schema (status --json)

```json
[
  {
    "clusterId": "clst_abc123",
    "name": "my-project",
    "path": "/home/user/my-project",
    "variant": "standard",
    "channel": "stable",
    "state": "running",
    "services": [
      { "name": "orchestrator", "state": "running", "status": "Up 2 hours" },
      { "name": "relay", "state": "running", "status": "Up 2 hours" }
    ],
    "lastSeen": "2026-04-29T10:00:00.000Z",
    "createdAt": "2026-04-25T08:30:00.000Z"
  }
]
```

## Testing

```bash
# Run unit tests
cd packages/generacy
pnpm test

# Run only cluster lifecycle tests
pnpm test -- --grep "cluster"
```
