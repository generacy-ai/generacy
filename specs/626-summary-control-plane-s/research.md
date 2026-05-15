# Research: #626 Control-plane manifest envelope mismatch

## Root Cause

`packages/control-plane/src/routes/app-config.ts:111` wraps the return value:

```ts
res.end(JSON.stringify({ appConfig }));
// Produces: { "appConfig": { "schemaVersion": "1", "env": [...], "files": [...] } }
// Or:       { "appConfig": null }
```

The cloud's `appConfigManifestSchema` expects the bare shape:
```ts
// Expected: { "schemaVersion": "1", "env": [...], "files": [...] }
// Or:       null
```

## Why This Happened

The `readManifest()` function extracts `appConfig` from within `cluster.yaml`'s parsed YAML. The handler author likely re-wrapped it by habit (common pattern in Express-style APIs), not realizing the cloud schema expects the raw output.

## Inconsistency Evidence

The sibling handler `handleGetValues` (same file, line 157) returns the bare shape:
```ts
res.end(JSON.stringify({ env: envEntries, files: fileEntries }));
```

No envelope wrapping — confirming the convention is bare responses.

## Knock-on Effects

1. **AppConfigStep TypeError** — `manifest.env.length` crashes because `manifest` is `{ appConfig: {...} }`, which has no `.env` property.
2. **Silent cache failure** — cloud's `appConfigManifestSchema.safeParse()` rejects the envelope, so manifests are never cached on the project Firestore doc.

## Fix Confidence: High

- Single-line change with clear before/after
- `readManifest()` return type is already correct (`AppConfig | null`)
- No upstream changes needed
- Cloud companion defensive unwrap (generacy-cloud#588) becomes a no-op
