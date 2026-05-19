# Research: Concurrent Local Clusters

## Docker Compose Port Syntax

### Ephemeral (random) host port
```yaml
ports:
  - "3100"  # Expose container port 3100 on a random host port
```
Docker picks an available host port at `docker compose up` time. The actual port is queryable via `docker compose ps` or `docker port`.

### Fixed host:container binding
```yaml
ports:
  - "3100:3100"  # Map host port 3100 to container port 3100
```
Fails with `bind: address already in use` if another process or container already occupies host port 3100.

### Decision
**Ephemeral for local, fixed for cloud.** Ephemeral eliminates collision risk entirely. Fixed ports on remote VMs aid firewall/security-group configuration.

## Docker Compose `ps --format json` Output

`docker compose ps --format json` emits one NDJSON object per container. Relevant fields:

```json
{
  "Name": "generacy-cluster-abc123",
  "Service": "cluster",
  "State": "running",
  "Status": "Up 5 minutes",
  "Publishers": [
    {
      "URL": "0.0.0.0",
      "TargetPort": 3100,
      "PublishedPort": 49201,
      "Protocol": "tcp"
    }
  ]
}
```

- `Publishers` is an array — may be empty if no ports are published
- `TargetPort` is the container-side port
- `PublishedPort` is the Docker-assigned host port
- When using ephemeral ports, `PublishedPort` is the random port Docker chose

### Parsing strategy
Filter `Publishers` for `TargetPort === 3100`, take `PublishedPort`. If not found, display `N/A`.

## Alternatives Considered

### Deterministic port offsets
Assign each cluster a port offset (e.g., cluster N uses `3100 + N*10`). Requires a slot counter mechanism, adds state, and still has collision risk if clusters are created/destroyed out of order. Rejected in favor of ephemeral.

### Hybrid (ephemeral + `--port-base`)
Ephemeral by default with an opt-in `--port-base` flag for users who want predictable ports. Good idea but deferred — adds complexity for an unproven need. Can be layered on later.

### Auto-migration of compose files
Rewrite existing `docker-compose.yml` on `generacy up` to replace hardcoded ports. Rejected — too aggressive for a pre-`@latest` release. Warning + manual migration is safer.

## Implementation Patterns

### Compose file reading for legacy detection
The `up` command already has access to `ctx.composePath`. Reading and parsing the YAML to check port format is a simple, side-effect-free operation. The `yaml` package is already a dependency.

### Port display in status
The existing `getClusterServices()` function in `status/index.ts` already parses `docker compose ps --format json`. Extending it to extract `Publishers` is additive — no breaking changes to the current parsing logic.

## Key References

- Docker Compose port specification: https://docs.docker.com/reference/compose-file/services/#ports
- Docker Compose ps format: https://docs.docker.com/reference/cli/docker/compose/ps/
- Current scaffolder: `packages/generacy/src/cli/commands/cluster/scaffolder.ts`
- Current status command: `packages/generacy/src/cli/commands/status/index.ts`
