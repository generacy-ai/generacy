# Data Model: Forward Registry Credentials to Credhelper

## Core Types

### RegistryCredential (new field on LaunchConfig)

```typescript
// packages/generacy/src/cli/commands/launch/types.ts
const RegistryCredentialSchema = z.object({
  host: z.string(),   // e.g., "ghcr.io", "private.example.com"
  auth: z.string(),   // base64-encoded "user:password" (Docker auth format)
});

// Added to LaunchConfigSchema
registryCredentials: z.array(RegistryCredentialSchema).optional()
```

### CredentialForwardResult

```typescript
// packages/generacy/src/cli/commands/launch/credential-forward.ts
interface CredentialForwardResult {
  forwarded: string[];  // credential IDs successfully PUT
  failed: string[];     // credential IDs that failed
}
```

### ProbeOptions

```typescript
interface ProbeOptions {
  retries?: number;      // default: 10
  intervalMs?: number;   // default: 2000
}
```

## Wire Format

### PUT /credentials/registry-<host> Request

```typescript
{
  type: "registry",        // credential type identifier
  value: string            // base64 Docker auth (raw from LaunchConfig)
}
```

Headers:
- `Content-Type: application/json`
- `x-generacy-actor-user-id: system:cli-launch`

### PUT /credentials/registry-<host> Response (200)

```typescript
{ ok: true }
```

### PUT /credentials/registry-<host> Response (500)

```typescript
{
  error: string,
  code: "CREDENTIAL_WRITE_FAILED",
  failedAt: string
}
```

## Credential ID Convention

Format: `registry-<host>`

Examples:
- `registry-ghcr.io`
- `registry-private.example.com`
- `registry-123456789.dkr.ecr.us-east-1.amazonaws.com`

Rules:
- Prefix: always `registry-`
- Suffix: exact hostname from `registryCredentials[].host`
- No port number (Docker auth keys don't include port)
- Lowercase (hosts are case-insensitive; normalize to lower)

## File Paths

| Path | Purpose | Lifecycle |
|------|---------|-----------|
| `<projectDir>/.generacy/.docker/config.json` | Scoped Docker auth for image pull | Created by sibling #641, deleted by this feature |
| `/var/lib/generacy/credentials.dat` | Encrypted credential store (in-container) | Written by control-plane on PUT |
| `.agency/credentials.yaml` | Credential metadata (in-container) | Written by control-plane on PUT |

## Relationships

```
LaunchConfig.registryCredentials[]
  → forwardRegistryCredentials()
    → PUT /credentials/registry-<host>
      → ClusterLocalBackend.setSecret()  (encrypted storage)
      → credentials.yaml metadata write
      → cluster.credentials relay event
  → cleanupScopedDockerConfig()
    → rm -rf <projectDir>/.generacy/.docker/
```
