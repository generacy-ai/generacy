# Data Model: `generacy registry-login`

## Core Entities

### DockerConfig

Represents a project-scoped Docker configuration file at `<projectDir>/.generacy/.docker/config.json`.

```typescript
interface DockerConfig {
  auths: Record<string, DockerAuthEntry>;
}

interface DockerAuthEntry {
  auth: string; // base64(username:password)
}
```

**Location**: `<projectDir>/.generacy/.docker/config.json`
**Ownership**: CLI writes, `docker compose pull` reads via `DOCKER_CONFIG` env var.

### ControlPlaneCredential

The payload sent to the control-plane's `PUT /credentials/:id` endpoint.

```typescript
interface PutCredentialBody {
  type: 'docker-registry';
  value: string; // JSON-serialized RegistryCredentialValue
}

interface RegistryCredentialValue {
  username: string;
  password: string;
}
```

**Credential ID convention**: `registry-<host>` (e.g., `registry-ghcr.io`)

## Type Definitions

### Command Options

```typescript
// registry-login argument
interface RegistryLoginArgs {
  host: string; // positional: e.g., "ghcr.io"
}

// registry-logout argument
interface RegistryLogoutArgs {
  host: string; // positional: e.g., "ghcr.io"
}
```

### Helper Function Signatures

```typescript
// docker-config.ts
function readDockerConfig(generacyDir: string): DockerConfig;
function writeDockerConfig(generacyDir: string, config: DockerConfig): void;
function addAuth(config: DockerConfig, host: string, username: string, password: string): DockerConfig;
function removeAuth(config: DockerConfig, host: string): DockerConfig;
function getDockerConfigDir(generacyDir: string): string;
function dockerConfigExists(generacyDir: string): boolean;

// credential-forward.ts
function forwardCredential(ctx: ClusterContext, host: string, username: string, password: string): ExecResult;
function removeCredential(ctx: ClusterContext, host: string): ExecResult;
function isClusterRunning(ctx: ClusterContext): boolean;
```

## Validation Rules

| Field | Rule | Error |
|-------|------|-------|
| `host` | Non-empty string, no whitespace | "Registry host cannot be empty" |
| `username` | Non-empty string | "Username cannot be empty" |
| `password` | Non-empty string | "Token/password cannot be empty" |
| `generacyDir` | Must exist with `cluster.json` | Handled by `getClusterContext()` |

## Relationships

```
ClusterContext (existing)
  └── generacyDir: string
       └── .docker/config.json (DockerConfig)

compose.ts (modified)
  reads: .generacy/.docker/config.json existence
  sets: DOCKER_CONFIG env var on spawn

control-plane (existing)
  PUT /credentials/registry-<host>
    body: PutCredentialBody
  DELETE /credentials/registry-<host>
```

## File System Layout

```
<projectDir>/
└── .generacy/
    ├── cluster.json          (existing — cluster identity)
    ├── cluster.yaml          (existing — cluster config)
    ├── docker-compose.yml    (existing — compose file)
    ├── .env                  (existing — env vars)
    └── .docker/
        └── config.json       (NEW — scoped Docker auth)
```
