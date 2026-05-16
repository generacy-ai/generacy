# Data Model: Fetch Registry Credentials for `generacy update`

## Core Types

### RegistryCredentialValue

The decrypted value stored in credhelper for `registry-<host>` credentials.

```typescript
// Stored in ClusterLocalBackend as JSON string
interface RegistryCredentialValue {
  username: string;
  password: string;
}
```

### CredentialValueResponse

Response from `GET /credentials/:id/value` endpoint.

```typescript
// Success response (200)
interface CredentialValueResponse {
  value: string; // Raw decrypted secret (JSON string for registry creds)
}

// Error responses
interface CredentialValueError {
  error: string;
  code: 'CREDENTIAL_NOT_FOUND' | 'BACKEND_ERROR';
}
```

### DockerAuthConfig

Standard Docker `config.json` format written to disk.

```typescript
interface DockerAuthConfig {
  auths: {
    [host: string]: {
      auth: string; // base64(username:password)
    };
  };
}
```

### ScopedDockerConfigOptions

Input to the `materializeScopedDockerConfig()` helper.

```typescript
interface ScopedDockerConfigOptions {
  projectDir: string;  // Path to project root (contains .generacy/)
  host: string;        // Registry hostname (e.g., "ghcr.io")
  username: string;    // Registry username
  password: string;    // Registry password/token
}
```

## Validation Schemas (Zod)

```typescript
import { z } from 'zod';

// Credential value from control-plane endpoint
export const CredentialValueResponseSchema = z.object({
  value: z.string(),
});

// Registry credential value (parsed from the value string)
export const RegistryCredentialValueSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Host (CLI)                                                       │
│                                                                  │
│  1. Parse image host from .generacy/docker-compose.yml           │
│  2. docker compose exec → query control-plane inside container   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Container (orchestrator)                                   │   │
│  │                                                            │   │
│  │  3. GET /credentials/registry-<host>/value                 │   │
│  │     → ClusterLocalBackend.fetchSecret("registry-<host>")   │   │
│  │     → decrypt AES-256-GCM                                  │   │
│  │     → return { value: '{"username":"x","password":"y"}' }  │   │
│  │                                                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  4. Parse JSON: { username, password }                           │
│  5. Write .generacy/.docker/config.json:                         │
│     { "auths": { "<host>": { "auth": "base64(user:pass)" } } }  │
│  6. DOCKER_CONFIG=.generacy/.docker docker compose pull           │
│  7. Cleanup .generacy/.docker/                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## File Artifacts

| Path | Format | Created By | Consumed By | Lifecycle |
|------|--------|-----------|-------------|-----------|
| `.generacy/.docker/config.json` | Docker auth JSON | `materializeScopedDockerConfig()` | `docker compose pull` | Transient (try/finally) |
| `/var/lib/generacy/credentials.dat` | AES-256-GCM encrypted JSON | `ClusterLocalBackend.setSecret()` | `ClusterLocalBackend.fetchSecret()` | Persistent (in-container) |
| `.generacy/docker-compose.yml` | YAML | CLI scaffolder | Update command (image host extraction) | Persistent |

## Credential ID Convention

```
registry-<host>
```

Examples:
- `registry-ghcr.io` → GitHub Container Registry
- `registry-docker.io` → Docker Hub (authenticated)
- `registry-123456789.dkr.ecr.us-east-1.amazonaws.com` → AWS ECR

The host is derived from the image reference in docker-compose.yml and used as the lookup key.

## Relationships

```
ClusterContext (existing)
  └── composePath → docker-compose.yml
       └── image field → registry host
            └── credential ID: "registry-{host}"
                 └── ClusterLocalBackend.fetchSecret()
                      └── RegistryCredentialValue { username, password }
                           └── DockerAuthConfig → .generacy/.docker/config.json
```
