# Data Model: Boot-render uploaded file blobs

**Feature**: #637 | **Date**: 2026-05-16

## Existing Types (no changes)

### AppConfigValuesMetadata (values.yaml)

Source: `packages/control-plane/src/services/app-config-file-store.ts:22-25`

```typescript
interface AppConfigValuesMetadata {
  env: Record<string, AppConfigEnvMetadata>;
  files: Record<string, AppConfigFileMetadata>;
}

interface AppConfigFileMetadata {
  updatedAt: string;  // ISO 8601
  size: number;       // bytes
}
```

The `files` record maps file IDs to metadata. This is the source of truth for which files have been uploaded.

### AppConfig (manifest from cluster.yaml)

Source: `packages/control-plane/src/schemas.ts:146-151`

```typescript
// Zod schema
const AppConfigSchema = z.object({
  schemaVersion: z.literal('1'),
  env: z.array(AppConfigEnvEntrySchema).default([]),
  files: z.array(AppConfigFileEntrySchema).default([]),
});

const AppConfigFileEntrySchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  mountPath: z.string().min(1),
  required: z.boolean().default(true),
});
```

### Backend Key Convention

File blobs stored under key: `app-config/file/${id}` (base64-encoded).

### StoreStatus / InitResult

Source: `packages/control-plane/src/types/init-result.ts`

```typescript
type StoreStatus = 'ok' | 'fallback' | 'disabled';

interface StoreInitResult {
  status: StoreStatus;
  path?: string;
  reason?: string;
}

interface InitResult {
  stores: Record<string, StoreInitResult>;
  warnings: string[];
}
```

## New Types

### FileRenderResult

Returned by `AppConfigFileStore.renderAll()`. Identical shape to `RenderResult` from `AppConfigSecretEnvStore`:

```typescript
interface FileRenderResult {
  rendered: string[];  // file IDs successfully written to mountPath
  failed: string[];    // file IDs that were skipped (with reason logged)
}
```

**Note**: Could reuse `RenderResult` from `app-config-secret-env-store.ts` via import, but to avoid coupling between stores, define locally or use inline `{ rendered: string[]; failed: string[] }` return type.

## Data Flow: Boot-Time File Render

```
bin/control-plane.ts
  │
  ├─ appConfigFileStore.init()        // Ensure values.yaml dir exists
  ├─ appConfigSecretEnvStore.renderAll()  // Existing: render secret env vars
  │
  └─ appConfigFileStore.renderAll(readManifest)
       │
       ├─ this.readMetadata()                    // Read values.yaml → files record
       ├─ readManifest()                         // Read cluster.yaml → AppConfig
       │
       └─ for each id in metadata.files:
            ├─ manifest.files.find(f => f.id === id)  // Lookup mountPath
            ├─ isPathDenied(mountPath)                 // Denylist check
            ├─ backend.fetchSecret(`app-config/file/${id}`)  // Decrypt blob
            ├─ Buffer.from(base64, 'base64')           // Decode
            └─ atomicWriteFile(mountPath, data)        // temp → datasync → rename
```

## Structured Log Events

### files-rendered (new)

Emitted once per boot, after all files processed:

```json
{ "event": "files-rendered", "count": 2, "skipped": 1 }
```

### Per-file warnings (existing pattern)

```
[app-config-file] Skipping orphaned file 'gcp-sa-json': not in current manifest
[app-config-file] Skipping file 'gcp-sa-json': mountPath '/etc/shadow' is denylisted
[app-config-file] Failed to render file 'gcp-sa-json': ENOENT: no such key
```
