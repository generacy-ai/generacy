# Data Model: Credhelper Daemon

## Existing Types (from `@generacy-ai/credhelper`)

These are defined in Phase 1 and imported by the daemon.

### Secret
```typescript
interface Secret {
  value: string;
  format?: 'token' | 'json' | 'key' | 'opaque';
}
```

### Session API
```typescript
interface BeginSessionRequest {
  role: string;
  sessionId: string;
}

interface BeginSessionResponse {
  sessionDir: string;
  expiresAt: Date;
}

interface EndSessionRequest {
  sessionId: string;
}
```

### Plugin Interface
```typescript
interface CredentialTypePlugin {
  type: string;
  credentialSchema: ZodSchema;
  scopeSchema?: ZodSchema;
  supportedExposures: ExposureKind[];
  mint?(ctx: MintContext): Promise<{ value: Secret; expiresAt: Date }>;
  resolve?(ctx: ResolveContext): Promise<Secret>;
  renderExposure(kind: ExposureKind, secret: Secret, cfg: ExposureConfig): ExposureOutput;
}
```

### Exposure Types
```typescript
type ExposureKind = 'env' | 'git-credential-helper' | 'gcloud-external-account'
  | 'localhost-proxy' | 'docker-socket-proxy';

type ExposureConfig =
  | { kind: 'env'; name: string }
  | { kind: 'git-credential-helper' }
  | { kind: 'gcloud-external-account' }
  | { kind: 'localhost-proxy'; port: number }
  | { kind: 'docker-socket-proxy' };

type ExposureOutput =
  | { kind: 'env'; entries: Array<{ key: string; value: string }> }
  | { kind: 'git-credential-helper'; script: string }
  | { kind: 'gcloud-external-account'; json: object }
  | { kind: 'localhost-proxy'; proxyConfig: { port: number; upstream: string; headers: Record<string, string> } }
  | { kind: 'docker-socket-proxy'; socketPath: string };
```

### Config Schemas (Zod-parsed types)
```typescript
// backends.yaml
interface BackendEntry { id: string; type: string; endpoint?: string; auth?: { mode: string; [k: string]: unknown } }
interface BackendsConfig { schemaVersion: '1'; backends: BackendEntry[] }

// credentials.yaml
interface MintConfig { ttl: string; scopeTemplate?: Record<string, unknown> }
interface CredentialEntry { id: string; type: string; backend: string; backendKey: string; mint?: MintConfig }
interface CredentialsConfig { schemaVersion: '1'; credentials: CredentialEntry[] }

// roles/<role>.yaml
interface RoleExpose { as: ExposureKind; name?: string; port?: number }
interface RoleCredentialRef { ref: string; scope?: Record<string, unknown>; expose: RoleExpose[] }
interface RoleConfig { schemaVersion: '1'; id: string; description: string; extends?: string; credentials: RoleCredentialRef[]; proxy?: Record<string, ProxyConfig>; docker?: DockerConfig }
```

## New Types (defined in `packages/credhelper-daemon`)

### DaemonConfig
```typescript
interface DaemonConfig {
  /** Path to the control socket */
  controlSocketPath: string;  // default: /run/generacy-credhelper/control.sock

  /** Base directory for session directories */
  sessionsDir: string;  // default: /run/generacy-credhelper/sessions

  /** UID of the worker process (for SO_PEERCRED and file ownership) */
  workerUid: number;  // default: 1000 (node)

  /** GID of the worker process group */
  workerGid: number;  // default: 1000 (node)

  /** UID the daemon runs as */
  daemonUid: number;  // default: 1002 (credhelper)

  /** Config loader adapter (from #462) */
  configLoader: ConfigLoader;

  /** Plugin registry adapter (from #460) */
  pluginRegistry: PluginRegistry;

  /** Session expiry sweep interval in ms */
  sweepIntervalMs: number;  // default: 30000

  /** Enable SO_PEERCRED verification */
  enablePeerCred: boolean;  // default: true
}
```

### ConfigLoader (adapter interface for #462)
```typescript
interface ConfigLoader {
  loadRole(roleId: string): Promise<RoleConfig>;
  loadCredential(credentialId: string): Promise<CredentialEntry>;
  loadBackend(backendId: string): Promise<BackendEntry>;
}
```

### PluginRegistry (adapter interface for #460)
```typescript
interface PluginRegistry {
  getPlugin(credentialType: string): CredentialTypePlugin;
}
```

### SessionState
```typescript
interface SessionState {
  sessionId: string;
  roleId: string;
  sessionDir: string;
  expiresAt: Date;
  createdAt: Date;
  dataServer: http.Server;
  dataSocketPath: string;
  credentialIds: string[];  // credentials active in this session
}
```

### CredentialCacheEntry
```typescript
interface CredentialCacheEntry {
  value: Secret;
  expiresAt: Date;
  /** Timer ID for background refresh (mint-based credentials only) */
  refreshTimerId?: NodeJS.Timeout;
  /** Whether the credential is currently available */
  available: boolean;
  /** Credential type (for refresh — need to call plugin.mint again) */
  credentialType: string;
  /** Mint context for refresh */
  mintContext?: MintContext;
}
```

### CredhelperErrorResponse
```typescript
interface CredhelperErrorResponse {
  error: string;           // human-readable message
  code: ErrorCode;         // machine-readable code
  details?: {
    pluginType?: string;
    credentialId?: string;
    backendId?: string;
    sessionId?: string;
    [key: string]: unknown;
  };
}
```

### ErrorCode
```typescript
type ErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_ROLE'
  | 'ROLE_NOT_FOUND'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_MINT_FAILED'
  | 'PLUGIN_RESOLVE_FAILED'
  | 'UNSUPPORTED_EXPOSURE'
  | 'NOT_IMPLEMENTED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_EXPIRED'
  | 'BACKEND_UNREACHABLE'
  | 'PEER_REJECTED'
  | 'INTERNAL_ERROR';
```

### PeerCredentials
```typescript
interface PeerCredentials {
  pid: number;
  uid: number;
  gid: number;
}
```

## Relationships

```
DaemonConfig
  ├── ConfigLoader ──→ RoleConfig, CredentialEntry, BackendEntry
  ├── PluginRegistry ──→ CredentialTypePlugin
  └── Daemon
       ├── ControlServer (1 per daemon)
       │    └── SO_PEERCRED gate → PeerCredentials
       ├── SessionManager
       │    ├── Map<sessionId, SessionState>
       │    ├── CredentialStore
       │    │    └── Map<sessionId, Map<credId, CredentialCacheEntry>>
       │    ├── TokenRefresher
       │    │    └── setTimeout chains per credential
       │    └── ExposureRenderer
       │         └── writes files to SessionState.sessionDir
       └── DataServer (1 per session)
            └── reads from CredentialStore
```

## Validation Rules

- `BeginSessionRequest.role` must match a valid role ID in config
- `BeginSessionRequest.sessionId` must be non-empty and unique across active sessions
- Role's credential refs must resolve to valid credential entries
- Each credential's type must have a registered plugin
- Each requested exposure kind must be in the plugin's `supportedExposures`
- `localhost-proxy` and `docker-socket-proxy` exposures return `NOT_IMPLEMENTED` error in Phase 2
- TTL strings must parse to positive milliseconds
- Session expiry must be in the future
- SO_PEERCRED UID must match `DaemonConfig.workerUid`
