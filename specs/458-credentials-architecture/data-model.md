# Data Model: @generacy-ai/credhelper

## Core Entities

### Secret

The atomic unit of credential data passed between plugins and the credhelper runtime.

```typescript
interface Secret {
  value: string;
  format?: 'token' | 'json' | 'key' | 'opaque';
}
```

- `value` — the raw secret string (token, JSON blob, private key, etc.)
- `format` — optional hint for exposure rendering; defaults to `'opaque'` semantically

### BackendClient

Abstraction for accessing secret backends, injected into plugin contexts.

```typescript
interface BackendClient {
  fetchSecret(key: string): Promise<string>;
}
```

### MintContext

Passed to plugins that mint short-lived derived credentials.

```typescript
interface MintContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
  scope: Record<string, unknown>;  // validated by plugin's scopeSchema
  ttl: number;                     // seconds, from credentials.yaml mint.ttl
}
```

### ResolveContext

Passed to plugins that resolve static credentials.

```typescript
interface ResolveContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
}
```

### CredentialTypePlugin

The core plugin contract. Every credential type (github-app, gcp-service-account, etc.) implements this interface.

```typescript
interface CredentialTypePlugin {
  type: string;
  credentialSchema: ZodSchema;
  scopeSchema?: ZodSchema;
  supportedExposures: ExposureKind[];

  mint?(ctx: MintContext): Promise<{ value: Secret; expiresAt: Date }>;
  resolve?(ctx: ResolveContext): Promise<Secret>;

  renderExposure(
    kind: ExposureKind,
    secret: Secret,
    cfg: ExposureConfig,
  ): ExposureOutput;
}
```

**Constraints**:
- A plugin must implement exactly one of `mint` or `resolve`
- `supportedExposures` is the allowlist — role validation fails closed if a role requests an unsupported exposure kind
- `renderExposure` is only called with kinds listed in `supportedExposures`

### ExposureKind

Enum of supported credential exposure mechanisms.

```typescript
type ExposureKind =
  | 'env'
  | 'git-credential-helper'
  | 'gcloud-external-account'
  | 'localhost-proxy'
  | 'docker-socket-proxy';
```

### ExposureConfig (Discriminated Union)

Per-kind configuration for how a credential is exposed to the workflow.

```typescript
type ExposureConfig =
  | { kind: 'env'; name: string }
  | { kind: 'git-credential-helper' }
  | { kind: 'gcloud-external-account' }
  | { kind: 'localhost-proxy'; port: number }
  | { kind: 'docker-socket-proxy' };
```

### ExposureOutput (Discriminated Union)

Per-kind rendered output from a plugin's `renderExposure` method.

```typescript
type ExposureOutput =
  | { kind: 'env'; entries: Array<{ key: string; value: string }> }
  | { kind: 'git-credential-helper'; script: string }
  | { kind: 'gcloud-external-account'; json: object }
  | { kind: 'localhost-proxy'; proxyConfig: { port: number; upstream: string; headers: Record<string, string> } }
  | { kind: 'docker-socket-proxy'; socketPath: string };
```

### Session API Types

Request/response types for the credhelper Unix socket control API.

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

### LaunchRequestCredentials

The credentials field shape that the AgentLauncher credentials interceptor consumes (Phase 3).

```typescript
interface LaunchRequestCredentials {
  role: string;
  uid: number;
  gid: number;
}
```

## Configuration Schemas (Zod)

### BackendsConfig

Validates `.agency/secrets/backends.yaml`.

```typescript
const BackendAuthSchema = z.object({
  mode: z.string(),
}).passthrough();

const BackendEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  endpoint: z.string().url().optional(),
  auth: BackendAuthSchema.optional(),
});

const BackendsConfigSchema = z.object({
  schemaVersion: z.literal('1'),
  backends: z.array(BackendEntrySchema),
});

type BackendsConfig = z.infer<typeof BackendsConfigSchema>;
type BackendEntry = z.infer<typeof BackendEntrySchema>;
```

### CredentialsConfig

Validates `.agency/secrets/credentials.yaml` and `credentials.local.yaml`.

```typescript
const MintConfigSchema = z.object({
  ttl: z.string(),
  scopeTemplate: z.record(z.unknown()).optional(),
});

const CredentialEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  backend: z.string(),
  backendKey: z.string(),
  mint: MintConfigSchema.optional(),
});

const CredentialsConfigSchema = z.object({
  schemaVersion: z.literal('1'),
  credentials: z.array(CredentialEntrySchema),
});

type CredentialsConfig = z.infer<typeof CredentialsConfigSchema>;
type CredentialEntry = z.infer<typeof CredentialEntrySchema>;
```

### RoleConfig

Validates `.agency/roles/<role>.yaml`.

```typescript
const RoleExposeSchema = z.object({
  as: z.enum(['env', 'git-credential-helper', 'gcloud-external-account', 'localhost-proxy', 'docker-socket-proxy']),
  name: z.string().optional(),    // for 'env' exposure
  port: z.number().optional(),    // for 'localhost-proxy' exposure
});

const RoleCredentialRefSchema = z.object({
  ref: z.string(),
  scope: z.record(z.unknown()).optional(),
  expose: z.array(RoleExposeSchema),
});

const ProxyRuleSchema = z.object({
  method: z.string(),
  path: z.string(),
});

const ProxyConfigSchema = z.object({
  upstream: z.string().url(),
  default: z.enum(['deny']),
  allow: z.array(ProxyRuleSchema),
});

const DockerRuleSchema = z.object({
  method: z.string(),
  path: z.string(),
  name: z.string().optional(),
});

const DockerConfigSchema = z.object({
  default: z.enum(['deny']),
  allow: z.array(DockerRuleSchema),
});

const RoleConfigSchema = z.object({
  schemaVersion: z.literal('1'),
  id: z.string(),
  description: z.string(),
  extends: z.string().optional(),
  credentials: z.array(RoleCredentialRefSchema),
  proxy: z.record(ProxyConfigSchema).optional(),
  docker: DockerConfigSchema.optional(),
});

type RoleConfig = z.infer<typeof RoleConfigSchema>;
```

### TrustedPluginsConfig

Validates `.agency/secrets/trusted-plugins.yaml`.

```typescript
const PluginPinSchema = z.object({
  sha256: z.string(),
});

const TrustedPluginsSchema = z.object({
  schemaVersion: z.literal('1'),
  plugins: z.record(PluginPinSchema),
});

type TrustedPluginsConfig = z.infer<typeof TrustedPluginsSchema>;
```

## Entity Relationships

```
BackendsConfig
  └── BackendEntry[]
        ├── id ◄──── CredentialEntry.backend (references by id)
        └── auth? (BackendAuth, passthrough)

CredentialsConfig
  └── CredentialEntry[]
        ├── id ◄──── RoleCredentialRef.ref (references by id)
        ├── type ◄── maps to CredentialTypePlugin.type
        ├── backend → BackendEntry.id
        └── mint? (MintConfig)

RoleConfig
  ├── extends? → another RoleConfig.id
  ├── credentials[]
  │     ├── ref → CredentialEntry.id
  │     ├── scope? → validated by plugin's scopeSchema
  │     └── expose[] → validated against plugin's supportedExposures
  ├── proxy? → per-service proxy configs
  └── docker? → docker socket proxy allowlist

TrustedPluginsConfig
  └── plugins (name → sha256 pin)

CredentialTypePlugin
  ├── type → matches CredentialEntry.type
  ├── credentialSchema → validates CredentialEntry
  ├── scopeSchema? → validates RoleCredentialRef.scope
  ├── supportedExposures → gate for RoleCredentialRef.expose[].as
  ├── mint? → uses MintContext (includes BackendClient)
  ├── resolve? → uses ResolveContext (includes BackendClient)
  └── renderExposure → ExposureConfig → ExposureOutput
```

## Validation Rules

1. **Backend references**: `CredentialEntry.backend` must match a `BackendEntry.id`
2. **Credential references**: `RoleCredentialRef.ref` must match a `CredentialEntry.id`
3. **Exposure validation**: `RoleCredentialRef.expose[].as` must be in the plugin's `supportedExposures`
4. **Role extends**: `RoleConfig.extends` must reference a valid role id
5. **Schema version**: All config files must have `schemaVersion: "1"`
6. **Plugin trust**: Non-core plugins must appear in `TrustedPluginsSchema.plugins` with matching SHA256

**Note**: Cross-file reference validation (rules 1, 2, 3, 4, 6) is a runtime concern for Phase 2. Phase 1 schemas validate individual file structure only.
