# Data Model: Wire scoped docker-socket-proxy into ExposureRenderer

## Modified Types

### SessionState (types.ts) — Add scratch directory

```typescript
/** Tracks an active credential session. */
export interface SessionState {
  sessionId: string;
  roleId: string;
  sessionDir: string;
  /** Per-session scratch directory for bind mounts */
  scratchDir?: string;
  expiresAt: Date;
  createdAt: Date;
  dataServer: http.Server;
  dataSocketPath: string;
  credentialIds: string[];
  dockerProxy?: DockerProxyHandle;
}
```

### DockerProxyHandlerOptions (docker-proxy-handler.ts) — Add scratch dir

```typescript
export interface DockerProxyHandlerOptions {
  rules: DockerRule[];
  upstreamSocket: string;
  upstreamIsHost: boolean;
  nameResolver: ContainerNameResolver;
  /** Scratch directory path for bind-mount validation (host-socket only) */
  scratchDir?: string;
}
```

### DockerProxyConfig (types.ts) — Add scratch dir

```typescript
export interface DockerProxyConfig {
  sessionId: string;
  sessionDir: string;
  rules: DockerRule[];
  upstreamSocket: string;
  upstreamIsHost: boolean;
  /** Scratch directory for bind-mount guard (only used when upstreamIsHost=true) */
  scratchDir?: string;
}
```

## New Types

### BindMountViolation (docker-bind-mount-guard.ts)

```typescript
/** Result of a bind-mount path validation check. */
export interface BindMountViolation {
  /** The source path that violates the scratch directory constraint */
  source: string;
  /** The resolved/canonicalized form of the source path */
  resolvedSource: string;
  /** Where in the request body this mount was found */
  field: 'Binds' | 'Mounts';
}
```

### BindMountValidationResult (docker-bind-mount-guard.ts)

```typescript
export interface BindMountValidationResult {
  valid: boolean;
  violations: BindMountViolation[];
}
```

### Docker API Request Body Types (docker-bind-mount-guard.ts)

These are partial types for the Docker Engine API request body — only the fields we inspect:

```typescript
/** Partial type for Docker HostConfig.Mounts entry */
export interface DockerMountEntry {
  Type: 'bind' | 'volume' | 'tmpfs' | 'npipe' | 'cluster';
  Source?: string;
  Target?: string;
  ReadOnly?: boolean;
}

/** Partial type for Docker container create request body */
export interface DockerCreateBody {
  HostConfig?: {
    /** Legacy format: "source:target[:options]" */
    Binds?: string[];
    /** Modern format: array of mount objects */
    Mounts?: DockerMountEntry[];
  };
}
```

## Validation Rules

### Bind-Mount Path Validation

1. **Extract sources** from both `HostConfig.Binds` (split on `:`, take first element) and `HostConfig.Mounts` (filter `Type === 'bind'`, take `Source`)
2. **Canonicalize** each source with `path.resolve(source)`
3. **Check containment**: resolved source must `startsWith(scratchDir + '/')` or equal `scratchDir`
4. **Fail closed**: If body cannot be parsed as JSON, reject the request
5. **Empty mounts**: No `Binds` or `Mounts` field = valid (no bind mounts to check)

### Scratch Directory Constraints

| Property | Value |
|----------|-------|
| Base path | `/var/lib/generacy/scratch/` |
| Session path | `/var/lib/generacy/scratch/<sessionId>/` |
| Permissions | `0700` |
| Owner | `uid: 1001` (workflow user) |
| Lifetime | Created at session begin, removed at session end |
| Env var | `GENERACY_SCRATCH_DIR` |

## Entity Relationships

```
DaemonConfig
  └── upstreamDockerSocket?: UpstreamDockerSocket
        ├── socketPath: string
        └── isHost: boolean

SessionState
  ├── dockerProxy?: DockerProxyHandle
  │     └── DockerProxy
  │           ├── DockerProxyConfig
  │           │     ├── rules: DockerRule[]
  │           │     ├── upstreamSocket
  │           │     ├── upstreamIsHost
  │           │     └── scratchDir? (NEW)
  │           ├── DockerAllowlistMatcher
  │           └── ContainerNameResolver
  └── scratchDir?: string (NEW)

DockerProxyHandler pipeline:
  1. Normalize path (strip version prefix)
  2. Reject follow=true on logs
  3. Match against allowlist (DockerAllowlistMatcher)
  4. Name resolution check (ContainerNameResolver)
  5. Bind-mount guard (NEW, host-socket only, POST /containers/create only)
  6. Forward to upstream
```

## Env Vars Added to Session

| Variable | Value | When Set |
|----------|-------|----------|
| `DOCKER_HOST` | `unix://<sessionDir>/docker.sock` | When role has `docker-socket-proxy` exposure (already exists) |
| `GENERACY_SCRATCH_DIR` | `/var/lib/generacy/scratch/<sessionId>/` | When role has `docker:` block (NEW) |
