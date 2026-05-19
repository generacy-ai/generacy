# API Contracts: App Config Endpoints

All endpoints are under the control-plane Unix socket, routed via relay as `/control-plane/app-config/*`.

## GET /app-config/manifest

Returns the parsed `appConfig:` section from the cluster's `cluster.yaml`.

**Authentication**: `x-generacy-actor-user-id` header (read-only, but consistent with other endpoints).

**Response 200**:
```json
{
  "appConfig": {
    "schemaVersion": "1",
    "env": [
      { "name": "SERVICE_ANTHROPIC_API_KEY", "secret": true, "description": "Anthropic API key", "required": true },
      { "name": "LIVEKIT_URL", "secret": false, "required": true }
    ],
    "files": [
      { "id": "gcp-sa-json", "mountPath": "/home/node/.config/gcloud/secrets/sa.json", "required": true }
    ]
  }
}
```

**Response 200 (no appConfig)**:
```json
{
  "appConfig": null
}
```

**Response 500** (parse error):
```json
{
  "error": "Failed to parse cluster.yaml",
  "code": "MANIFEST_PARSE_ERROR",
  "details": "..."
}
```

---

## GET /app-config/values

Returns names and metadata for all set values. Never returns secret values.

**Authentication**: `x-generacy-actor-user-id` header.

**Response 200**:
```json
{
  "env": [
    { "name": "SERVICE_ANTHROPIC_API_KEY", "secret": true, "updatedAt": "2026-05-15T10:30:00Z", "inManifest": true },
    { "name": "CUSTOM_VAR", "secret": false, "updatedAt": "2026-05-15T11:00:00Z", "inManifest": false }
  ],
  "files": [
    { "id": "gcp-sa-json", "updatedAt": "2026-05-15T10:35:00Z", "size": 2048 }
  ]
}
```

---

## PUT /app-config/env

Sets an environment variable. Permissive — accepts names not declared in the manifest.

**Authentication**: `x-generacy-actor-user-id` header (required, mutating).

**Request body**:
```json
{
  "name": "SERVICE_ANTHROPIC_API_KEY",
  "value": "sk-ant-api03-...",
  "secret": true
}
```

**Behavior**:
- `secret: true` — Encrypts value in `ClusterLocalBackend` (key: `app-config/env/<name>`). Does NOT write plaintext to env file. Session-start materializes it.
- `secret: false` — Writes to `/var/lib/generacy-app-config/env` as `NAME="value"` (atomic rewrite).
- Both — Updates values metadata file.
- Emits `cluster.app-config` relay event: `{ action: 'env-set', name, secret }`.

**Response 200**:
```json
{
  "accepted": true,
  "name": "SERVICE_ANTHROPIC_API_KEY",
  "secret": true
}
```

**Response 400**:
```json
{
  "error": "name is required",
  "code": "INVALID_REQUEST"
}
```

---

## DELETE /app-config/env/:name

Removes an environment variable.

**Authentication**: `x-generacy-actor-user-id` header (required, mutating).

**Behavior**:
- If secret: deletes from `ClusterLocalBackend`.
- If non-secret: removes line from env file (atomic rewrite).
- Removes from values metadata.
- Emits `cluster.app-config` relay event: `{ action: 'env-deleted', name }`.

**Response 200**:
```json
{
  "accepted": true,
  "name": "SERVICE_ANTHROPIC_API_KEY"
}
```

**Response 404**:
```json
{
  "error": "Environment variable not found",
  "code": "NOT_FOUND"
}
```

---

## POST /app-config/files/:id

Uploads a file blob. Strict — rejects file IDs not declared in the manifest.

**Authentication**: `x-generacy-actor-user-id` header (required, mutating).

**Request body**:
```json
{
  "data": "eyJhY2NvdW50Ijo..."
}
```

Where `data` is the base64-encoded file content.

**Behavior**:
1. Read manifest from `cluster.yaml` to find `mountPath` for `:id`.
2. Validate `:id` exists in manifest — reject with 400 if not.
3. Validate `mountPath` against denylist — reject with 400 if denied.
4. Decode base64.
5. Store encrypted blob in `ClusterLocalBackend` (key: `app-config/file/<id>`).
6. Write decoded content to `mountPath` (atomic: temp + rename, mode `0640`, `credhelper:node`).
7. Create parent directories as needed (`mkdir -p` equivalent).
8. Update values metadata.
9. Emit `cluster.app-config` relay event: `{ action: 'file-set', id, mountPath }`.

**Response 200**:
```json
{
  "accepted": true,
  "id": "gcp-sa-json",
  "mountPath": "/home/node/.config/gcloud/secrets/sa.json",
  "size": 2048
}
```

**Response 400 (undeclared ID)**:
```json
{
  "error": "File ID 'unknown-file' not declared in appConfig.files manifest",
  "code": "INVALID_REQUEST"
}
```

**Response 400 (denied path)**:
```json
{
  "error": "mountPath '/etc/passwd' is in a restricted system directory",
  "code": "INVALID_REQUEST"
}
```

---

## Error Shape

All error responses follow the standard control-plane error shape:

```json
{
  "error": "Human-readable message",
  "code": "ERROR_CODE",
  "details": "optional additional context"
}
```

Codes: `INVALID_REQUEST` (400), `UNAUTHORIZED` (401), `NOT_FOUND` (404), `MANIFEST_PARSE_ERROR` (500), `INTERNAL_ERROR` (500).

---

## Relay Events

Channel: `cluster.app-config`

```json
{ "action": "env-set", "name": "LIVEKIT_URL", "secret": false }
{ "action": "env-deleted", "name": "LIVEKIT_URL" }
{ "action": "file-set", "id": "gcp-sa-json", "mountPath": "/home/node/.config/gcloud/secrets/sa.json" }
```
