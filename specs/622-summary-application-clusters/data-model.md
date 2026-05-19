# Data Model: App Config & File Exposure

## Core Schemas

### AppConfigSchema (new)

```typescript
// packages/generacy/src/cli/commands/cluster/context.ts (extended)
// Also exported from packages/control-plane/src/schemas.ts

const AppConfigEnvEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  secret: z.boolean().default(false),
  default: z.string().optional(),
  required: z.boolean().default(true),
});

const AppConfigFileEntrySchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  mountPath: z.string().min(1),
  required: z.boolean().default(true),
});

const AppConfigSchema = z.object({
  schemaVersion: z.literal('1'),
  env: z.array(AppConfigEnvEntrySchema).default([]),
  files: z.array(AppConfigFileEntrySchema).default([]),
});

// Extended ClusterYamlSchema
const ClusterYamlSchema = z.object({
  channel: z.enum(['stable', 'preview']).default('stable'),
  workers: z.number().int().positive().default(1),
  variant: z.enum(['cluster-base', 'cluster-microservices']).default('cluster-base'),
  appConfig: AppConfigSchema.optional(),
});
```

### Exposure Schema Extensions

```typescript
// packages/credhelper/src/schemas/exposure.ts — new variant

// ExposureConfigSchema gains:
z.object({
  kind: z.literal('file'),
  path: z.string(),           // Absolute path to write the file
  mode: z.number().optional(), // Unix file mode (default 0o640)
})

// ExposureOutputSchema gains:
z.object({
  kind: z.literal('file'),
  data: z.string(),           // Raw file content (decoded from base64)
  path: z.string(),
  mode: z.number(),
})
```

### Role Expose Extension

```typescript
// packages/credhelper/src/schemas/roles.ts — extended RoleExpose

const RoleExposeSchema = z.discriminatedUnion('as', [
  // ... existing variants ...
  z.object({
    as: z.literal('file'),
    path: z.string(),           // Absolute mount path
    mode: z.number().optional(), // Default 0o640
  }),
]);
```

### Plugin Exposure Type Extension

```typescript
// packages/credhelper/src/types/plugin-exposure.ts — new variant

interface PluginFileExposure {
  kind: 'file';
  data: Buffer;     // Decoded file content
  path: string;     // Absolute target path
  mode?: number;    // Default 0o640
}

// PluginExposureData union gains PluginFileExposure
type PluginExposureData =
  | PluginEnvExposure
  | PluginGitCredentialHelperExposure
  | PluginGcloudExternalAccountExposure
  | PluginLocalhostProxyExposure
  | PluginFileExposure;
```

## Control-Plane Data Structures

### App Config Env File

```
# /var/lib/generacy-app-config/env
# Format: KEY="escaped_value"
SERVICE_ANTHROPIC_API_KEY="sk-ant-..."
LIVEKIT_URL="wss://my-project.livekit.cloud"
LIVEKIT_API_KEY="APIxxxxxxx"
```

- Atomic rewrite (temp + fsync + rename)
- Advisory lock file: `/var/lib/generacy-app-config/env.lock`
- Owned by `credhelper:node` (uid 1002:gid 1000), mode `0640`

### App Config Values Metadata

```typescript
// Stored in /var/lib/generacy-app-config/values.yaml
interface AppConfigValuesMetadata {
  env: Record<string, {
    secret: boolean;
    updatedAt: string; // ISO 8601
  }>;
  files: Record<string, {
    updatedAt: string; // ISO 8601
    size: number;      // bytes
  }>;
}
```

### Request/Response Schemas

```typescript
// PUT /app-config/env
const PutAppConfigEnvBodySchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  secret: z.boolean().default(false),
});

// POST /app-config/files/:id
// Body: { data: string } where data is base64-encoded

const PostAppConfigFileBodySchema = z.object({
  data: z.string(), // base64
});

// GET /app-config/manifest response
interface ManifestResponse {
  appConfig: AppConfig | null;
}

// GET /app-config/values response
interface ValuesResponse {
  env: Array<{ name: string; secret: boolean; updatedAt: string; inManifest: boolean }>;
  files: Array<{ id: string; updatedAt: string; size: number }>;
}
```

## Credential-File Plugin

```typescript
// Plugin type identifier
const CREDENTIAL_FILE_TYPE = 'credential-file';

// Credential config schema
const CredentialFileConfigSchema = z.object({
  // No additional config — the backend stores a base64 blob
});

// Supported exposures
const supportedExposures = ['file'] as const;

// resolve() returns the base64-decoded blob as an opaque secret
// renderExposure('file') returns PluginFileExposure with decoded data
```

## File Path Denylist

```typescript
const DENIED_PREFIXES = [
  '/etc/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/proc/',
  '/sys/',
  '/dev/',
  '/boot/',
  '/run/generacy-credhelper/',
  '/var/lib/generacy-credhelper/',
  '/run/generacy-control-plane/',
] as const;

// Also deny root '/' itself (path must be in a subdirectory)
```

## Relationships

```
cluster.yaml (appConfig:)
  ├── env[] ──────────── GET /app-config/manifest
  │     └── name ────── PUT /app-config/env (permissive: accepts unlisted names)
  │                      └── secret:true → ClusterLocalBackend (encrypted)
  │                      └── secret:false → /var/lib/generacy-app-config/env (plaintext)
  └── files[] ────────── GET /app-config/manifest
        ├── id ──────── POST /app-config/files/:id (strict: must be in manifest)
        └── mountPath ── File written to this path on PUT, persists across sessions

.agency/roles/*.yaml (role-driven)
  └── credentials[].expose[as:'file']
        └── path ────── Session-scoped file, wiped on session end
```
