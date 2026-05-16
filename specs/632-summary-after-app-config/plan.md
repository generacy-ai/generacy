# Implementation Plan: App-Config Secrets Env Renderer

**Feature**: Render app-config secrets to a sibling env file so processes can consume them
**Branch**: `632-summary-after-app-config`
**Status**: Complete

## Summary

After the app-config UI flow (#622) shipped, secret env vars land in the encrypted `ClusterLocalBackend` but are never rendered to a file that running processes can source. This feature adds a new `AppConfigSecretEnvStore` that maintains `/run/generacy-app-config/secrets.env` (tmpfs) as a derived view of encrypted secrets, re-rendered at boot and updated on every PUT/DELETE.

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Package**: `packages/control-plane` (primary), minor type changes in `packages/orchestrator`
- **Dependencies**: `@generacy-ai/credhelper` (ClusterLocalBackend), `yaml` (metadata), `node:fs/promises`, `node:path`
- **Patterns**: Follows `AppConfigEnvStore` exactly — fallback chain (#624), atomic writes (temp+rename), in-process promise-chain mutex, `StoreStatus` reporting via `init-result.json`

## Project Structure

### New Files

```
packages/control-plane/
  src/services/app-config-secret-env-store.ts   # Core store: render/update/delete secrets.env
```

### Modified Files

```
packages/control-plane/
  bin/control-plane.ts                          # Init new store, aggregate into InitResult
  src/routes/app-config.ts                      # Wire secret transitions on PUT/DELETE
  src/types/init-result.ts                      # (no schema change — InitResult.stores is Record<string, ...>)

packages/orchestrator/
  src/types/relay.ts                            # Document new store key in ClusterMetadataPayload comment
```

## Design

### AppConfigSecretEnvStore

A new store class mirroring `AppConfigEnvStore` with identical patterns:

- **Preferred path**: `/run/generacy-app-config/secrets.env` (tmpfs mount from cluster-base#38)
- **Fallback path**: `/tmp/generacy-app-config/secrets.env`
- **Disabled mode**: Encryped backend still stores secrets; file just isn't rendered
- **File format**: `KEY="escaped_value"\n` — same escaping as `AppConfigEnvStore`
- **Permissions**: mode `0640`, owned by `node:node` (same process uid)
- **Atomicity**: temp file (`${path}.tmp.${process.pid}`) + `datasync()` + `rename()`
- **Serialization**: In-process promise-chain mutex (`withLock()`)

### Initialization Flow

At control-plane startup (in `bin/control-plane.ts`):

1. Create `AppConfigSecretEnvStore` with reference to `ClusterLocalBackend`
2. Call `init()` — tries preferred path, falls back, or enters disabled mode
3. Call `renderAll()` — walks `values.yaml` metadata for `secret: true` entries, fetches each from backend, writes combined file
4. Log structured init event: `{ event: 'store-init', store: 'appConfigSecretEnv', status, path?, reason? }`
5. Add to `InitResult.stores['appConfigSecretEnv']`

### PUT /app-config/env Handler Changes

The existing handler branches on `secret` flag. New logic for secret-flag transitions (per clarification Q1):

| Prior `secret` | New `secret` | Actions |
|---|---|---|
| absent | `true` | Write to backend + render to secrets.env (new) |
| absent | `false` | Write to plaintext env (existing) |
| `true` → `false` | transition | Write plaintext env; delete from backend; remove from secrets.env |
| `false` → `true` | transition | Write to backend; render to secrets.env; remove from plaintext env |
| same | same | Overwrite in current location |

**Ordering** (per clarification): write new location first, delete old location second, update metadata last. All under the same advisory lock.

### DELETE /app-config/env/:name Handler Changes

- Check metadata `secret` flag
- If secret: call `secretEnvStore.delete(name)` in addition to `backend.deleteSecret()`
- If non-secret: existing `envStore.delete()` (unchanged)
- Delete metadata entry (unchanged)

### Boot-Time Render

`renderAll()` method on `AppConfigSecretEnvStore`:
1. Read `values.yaml` metadata via `AppConfigFileStore.getMetadata()`
2. Filter for entries where `secret === true`
3. For each, call `ClusterLocalBackend.fetchSecret('app-config/env/${name}')`
4. Collect into `Map<string, string>`, call `writeAll()`
5. Best-effort: skip entries that fail to unseal (log warning per entry), write partial file

### Status Reporting

- `getStatus()` / `getInitResult()` — same interface as other stores
- Surfaced in `init-result.json` under key `appConfigSecretEnv`
- Orchestrator reads it via existing `collectMetadata()` logic (no code change needed — it iterates `parsed.stores` dynamically)
- Cloud UI can display degraded state

## Key Decisions

1. **Separate file, not merged**: Secrets go to `/run/generacy-app-config/secrets.env`, not into the existing plaintext `/var/lib/generacy-app-config/env`. This keeps plaintext secrets off persistent volumes.
2. **Fallback chain over strict dependency**: Matching #624 pattern. Feature works (degraded) even before cluster-base#38 ships.
3. **Bidirectional secret-flag transitions**: PUT handler detects flag changes and cleans up old storage location automatically. No stale state accumulation.
4. **Same escaping/format**: Docker Compose `env_file:` compatible. Processes can `source` both files identically.
5. **Best-effort boot render**: Partial unseal failures produce partial file + warning, not a crash. Matches wizard-env-writer pattern.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| cluster-base#38 not deployed → no tmpfs mount | Fallback to `/tmp/` with WARN log |
| Concurrent PUT + boot render race | In-process promise-chain serializes all writes |
| Backend unseal failure at boot | Best-effort partial render; structured warning in initResult |
| Secret-flag transition leaves stale entry | Write-new-first, delete-old-second ordering; metadata updated last |

## Out of Scope

- Merging secrets into the plaintext env file (rejected per spec trade-off analysis)
- Credhelper session-level secret exposure (orthogonal mechanism)
- Cloud-side UI for degraded secret-env state (reads existing `initResult` structure)
- cluster-base/cluster-microservices tmpfs mount (companion issue #38)
