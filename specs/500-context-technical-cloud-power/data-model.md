# Data Model: CLI deploy ssh://host command

## Core Types

### SshTarget

Parsed representation of an `ssh://[user@]host[:port][/path]` URL.

```typescript
export interface SshTarget {
  /** SSH username. Defaults to current OS user. */
  user: string;
  /** Hostname or IP address. */
  host: string;
  /** SSH port. Defaults to 22. */
  port: number;
  /** Remote project directory. Defaults to ~/generacy-clusters/<project-id>. */
  remotePath: string | null;
}
```

### DeployOptions

Options passed to the deploy command handler.

```typescript
export interface DeployOptions {
  /** Raw target string, e.g., "ssh://user@host:22/path" */
  target: string;
  /** Deploy timeout in seconds. Default: 300 (5 minutes). */
  timeout?: number;
  /** Cloud URL override. Default: https://api.generacy.ai */
  cloudUrl?: string;
}
```

### DeployResult

Return value from a successful deploy operation.

```typescript
export interface DeployResult {
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl: string;
  managementEndpoint: string;
  remotePath: string;
}
```

## Shared Activation Client Types

Extracted into `@generacy-ai/activation-client`.

### DeviceCodeResponse

Response from `POST /api/clusters/device-code`.

```typescript
export const DeviceCodeResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string().url(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});

export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;
```

### PollResponse

Response from `POST /api/clusters/device-code/poll`.

```typescript
export const PollResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('approved'),
    apiKey: z.string(),
    clusterApiKeyId: z.string().optional(),
    clusterId: z.string(),
    projectId: z.string(),
    orgId: z.string(),
  }),
  z.object({
    status: z.literal('pending'),
  }),
  z.object({
    status: z.literal('slow_down'),
  }),
  z.object({
    status: z.literal('expired'),
  }),
]);

export type PollResponse = z.infer<typeof PollResponseSchema>;
```

### ActivationClientOptions

Configuration for the shared activation client.

```typescript
export interface ActivationClientOptions {
  cloudUrl: string;
  logger: Logger;
  maxCycles?: number;     // Default: 3
  maxRetries?: number;    // Default: 5
}
```

### ActivationResult

Returned after successful device-flow completion.

```typescript
export interface ActivationResult {
  apiKey: string;
  clusterApiKeyId?: string;
  clusterId: string;
  projectId: string;
  orgId: string;
}
```

## Registry Extension

### RegistryEntry (modified)

```typescript
export const RegistryEntrySchema = z.object({
  clusterId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  composePath: z.string(),
  variant: z.enum(['standard', 'microservices']),
  channel: z.enum(['stable', 'preview']),
  cloudUrl: z.string().nullable(),
  lastSeen: z.string().datetime(),
  createdAt: z.string().datetime(),
  // NEW: SSH management endpoint for remote clusters
  managementEndpoint: z.string().optional(),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
```

The `managementEndpoint` field stores the full SSH target URL (e.g., `ssh://user@host:22/~/generacy-clusters/proj-123`). When present and starts with `ssh://`, lifecycle commands forward `docker compose` over SSH. When absent or empty, commands run locally (existing behavior).

## Bootstrap Bundle Files

Files generated locally and SCPed to the remote host:

### cluster.yaml

```yaml
channel: stable        # or preview, from LaunchConfig
variant: standard      # from LaunchConfig
```

### cluster.json

```json
{
  "clusterId": "<from-activation>",
  "projectId": "<from-activation>",
  "orgId": "<from-activation>",
  "cloudUrl": "<cloud-url>"
}
```

### docker-compose.yml

Templated from `LaunchConfig.imageTag` and compose template fetched from the cloud. Same format as `generacy launch` (#495).

## Error Types

### DeployError

```typescript
export type DeployErrorCode =
  | 'INVALID_TARGET'       // SSH URL parse failure
  | 'SSH_CONNECT_FAILED'   // Cannot reach host
  | 'DOCKER_MISSING'       // Docker not installed on remote
  | 'ACTIVATION_FAILED'    // Device-flow failure
  | 'LAUNCH_CONFIG_FAILED' // Cloud config fetch failure
  | 'SCP_FAILED'           // File transfer failure
  | 'COMPOSE_FAILED'       // docker compose up failure
  | 'REGISTRATION_TIMEOUT' // Cluster didn't register in time
  | 'PULL_FAILED';         // docker compose pull failure

export class DeployError extends Error {
  constructor(
    message: string,
    public readonly code: DeployErrorCode,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DeployError';
  }
}
```

### ActivationError (shared package)

```typescript
export type ActivationErrorCode =
  | 'CLOUD_UNREACHABLE'
  | 'DEVICE_CODE_EXPIRED'
  | 'INVALID_RESPONSE';

export class ActivationError extends Error {
  constructor(
    message: string,
    public readonly code: ActivationErrorCode,
  ) {
    super(message);
    this.name = 'ActivationError';
  }
}
```

## Validation Rules

| Field | Rule |
|-------|------|
| `SshTarget.host` | Non-empty string, valid hostname or IP |
| `SshTarget.port` | Integer 1-65535, default 22 |
| `SshTarget.user` | Non-empty string, default `os.userInfo().username` |
| `DeployOptions.timeout` | Positive integer, default 300 |
| `DeployOptions.target` | Must start with `ssh://` (future: other schemes) |
| `managementEndpoint` | Optional; if present, must be a valid URL string |

## Entity Relationships

```
DeployOptions
    └── target → parsed into SshTarget

Deploy Flow:
    SshTarget
    ├── verify SSH connectivity → ssh client
    ├── verify Docker presence → ssh client
    └── remote path → bootstrap bundle destination

    ActivationClientOptions
    └── initDeviceFlow() → DeviceCodeResponse
        └── pollForApproval() → ActivationResult
            └── fetchLaunchConfig() → LaunchConfig

    LaunchConfig + ActivationResult
    └── scaffolder → bootstrap bundle (cluster.yaml, cluster.json, docker-compose.yml)
        └── SCP → remote host
            └── SSH docker compose up
                └── pollClusterStatus() → success/timeout

    RegistryEntry (with managementEndpoint)
    └── lifecycle commands → SSH forwarding or local compose
```
