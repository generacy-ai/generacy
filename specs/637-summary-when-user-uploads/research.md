# Research: Boot-render uploaded file blobs

**Feature**: #637 | **Date**: 2026-05-16

## Existing Pattern Analysis

### AppConfigSecretEnvStore.renderAll() (#632)

The direct precedent. At boot, `renderAll()`:
1. Returns early if store is `disabled`
2. Reads metadata via `this.fileStore.getMetadata()` to enumerate secret env var names
3. Iterates: for each secret entry, calls `backend.fetchSecret("app-config/env/${name}")`
4. Collects successes and failures separately (best-effort)
5. Writes combined result atomically under promise-chain mutex
6. Returns `{ rendered: string[], failed: string[] }`

Called from `bin/control-plane.ts` after all stores are initialized, before `server.start()`.

**Key difference for files**: Secret env vars are all written to a single `secrets.env` file. File blobs each have their own `mountPath`, so rendering is per-file (no batch write). This means no `withLock()` needed — each file is independent.

### Atomic Write Pattern

Used consistently across all stores:
```
mkdir -p dirname → open tmp file → writeFile → datasync → close → rename
```

File mode: `0o640` (owner rw, group r, world none). This matches `setFile()` exactly.

### Denylist Check

`isPathDenied()` in `app-config.ts` checks 13 system prefixes. Currently not exported — needs `export` keyword. No logic change.

### Manifest Resolution

`readManifest()` reads `cluster.yaml` from the `.agency/` (resolved via `resolveGeneracyDir()`), parses YAML, extracts `appConfig` section, validates with `AppConfigSchema`. Returns `null` on ENOENT or missing section.

The manifest's `files` array contains `{ id, description?, mountPath, required }` entries. The `mountPath` is the canonical path — boot render uses the current manifest's path, not whatever was stored at upload time.

## Alternatives Considered

### A1: New AppConfigFileRenderService class

**Rejected**: Over-engineering for ~40 lines of logic. The file store already has the backend reference, metadata reader, and atomic write code. Adding a method to the existing class follows the secret env store pattern exactly.

### A2: Store mountPath in values.yaml metadata

**Rejected**: The spec explicitly says to use the *current* manifest's mountPath (FR-004), not the path stored at upload time. This allows manifest updates to take effect on restart.

### A3: Import readManifest() directly into file store

**Rejected**: Creates coupling between the store (pure data operations) and the manifest reading logic (yaml parsing, directory resolution). Callback injection is cleaner and more testable.

### A4: Render files in the lifecycle bootstrap-complete handler

**Rejected**: Boot render must happen on every daemon start, not just after bootstrap-complete. The daemon could restart due to OOM, crash, or manual `docker compose restart` — all should re-render files.

## Implementation Patterns

### Pattern: Best-effort boot render with structured logging

Same pattern used by:
- `AppConfigSecretEnvStore.renderAll()` — renders secret env vars
- `writeWizardEnvFile()` (#589) — unseals wizard credentials
- `AppConfigEnvStore.init()` — fallback chain with status tracking

Core principle: **one bad entry must not prevent other entries from rendering or the daemon from starting**.

### Pattern: Init result surfacing

From #624: each store reports `StoreInitResult { status, path?, reason? }`. The file render result is added to `initResult.warnings[]` (not a new store entry). This matches how the secret env render is reported.

## Dependencies

- `@generacy-ai/credhelper` — `ClusterLocalBackend.fetchSecret()` (existing)
- `yaml` — metadata parsing (existing)
- `node:fs/promises` — atomic file I/O (existing)
- No new dependencies required
