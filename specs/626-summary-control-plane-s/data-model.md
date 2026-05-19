# Data Model: #626 Manifest Response Contract

## Response Shape: `GET /app-config/manifest`

### Correct (after fix)

When manifest exists:
```json
{
  "schemaVersion": "1",
  "env": [
    { "name": "TEST_VAR", "secret": true }
  ],
  "files": [
    { "id": "sa-key", "mountPath": "/tmp/sa.json" }
  ]
}
```

When manifest is absent (`cluster.yaml` missing or has no `appConfig` key):
```json
null
```

### Broken (before fix)

```json
{
  "appConfig": {
    "schemaVersion": "1",
    "env": [...],
    "files": [...]
  }
}
```

Or:
```json
{
  "appConfig": null
}
```

## Type Definition

From `packages/control-plane/src/schemas.ts`:

```ts
// AppConfig is the Zod-inferred type from AppConfigSchema
type AppConfig = {
  schemaVersion: string;
  env?: Array<{ name: string; secret?: boolean }>;
  files?: Array<{ id: string; mountPath: string }>;
};
```

The handler return type is `AppConfig | null` — serialized directly via `JSON.stringify()`.

## Cloud-Side Schema (reference)

The cloud validates with `appConfigManifestSchema` which expects:
- Top-level `schemaVersion` (string)
- Top-level `env` (array)
- Top-level `files` (array)

No envelope wrapper.
