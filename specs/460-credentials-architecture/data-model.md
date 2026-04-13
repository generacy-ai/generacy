# Data Model: Credhelper Plugin Loader

## New Types (loader-specific)

### LoaderConfig

Configuration passed to the loader function at boot time.

```typescript
interface LoaderConfig {
  /** Paths to core plugin directories (trusted by path, no pin required) */
  corePaths: string[];
  /** Paths to community plugin directories (require SHA256 pin verification) */
  communityPaths: string[];
  /** Map of plugin package name → expected SHA256 hex digest (from trusted-plugins.yaml) */
  trustedPins: Map<string, string>;
}
```

**Default values** (caller provides, not hardcoded in loader):
- `corePaths`: `['/usr/local/lib/generacy-credhelper/']`
- `communityPaths`: `['.agency/secrets/plugins/node_modules/']`
- `trustedPins`: parsed from `.agency/secrets/trusted-plugins.yaml` via `TrustedPluginsSchema`

### DiscoveredPlugin

Metadata for a plugin found during discovery, before loading.

```typescript
interface DiscoveredPlugin {
  /** Package name (e.g., 'generacy-credhelper-plugin-vault') */
  name: string;
  /** Absolute path to the plugin package directory */
  path: string;
  /** Absolute path to the entry point file (resolved from manifest.main) */
  entryPoint: string;
  /** Credential type this plugin handles (from manifest) */
  type: string;
  /** Plugin version (from manifest) */
  version: string;
  /** Whether this plugin was found in a core path (trusted) or community path */
  isCore: boolean;
}
```

### PluginManifest

The `credhelperPlugin` field from a plugin's package.json.

```typescript
interface PluginManifest {
  /** Credential type identifier (e.g., 'vault', 'github-app') */
  type: string;
  /** Semver version of the plugin */
  version: string;
  /** Relative path to the entry point (e.g., './dist/index.js') */
  main: string;
}
```

## Existing Types (from Phase 1, consumed by loader)

### CredentialTypePlugin

The interface that every loaded plugin must implement. Defined in `packages/credhelper/src/types/plugin.ts`.

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

### TrustedPluginsSchema

Zod schema for `trusted-plugins.yaml`. Defined in `packages/credhelper/src/schemas/trusted-plugins.ts`.

```typescript
// Parsed shape:
{
  schemaVersion: '1',
  plugins: Record<string, { sha256: string }>
}
```

**Relationship**: The loader caller parses `trusted-plugins.yaml` with this schema, then converts the `plugins` record into the `trustedPins: Map<string, string>` that `LoaderConfig` expects.

## Data Flow

```
trusted-plugins.yaml ──parse──→ TrustedPluginsSchema ──convert──→ trustedPins (Map)
                                                                        │
corePaths ──scan──→ DiscoveredPlugin[] (isCore=true)  ──────────────────┤
communityPaths ──scan──→ DiscoveredPlugin[] (isCore=false) ─────────────┤
                                                                        ▼
                                                            loadCredentialPlugins()
                                                                        │
                                                          ┌─────────────┼─────────────┐
                                                          ▼             ▼             ▼
                                                      discover()   verify()    validate()
                                                          │             │             │
                                                          ▼             ▼             ▼
                                                    DiscoveredPlugin[]  │    CredentialTypePlugin
                                                                       │             │
                                                                       ▼             ▼
                                                            Map<string, CredentialTypePlugin>
                                                                        │
                                                                        ▼
                                                              Returned to daemon (#461)
```

## Validation Rules

| Field | Rule | Error |
|-------|------|-------|
| `PluginManifest.type` | Non-empty string | `Plugin '{name}' manifest missing 'type' field` |
| `PluginManifest.version` | Non-empty string | `Plugin '{name}' manifest missing 'version' field` |
| `PluginManifest.main` | Non-empty string, file exists | `Plugin '{name}' entry point not found: {path}` |
| `CredentialTypePlugin.type` | Non-empty string, matches manifest type | `Plugin '{name}' type mismatch: manifest says '{a}', export says '{b}'` |
| `CredentialTypePlugin.credentialSchema` | Has `.parse` method (Zod schema) | `Plugin '{name}' credentialSchema is not a valid Zod schema` |
| `CredentialTypePlugin.scopeSchema` | If present, has `.parse` method | `Plugin '{name}' scopeSchema is not a valid Zod schema` |
| `CredentialTypePlugin.supportedExposures` | Non-empty array of ExposureKind values | `Plugin '{name}' supportedExposures must be a non-empty array of valid exposure kinds` |
| `CredentialTypePlugin.renderExposure` | Function | `Plugin '{name}' missing renderExposure function` |
| SHA256 pin (community only) | Matches trustedPins entry | See error table in plan.md |
| Type uniqueness | No two plugins share same `type` | `Duplicate credential type '{type}'` |
