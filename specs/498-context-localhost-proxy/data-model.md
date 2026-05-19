# Data Model: localhost-proxy Exposure Listener

## Core Types

### LocalhostProxyHandle (new interface)

```typescript
// packages/credhelper-daemon/src/types.ts
export interface LocalhostProxyHandle {
  stop(): Promise<void>;
}
```

Mirrors `DockerProxyHandle`. Stored in `SessionState` for lifecycle management.

### LocalhostProxyConfig (new interface)

```typescript
// packages/credhelper-daemon/src/exposure/localhost-proxy.ts
export interface LocalhostProxyConfig {
  /** Port to bind on 127.0.0.1 */
  port: number;
  /** Upstream base URL (e.g., 'https://api.sendgrid.com') */
  upstream: string;
  /** Headers to inject into upstream requests (e.g., { Authorization: 'Bearer ...' }) */
  headers: Record<string, string>;
  /** Allowlist rules: method + path pattern */
  rules: ProxyRule[];
}
```

### SessionState (modified)

```typescript
// packages/credhelper-daemon/src/types.ts
export interface SessionState {
  sessionId: string;
  roleId: string;
  sessionDir: string;
  expiresAt: Date;
  createdAt: Date;
  dataServer: http.Server;
  dataSocketPath: string;
  credentialIds: string[];
  dockerProxy?: DockerProxyHandle;
  /** Localhost proxy handles, one per localhost-proxy exposure */
  localhostProxies?: LocalhostProxyHandle[];  // NEW
}
```

### ErrorCode (modified)

```typescript
// packages/credhelper-daemon/src/errors.ts — additions to union
| 'PROXY_PORT_COLLISION'     // 409 — port already in use
| 'PROXY_CONFIG_MISSING'     // 400 — no proxy:<ref> entry in role
| 'PROXY_ACCESS_DENIED'      // 403 — request didn't match allowlist (used in proxy 403 response)
```

### RoleExposeSchema (modified)

```typescript
// packages/credhelper/src/schemas/roles.ts
export const RoleExposeSchema = z.object({
  as: z.enum(['env', 'git-credential-helper', 'gcloud-external-account', 'localhost-proxy', 'docker-socket-proxy']),
  name: z.string().optional(),
  port: z.number().optional(),
  envName: z.string().optional(),  // NEW — env var name for proxy URL
});
```

## Existing Types (unchanged, referenced)

### ProxyConfig / ProxyRule

```typescript
// packages/credhelper/src/schemas/roles.ts (existing)
export const ProxyRuleSchema = z.object({
  method: z.string(),   // HTTP method (e.g., 'POST')
  path: z.string(),     // Path pattern (e.g., '/v3/mail/send' or '/v3/contacts/{id}')
});

export const ProxyConfigSchema = z.object({
  upstream: z.string().url(),        // e.g., 'https://api.sendgrid.com'
  default: z.enum(['deny']),         // Only 'deny' supported
  allow: z.array(ProxyRuleSchema),   // Allowlist
});
```

### PluginLocalhostProxyExposure (existing)

```typescript
// From plugin.renderExposure() when kind === 'localhost-proxy'
{
  kind: 'localhost-proxy';
  upstream: string;                    // Target URL
  headers: Record<string, string>;     // Auth headers to inject
}
```

### CredhelperErrorResponse (existing, used for 403)

```typescript
{
  error: string;         // Human-readable message
  code: string;          // Machine-readable code
  details?: Record<string, unknown>;  // Optional context
}
```

## Validation Rules

| Field | Constraint | Error |
|-------|-----------|-------|
| `expose.port` | Required when `as: localhost-proxy` | `INVALID_ROLE` |
| `roleConfig.proxy[credRef.ref]` | Must exist for each `localhost-proxy` exposure | `PROXY_CONFIG_MISSING` |
| `port` | Must not be in use | `PROXY_PORT_COLLISION` |
| `proxy.upstream` | Valid URL (Zod `.url()`) | Schema validation |
| `proxy.allow` | Non-empty array | Schema validation |

## Entity Relationships

```
RoleConfig
  ├── credentials[]: RoleCredentialRef
  │     ├── ref: string  ──────────────────┐
  │     └── expose[]: RoleExpose           │
  │           ├── as: 'localhost-proxy'     │
  │           ├── port: number             │
  │           └── envName?: string         │
  └── proxy?: Record<string, ProxyConfig>  │
        └── [credRef.ref] ◄────────────────┘  (keyed by ref name)
              ├── upstream: string
              ├── default: 'deny'
              └── allow[]: ProxyRule
                    ├── method: string
                    └── path: string

SessionState
  └── localhostProxies?: LocalhostProxyHandle[]
        └── LocalhostProxy (class)
              ├── server: http.Server
              ├── config: LocalhostProxyConfig
              └── stop(): closes server
```
