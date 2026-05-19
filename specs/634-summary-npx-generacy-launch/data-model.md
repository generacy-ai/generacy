# Data Model: Sync launch scaffolder docker-compose with cluster-base

**Feature**: #634 | **Date**: 2026-05-16

## Docker Compose YAML Shape (after fix)

### tmpfs mounts (shared by orchestrator + worker)

```yaml
tmpfs:
  - /run/generacy-credhelper:uid=1002
  - /run/generacy-control-plane:uid=1000
  - /run/generacy-app-config:mode=1750,uid=1000,gid=1000   # NEW
```

### Orchestrator volumes

```yaml
volumes:
  - workspace:/workspaces
  - <claude-config-mount>
  - shared-packages:/shared-packages
  - npm-cache:/home/node/.npm
  - generacy-data:/var/lib/generacy
  - /var/run/docker.sock:/var/run/docker-host.sock
  - vscode-cli-state:/home/node/.vscode/cli
  - generacy-app-config-data:/var/lib/generacy-app-config   # NEW
```

### Worker volumes

```yaml
volumes:
  - workspace:/workspaces
  - <claude-config-mount>
  - shared-packages:/shared-packages
  - npm-cache:/home/node/.npm
  - generacy-data:/var/lib/generacy
  - generacy-app-config-data:/var/lib/generacy-app-config:ro  # NEW (read-only)
```

### Top-level volume declarations

```yaml
volumes:
  workspace:
  shared-packages:
  npm-cache:
  generacy-data:
  vscode-cli-state:
  redis-data:
  generacy-app-config-data:   # NEW
  # claude-config: (conditional)
```

## Path Contracts

| Path | Type | Service | Access | Consumer |
|------|------|---------|--------|----------|
| `/run/generacy-app-config` | tmpfs | both | rw | `AppConfigEnvStore` secrets.env rendering |
| `/var/lib/generacy-app-config` | named volume | orchestrator | rw | `AppConfigEnvStore`, `AppConfigFileStore` |
| `/var/lib/generacy-app-config` | named volume | worker | ro | `AppConfigEnvStore` (read-only env resolution) |

## Validation

No Zod schema changes. The compose object is a `Record<string, unknown>` serialized via `yaml.stringify()`. Validation is done via unit tests asserting the presence of specific entries in the parsed output.
