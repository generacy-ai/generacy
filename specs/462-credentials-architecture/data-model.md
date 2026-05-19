# Data Model: Config File Loading & Validation

## New Types (Phase 2)

### ConfigError

A single validation error with file and field context. All validation functions accumulate errors into a shared array of these.

```typescript
interface ConfigError {
  file: string;                           // absolute path to the file with the error
  field?: string;                         // dot-path to the field (e.g., "credentials[id=gh-token].backend")
  message: string;                        // human-readable description
  source?: 'committed' | 'overlay';       // distinguishes credentials.yaml vs credentials.local.yaml
}
```

### ConfigValidationError

Thrown when one or more validation errors are collected. Contains all errors in a single batch.

```typescript
class ConfigValidationError extends Error {
  readonly errors: ConfigError[];

  constructor(errors: ConfigError[]) {
    const summary = errors.map(e =>
      `  ${e.file}${e.field ? `:${e.field}` : ''}: ${e.message}`
    ).join('\n');
    super(`Config validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${summary}`);
    this.errors = errors;
    this.name = 'ConfigValidationError';
  }
}
```

### LoadConfigOptions

Input options for the `loadConfig()` entry point.

```typescript
interface LoadConfigOptions {
  /** Path to the .agency/ directory */
  agencyDir: string;

  /**
   * Optional plugin registry mapping credential type → supported exposure kinds.
   * When provided, validates that role exposure requests are supported by the credential's plugin.
   * When absent, exposure-against-plugin validation is skipped (C1).
   */
  pluginRegistry?: Map<string, ExposureKind[]>;

  /**
   * Optional logger for overlay reporting.
   * When provided, logs which credential ids came from the overlay file.
   */
  logger?: { info(msg: string): void };
}
```

### ConfigResult

The successful output of `loadConfig()`. Contains all validated and resolved configuration.

```typescript
interface ConfigResult {
  /** Validated backends configuration */
  backends: BackendsConfig;

  /** Validated and merged credentials (overlay applied) */
  credentials: CredentialsConfig;

  /** Validated trusted plugins config, or null if file doesn't exist */
  trustedPlugins: TrustedPluginsConfig | null;

  /** Fully resolved roles (extends inheritance applied), keyed by role id */
  roles: Map<string, RoleConfig>;

  /** Credential ids that came from the overlay file (for audit/logging) */
  overlayIds: string[];
}
```

## Existing Types Used (from Phase 1)

### BackendsConfig

```typescript
// From src/schemas/backends.ts
type BackendsConfig = {
  schemaVersion: '1';
  backends: BackendEntry[];
};

type BackendEntry = {
  id: string;
  type: string;
  endpoint?: string;
  auth?: { mode: string; [key: string]: unknown };
};
```

### CredentialsConfig

```typescript
// From src/schemas/credentials.ts
type CredentialsConfig = {
  schemaVersion: '1';
  credentials: CredentialEntry[];
};

type CredentialEntry = {
  id: string;
  type: string;
  backend: string;
  backendKey: string;
  mint?: { ttl: string; scopeTemplate?: Record<string, unknown> };
};
```

### RoleConfig

```typescript
// From src/schemas/roles.ts
type RoleConfig = {
  schemaVersion: '1';
  id: string;
  description: string;
  extends?: string;
  credentials: RoleCredentialRef[];
  proxy?: Record<string, ProxyConfig>;
  docker?: DockerConfig;
};

type RoleCredentialRef = {
  ref: string;
  scope?: Record<string, unknown>;
  expose: RoleExpose[];
};

type RoleExpose = {
  as: 'env' | 'git-credential-helper' | 'gcloud-external-account' | 'localhost-proxy' | 'docker-socket-proxy';
  name?: string;
  port?: number;
};
```

### TrustedPluginsConfig

```typescript
// From src/schemas/trusted-plugins.ts
type TrustedPluginsConfig = {
  schemaVersion: '1';
  plugins: Record<string, { sha256: string }>;
};
```

### ExposureKind

```typescript
// From src/types/exposure.ts
type ExposureKind =
  | 'env'
  | 'git-credential-helper'
  | 'gcloud-external-account'
  | 'localhost-proxy'
  | 'docker-socket-proxy';
```

## Entity Relationships

```
LoadConfigOptions
  ├── agencyDir ──► filesystem (.agency/)
  ├── pluginRegistry? ──► Map<credType, ExposureKind[]>
  └── logger?

loadConfig(options) ──► ConfigResult | throws ConfigValidationError

ConfigResult
  ├── backends: BackendsConfig
  │     └── backends[].id ◄── credentials[].backend (validated)
  │
  ├── credentials: CredentialsConfig (overlay merged)
  │     ├── credentials[].id ◄── roles[].credentials[].ref (validated)
  │     ├── credentials[].backend ──► backends[].id (validated)
  │     └── credentials[].type ──► pluginRegistry key (validated when registry present)
  │
  ├── trustedPlugins: TrustedPluginsConfig | null
  │     └── plugins[name].sha256 (consumed by plugin loader #460)
  │
  ├── roles: Map<string, RoleConfig> (extends resolved)
  │     ├── role.extends ──► parent role.id (resolved and removed)
  │     └── role.credentials[].expose[].as ──► pluginRegistry[type] (validated when registry present)
  │
  └── overlayIds: string[] (audit trail)

ConfigValidationError
  └── errors: ConfigError[]
        ├── file (which .yaml file)
        ├── field? (which field path)
        ├── message (what went wrong)
        └── source? (committed vs overlay)
```

## Validation Rules (Cross-Reference)

| Rule | Source | Target | Error when |
|------|--------|--------|-----------|
| Credential→Backend | `CredentialEntry.backend` | `BackendEntry.id` | Backend id not found in backends.yaml |
| Role→Credential | `RoleCredentialRef.ref` | `CredentialEntry.id` | Credential id not found in merged credentials |
| Role→Role (extends) | `RoleConfig.extends` | `RoleConfig.id` | Parent role not found; circular chain detected |
| Exposure→Plugin | `RoleExpose.as` | `CredentialTypePlugin.supportedExposures` | Exposure kind not in plugin's supported list (only when registry provided) |

## File Loading Matrix

| File | Path | Required | Schema | Notes |
|------|------|----------|--------|-------|
| backends.yaml | `.agency/secrets/backends.yaml` | Yes | `BackendsConfigSchema` | Must exist |
| credentials.yaml | `.agency/secrets/credentials.yaml` | Yes | `CredentialsConfigSchema` | Must exist |
| credentials.local.yaml | `.agency/secrets/credentials.local.yaml` | No | `CredentialsConfigSchema` | Gitignored overlay; merged by id |
| trusted-plugins.yaml | `.agency/secrets/trusted-plugins.yaml` | No | `TrustedPluginsSchema` | Only for non-core plugins |
| roles/*.yaml | `.agency/roles/*.yaml` | No | `RoleConfigSchema` | Directory may not exist (C4) |
