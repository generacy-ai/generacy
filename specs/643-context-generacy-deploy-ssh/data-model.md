# Data Model: Deploy SSH — Registry Credential Authentication

## Core Types

### RegistryCredential (Existing — from LaunchConfig)

```typescript
// packages/generacy/src/cli/commands/launch/types.ts
interface RegistryCredential {
  host: string;      // e.g., "ghcr.io", "registry.example.com"
  username: string;  // Plain text username
  password: string;  // Plain text password/token
}
```

### Docker config.json (Generated — Written to Remote)

```typescript
interface DockerConfig {
  auths: Record<string, DockerAuth>;
}

interface DockerAuth {
  auth: string;  // base64(username:password)
}
```

**Example**:
```json
{
  "auths": {
    "ghcr.io": {
      "auth": "dXNlcm5hbWU6Z2hwX3Rva2VuMTIz"
    }
  }
}
```

### Credential Forward Request (PUT to Control-Plane)

```typescript
interface PutCredentialBody {
  type: 'registry';
  value: string;  // base64(username:password)
}
```

**Credential ID**: `registry-${host}` (e.g., `registry-ghcr.io`)

### ForwardResult

```typescript
interface ForwardResult {
  forwarded: string[];  // List of hosts successfully forwarded
  failed: string[];     // List of hosts that failed
}
```

## New Function Signatures

### remote-credentials.ts

```typescript
/**
 * Write a scoped Docker config.json to the remote host via SSH stdin pipe.
 * Creates <remotePath>/.docker/config.json with mode 0600.
 */
export function writeRemoteDockerConfig(
  target: SshTarget,
  remotePath: string,
  credentials: RegistryCredential[],
): void;

/**
 * Remove the scoped Docker config from the remote host.
 * Idempotent — tolerates missing file/directory.
 */
export function cleanupRemoteDockerConfig(
  target: SshTarget,
  remotePath: string,
): void;

/**
 * Build Docker config.json content from credential entries.
 */
export function buildDockerConfigJson(credentials: RegistryCredential[]): string;
```

### credential-forward.ts

```typescript
/**
 * Forward registry credentials to the cluster's credhelper via SSH.
 * Uses docker compose exec to reach control-plane Unix socket.
 * Soft-fails: returns ForwardResult with failed entries (does not throw).
 */
export function forwardCredentialsToCluster(
  target: SshTarget,
  remotePath: string,
  credentials: RegistryCredential[],
  logger: Logger,
): ForwardResult;

/**
 * Forward a single credential entry. Throws on failure.
 */
function forwardSingleCredential(
  target: SshTarget,
  remotePath: string,
  credential: RegistryCredential,
): void;
```

### remote-compose.ts (Modified)

```typescript
/**
 * Deploy bundle to remote and start services.
 * Now accepts optional credentials for authenticated pull.
 */
export function deployToRemote(
  target: SshTarget,
  bundleDir: string,
  remotePath: string,
  registryCredentials?: RegistryCredential[],
): void;
```

## Modified Types

### DeployErrorCode (Extended)

```typescript
type DeployErrorCode =
  | 'INVALID_TARGET'
  | 'SSH_CONNECT_FAILED'
  | 'DOCKER_MISSING'
  | 'ACTIVATION_FAILED'
  | 'LAUNCH_CONFIG_FAILED'
  | 'SCP_FAILED'
  | 'COMPOSE_FAILED'
  | 'REGISTRATION_TIMEOUT'
  | 'PULL_FAILED'
  | 'CREDENTIAL_WRITE_FAILED';  // NEW — remote Docker config write failure
```

Note: `CREDENTIAL_FORWARD_FAILED` is NOT needed because forwarding soft-fails (warn + exit 0).

## Data Flow

```
Cloud API                    Local CLI                  Remote VM                   Container
    │                           │                          │                           │
    │── LaunchConfig ──────────>│                          │                           │
    │   (registryCredentials)   │                          │                           │
    │                           │── writeRemoteDockerConfig ──>│                       │
    │                           │   (ssh cat > .docker/config.json)                    │
    │                           │                          │                           │
    │                           │── DOCKER_CONFIG=... docker compose pull ──>│         │
    │                           │                          │── (pulls image) ──────────>│
    │                           │                          │                           │
    │                           │── cleanupRemoteDockerConfig ──>│                     │
    │                           │   (ssh rm -f)            │                           │
    │                           │                          │                           │
    │                           │── docker compose up -d ──>│                          │
    │                           │                          │── (starts cluster) ──────>│
    │                           │                          │                           │
    │<── pollClusterStatus ─────│                          │                           │
    │   (connected)             │                          │                           │
    │                           │── forwardCredentials ────────────────────────────────>│
    │                           │   (ssh docker exec curl PUT /credentials/:id)        │
    │                           │                          │                           │
```

## Validation Rules

| Field | Rule | Error |
|-------|------|-------|
| `credentials[].host` | Non-empty string | Zod `.min(1)` (existing) |
| `credentials[].username` | Non-empty string | Zod `.min(1)` (existing) |
| `credentials[].password` | Non-empty string | Zod `.min(1)` (existing) |
| Docker config path | Must be under `remotePath` | Constructed, not user-input |
| Credential ID | `registry-${host}` pattern | Derived from validated host |
