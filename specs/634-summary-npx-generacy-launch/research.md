# Research: Sync launch scaffolder docker-compose with cluster-base

**Feature**: #634 | **Date**: 2026-05-16

## Technology Decisions

### Docker Compose tmpfs format

The tmpfs mount uses the string format `path:option1=val1,option2=val2`. The app-config tmpfs requires:
- `mode=1750` — owner rwx, group r-x, other none
- `uid=1000` — node user (matches container user)
- `gid=1000` — node group

This matches existing tmpfs entries (credhelper uses `uid=1002`, control-plane uses `uid=1000`).

### Volume mount format

Docker Compose volume mounts use `name:path[:options]`:
- Orchestrator: `generacy-app-config-data:/var/lib/generacy-app-config` (rw, default)
- Worker: `generacy-app-config-data:/var/lib/generacy-app-config:ro` (read-only)

The `:ro` suffix on worker prevents accidental writes from worker processes. Only orchestrator (running control-plane) should write app-config data.

### Worker volume strategy

Current code has orchestrator volumes as a named array (`orchestratorVolumes = [...sharedVolumes, ...]`) but worker uses `sharedVolumes` directly. Rather than creating a `workerVolumes` array (which the spec's assumptions section suggested), we inline the extra volume at the worker service definition to minimize diff:

```typescript
volumes: [...sharedVolumes, 'generacy-app-config-data:/var/lib/generacy-app-config:ro'],
```

This is consistent with the existing pattern where orchestrator-specific volumes are grouped in `orchestratorVolumes` but worker differences are small enough to inline.

## Alternatives Considered

### Alternative: Extract workerVolumes array

```typescript
const workerVolumes = [
  ...sharedVolumes,
  'generacy-app-config-data:/var/lib/generacy-app-config:ro',
];
```

**Rejected because**: Adds an extra named binding for a single additional volume. If more worker-specific volumes accumulate, this can be refactored then.

### Alternative: Add app-config to sharedVolumes

Adding `generacy-app-config-data:/var/lib/generacy-app-config` to `sharedVolumes` would give both services rw access.

**Rejected because**: Workers should only have read-only access. The canonical cluster-base compose uses `:ro` on workers.

## Key Sources

- Canonical compose: `cluster-base/.devcontainer/generacy/docker-compose.yml` (cluster-base#38)
- Control-plane consumers: `packages/control-plane/src/services/app-config-env-store.ts`, `app-config-file-store.ts`
- Scaffolder: `packages/generacy/src/cli/commands/cluster/scaffolder.ts:117-264`
