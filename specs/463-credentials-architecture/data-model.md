# Data Model: Core Credential Type Plugins (#463)

## Type Extensions

### Extended Context Types

```typescript
// packages/credhelper/src/types/context.ts — MODIFIED

export interface MintContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
  scope: Record<string, unknown>;
  ttl: number;
  config: Record<string, unknown>;  // NEW: validated credential entry fields from YAML
}

export interface ResolveContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;
  config: Record<string, unknown>;  // NEW: validated credential entry fields from YAML
}
```

The `config` field contains credential YAML fields minus common structural fields (`id`, `type`, `backend`, `backendKey`, `mint`). For example, a `github-app` credential with `appId: 12345` in YAML would have `config: { appId: 12345, installationId: 67890 }`.

### Plugin Exposure Data (NEW)

```typescript
// packages/credhelper/src/types/plugin-exposure.ts — NEW FILE

export type PluginExposureData =
  | PluginEnvExposure
  | PluginGitCredentialHelperExposure
  | PluginGcloudExternalAccountExposure
  | PluginLocalhostProxyExposure;

export interface PluginEnvExposure {
  kind: 'env';
  entries: Array<{ key: string; value: string }>;
}

export interface PluginGitCredentialHelperExposure {
  kind: 'git-credential-helper';
  host: string;
  protocol: string;
  username: string;
  password: string;
}

export interface PluginGcloudExternalAccountExposure {
  kind: 'gcloud-external-account';
  audience: string;
  subjectTokenType: string;
  tokenUrl: string;
  serviceAccountImpersonationUrl?: string;
}

export interface PluginLocalhostProxyExposure {
  kind: 'localhost-proxy';
  upstream: string;
  headers: Record<string, string>;
}
```

### Updated Plugin Interface

```typescript
// packages/credhelper/src/types/plugin.ts — MODIFIED

export interface CredentialTypePlugin {
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
  ): PluginExposureData;  // CHANGED: was ExposureOutput
}
```

## Plugin Schemas

### github-app

```typescript
const credentialSchema = z.object({
  appId: z.number().int().positive(),
  installationId: z.number().int().positive(),
});

const scopeSchema = z.object({
  repositories: z.array(z.string()).optional(),
  permissions: z.record(z.string()).optional(),
});
```

### github-pat

```typescript
const credentialSchema = z.object({}).passthrough();
// No scopeSchema — PATs are pre-scoped
```

### gcp-service-account

```typescript
const credentialSchema = z.object({
  serviceAccountEmail: z.string().email(),
  projectId: z.string().optional(),
});

const scopeSchema = z.object({
  scopes: z.array(z.string()).min(1),
});
```

### aws-sts

```typescript
const credentialSchema = z.object({
  roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/.+$/),
  externalId: z.string().optional(),
  region: z.string().optional(),
});

const scopeSchema = z.object({
  sessionPolicy: z.record(z.unknown()).optional(),
  durationSeconds: z.number().int().min(900).max(43200).optional(),
});
```

### stripe-restricted-key

```typescript
const credentialSchema = z.object({}).passthrough();
// No scopeSchema — restricted keys are pre-scoped
```

### api-key

```typescript
const credentialSchema = z.object({
  upstream: z.string().url().optional(),  // for localhost-proxy exposure
}).passthrough();
// No scopeSchema
```

### env-passthrough

```typescript
const credentialSchema = z.object({}).passthrough();
// No scopeSchema — backendKey IS the env var name (Q5)
```

## Plugin-to-Exposure Mapping

| Plugin | env | git-credential-helper | gcloud-external-account | localhost-proxy |
|--------|-----|-----------------------|------------------------|----------------|
| github-app | `GITHUB_TOKEN=<token>` | `{host, protocol, user, pass}` | — | — |
| github-pat | `GITHUB_TOKEN=<token>` | `{host, protocol, user, pass}` | — | — |
| gcp-service-account | `CLOUDSDK_AUTH_ACCESS_TOKEN=<token>` | — | `{audience, tokenUrl, ...}` | — |
| aws-sts | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | — | — | — |
| stripe-restricted-key | `STRIPE_API_KEY=<key>` | — | — | — |
| api-key | `{cfg.name}=<key>` | — | — | `{upstream, headers}` |
| env-passthrough | `{cfg.name}=<value>` | — | — | — |

## Config Extraction Logic

When building `MintContext` / `ResolveContext`, the session-manager strips these common fields from the credential entry before passing the rest as `config`:

**Common fields (excluded from config)**:
- `id` → `credentialId`
- `type` → used for plugin lookup
- `backend` → used to load `BackendClient`
- `backendKey` → `backendKey`
- `mint` → `ttl` extracted and converted

**Remaining fields → `config`**:
```typescript
const { id, type, backend, backendKey, mint, ...config } = credentialEntry;
```

## Credential Lifecycle per Plugin

| Plugin | Method | Secret Source | TTL | Refresh |
|--------|--------|--------------|-----|---------|
| github-app | mint | Backend (private key) → GitHub API (token) | Per mint config (default 1h) | 75% TTL |
| github-pat | resolve | Backend (PAT) | 24h (daemon default) | None |
| gcp-service-account | mint | Backend (SA key) → GCP IAM API (access token) | Per mint config (default 1h) | 75% TTL |
| aws-sts | mint | Backend (base creds) → STS API (session creds) | Per scope durationSeconds or mint config | 75% TTL |
| stripe-restricted-key | resolve | Backend (restricted key) | 24h (daemon default) | None |
| api-key | resolve | Backend (API key) | 24h (daemon default) | None |
| env-passthrough | resolve | env backend → `process.env` | 24h (daemon default) | None |

---

*Generated by speckit*
