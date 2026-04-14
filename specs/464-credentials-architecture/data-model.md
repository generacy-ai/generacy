# Data Model: Scoped Docker Socket Proxy

## Existing Types (from `@generacy-ai/credhelper`)

These are defined in Phase 1 and used by the docker proxy.

### DockerRule

```typescript
// From packages/credhelper/src/schemas/roles.ts
interface DockerRule {
  method: string;       // HTTP method: GET, POST, DELETE, etc.
  path: string;         // Docker API path template: /containers/json, /containers/{id}/start
  name?: string;        // Optional glob pattern for container name filtering: firebase-*
}
```

### DockerConfig

```typescript
// From packages/credhelper/src/schemas/roles.ts
interface DockerConfig {
  default: 'deny';                // Always default deny
  allow: DockerRule[];            // Allowlist of permitted Docker API operations
}
```

### Relevant Exposure Types

```typescript
// From packages/credhelper/src/types/exposure.ts
type ExposureConfig = /* ... */ | { kind: 'docker-socket-proxy' };
type ExposureOutput = /* ... */ | { kind: 'docker-socket-proxy'; socketPath: string };
```

## New Types (defined in `packages/credhelper-daemon`)

### CompiledDockerRule

Internal representation of a `DockerRule` compiled for efficient matching.

```typescript
interface CompiledDockerRule {
  /** Original rule for error messages */
  original: DockerRule;
  /** HTTP method (uppercased) */
  method: string;
  /** Compiled regex from path template */
  pathRegex: RegExp;
  /** Whether the path template contains {id} */
  hasId: boolean;
  /** Compiled glob matcher for container name (from picomatch), or null if no name filter */
  nameMatcher: ((name: string) => boolean) | null;
}
```

### AllowlistMatchResult

Result of matching a request against the allowlist.

```typescript
type AllowlistMatchResult =
  | { allowed: true; rule: DockerRule }
  | { allowed: false; reason: string };
```

### ContainerNameCache

In-memory cache for container ID → name resolution.

```typescript
interface ContainerNameCacheEntry {
  name: string;
  resolvedAt: number;  // Date.now() for TTL checks
}

// Map<containerId, ContainerNameCacheEntry>
```

### DockerProxyConfig

Configuration for a single docker proxy instance.

```typescript
interface DockerProxyConfig {
  sessionId: string;
  sessionDir: string;
  rules: DockerRule[];
  upstreamSocket: string;
  /** Whether the upstream is the host Docker socket (DooD, not DinD) */
  upstreamIsHost: boolean;
}
```

### SessionState (modified)

```typescript
interface SessionState {
  sessionId: string;
  roleId: string;
  sessionDir: string;
  expiresAt: Date;
  createdAt: Date;
  dataServer: http.Server;
  dataSocketPath: string;
  credentialIds: string[];
  /** Docker socket proxy, if the role uses docker-socket-proxy exposure */
  dockerProxy?: DockerProxy;  // NEW
}
```

### New Error Codes

```typescript
// Added to existing ErrorCode type
type ErrorCode = /* existing codes... */
  | 'DOCKER_ACCESS_DENIED'           // 403 — request not in allowlist
  | 'DOCKER_UPSTREAM_NOT_FOUND'      // 503 — no Docker socket at boot
  | 'DOCKER_NAME_RESOLUTION_FAILED'; // 403 — container name lookup failed (fail closed)
```

### Docker Proxy Error Response

```typescript
// 403 response for denied requests
interface DockerDenyResponse {
  error: string;  // "Docker API access denied: POST /containers/abc123/start"
  code: 'DOCKER_ACCESS_DENIED';
  details: {
    method: string;
    path: string;
    normalizedPath: string;
    containerId?: string;
    containerName?: string;
    namePattern?: string;
  };
}
```

## Entity Relationships

```
RoleConfig
  └── docker?: DockerConfig
       ├── default: 'deny'
       └── allow: DockerRule[]
            ├── method: string
            ├── path: string (template with {id})
            └── name?: string (glob pattern)

DockerProxy (per session)
  ├── proxyServer: http.Server (listens on sessionDir/docker.sock)
  ├── DockerAllowlistMatcher
  │    └── CompiledDockerRule[] (compiled from DockerRule[])
  ├── ContainerNameResolver
  │    ├── upstreamSocket: string (for Docker API calls)
  │    └── cache: Map<containerId, ContainerNameCacheEntry>
  └── upstreamSocket: string (forwarding target)

SessionState
  ├── dataServer (credential data — existing)
  └── dockerProxy? (docker API proxy — NEW)
       └── stopped on endSession()

Daemon
  └── upstreamSocket: string (detected once at boot)
       ├── /var/run/docker.sock (DinD)
       └── /var/run/docker-host.sock (DooD)
```

## Validation Rules

1. **Default deny**: Any Docker API request not matching an allowlist rule is rejected with HTTP 403
2. **Method match**: Case-insensitive comparison (normalized to uppercase)
3. **Path normalization**: Version prefix `/v\d+\.\d+` stripped before matching
4. **Container ID extraction**: For `{id}` paths, the ID segment is extracted via regex capture group
5. **Name resolution**: Only performed when the matching rule has a `name` glob; skip when `name` is omitted
6. **Name resolution failure**: Fail closed — deny request with 403 if container name cannot be resolved
7. **Streaming rejection**: `GET /containers/{id}/logs` with `follow=true` query parameter rejected with 403
8. **Upstream validation**: Daemon fails to boot if no upstream Docker socket is available and any role uses docker
9. **Security warning**: Logged at boot when role allows `POST /containers/create` and upstream is host socket (DooD)
