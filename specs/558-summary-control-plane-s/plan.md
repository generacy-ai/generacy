# Implementation Plan: Credential Persistence in Control-Plane

**Feature**: Wire `PUT /credentials/:credentialId` to persist credentials via `ClusterLocalBackend`
**Branch**: `558-summary-control-plane-s`
**Status**: Complete

## Summary

The control-plane's `PUT /credentials/:credentialId` handler is a stub that discards incoming credential payloads. This feature extracts `ClusterLocalBackend`, `CredentialFileStore`, and AES-256-GCM crypto helpers from `packages/credhelper-daemon/src/backends/` into the shared `@generacy-ai/credhelper` package (~250 LOC), then wires the control-plane handler to persist secrets to the encrypted file store, write metadata to `.agency/credentials.yaml`, and emit a `cluster.credentials` relay event.

## Technical Context

| Aspect | Value |
|--------|-------|
| **Language/Version** | TypeScript 5.x, Node >= 22 |
| **Runtime** | `node:http` (no framework) |
| **Primary Packages** | `@generacy-ai/credhelper`, `@generacy-ai/control-plane` |
| **Storage** | AES-256-GCM encrypted file store (`/var/lib/generacy/credentials.dat`) + YAML metadata (`.agency/credentials.yaml`) |
| **Testing** | Vitest (unit + integration) |
| **Platform** | Linux (in-cluster, Unix socket) |
| **Constraints** | No new dependencies; no credhelper-daemon HTTP endpoint; atomic writes |

## Project Structure

### Documentation

```text
specs/558-summary-control-plane-s/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # Resolved Q&A
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Types and schemas
└── quickstart.md        # Testing guide
```

### Source Code Changes

```text
packages/credhelper/src/
├── index.ts                      # MODIFY — add barrel exports for extracted modules
├── backends/                     # NEW directory
│   ├── cluster-local-backend.ts  # EXTRACT from credhelper-daemon
│   ├── crypto.ts                 # EXTRACT from credhelper-daemon
│   └── file-store.ts             # EXTRACT from credhelper-daemon

packages/credhelper-daemon/src/backends/
├── cluster-local-backend.ts      # MODIFY — re-export from @generacy-ai/credhelper
├── crypto.ts                     # MODIFY — re-export from @generacy-ai/credhelper
├── file-store.ts                 # MODIFY — re-export from @generacy-ai/credhelper
└── index.ts                      # No change (existing exports still work)

packages/control-plane/
├── package.json                  # No change (already depends on @generacy-ai/credhelper)
└── src/
    ├── routes/
    │   └── credentials.ts        # MODIFY — implement PUT handler + update GET handler
    └── services/
        └── credential-writer.ts  # NEW — orchestrates secret write + YAML metadata + relay event
```

## Architecture

```text
┌──────────────────┐     PUT /credentials/:id      ┌─────────────────────┐
│  Generacy Cloud  │ ────────────────────────────── │  Control-Plane      │
│  (bootstrap      │     (via relay proxy)          │  (Unix socket)      │
│   wizard)        │                                │                     │
└──────────────────┘                                └─────────┬───────────┘
                                                              │
                                              ┌───────────────┼──────────────┐
                                              │               │              │
                                              ▼               ▼              ▼
                                     ┌──────────────┐ ┌─────────────┐ ┌──────────┐
                                     │ ClusterLocal │ │ .agency/    │ │ Relay    │
                                     │ Backend      │ │ credentials │ │ Push     │
                                     │ .setSecret() │ │ .yaml       │ │ Event    │
                                     └──────────────┘ └─────────────┘ └──────────┘
                                     AES-256-GCM       metadata         cluster.
                                     encrypted         (type, backend)  credentials
```

### Request Processing Flow

```text
PUT /credentials/:credentialId
  │
  ├─ 1. requireActor(actor)         → 401 if missing
  ├─ 2. readBody(req) + JSON.parse  → 400 if malformed
  ├─ 3. Zod validate payload        → 400 if invalid
  │
  ├─ 4. backend.setSecret(id, value)
  │     └─ encrypt(value, masterKey) → AES-256-GCM
  │     └─ fileStore.save()          → atomic write (temp+fsync+rename)
  │
  ├─ 5. writeCredentialMetadata(id, { type, backend: 'cluster-local', ... })
  │     └─ read .agency/credentials.yaml
  │     └─ merge entry
  │     └─ atomic write (temp+rename)
  │
  ├─ 6. pushEvent('cluster.credentials', { credentialId, type, status: 'written' })
  │
  └─ 7. res.writeHead(200) + { ok: true }

  On error at step N:
  └─ res.writeHead(500) + { error, code: 'CREDENTIAL_WRITE_FAILED', failedAt: 'step-N-name' }
```

## Implementation Details

### Phase 1: Extract Storage Modules to `@generacy-ai/credhelper`

Move three files from `packages/credhelper-daemon/src/backends/` to `packages/credhelper/src/backends/`:

1. **`crypto.ts`** — `encrypt()`, `decrypt()`, `generateMasterKey()` + `EncryptedEntry` interface. Pure functions, zero internal deps.
2. **`file-store.ts`** — `CredentialFileStore` class. Deps: `crypto.ts` (co-located), `node:fs/promises`, `node:child_process`.
3. **`cluster-local-backend.ts`** — `ClusterLocalBackend` class. Deps: `CredentialFileStore`, `encrypt`/`decrypt`, `WritableBackendClient` (already in credhelper).

Replace the originals in credhelper-daemon with re-exports:

```typescript
// packages/credhelper-daemon/src/backends/crypto.ts
export { encrypt, decrypt, generateMasterKey } from '@generacy-ai/credhelper';
export type { EncryptedEntry } from '@generacy-ai/credhelper';
```

Error handling: `ClusterLocalBackend` currently throws `CredhelperError` (credhelper-daemon's error class). During extraction, replace with a simple `Error` subclass or accept a generic error pattern. The backend only throws for `BACKEND_SECRET_NOT_FOUND` and `CREDENTIAL_STORE_CORRUPT` — both are simple error codes that can be represented without the full `CredhelperError` class.

### Phase 2: Implement `credential-writer.ts` Service

New service module in control-plane following the `default-role-writer.ts` pattern:

```typescript
export interface WriteCredentialOptions {
  credentialId: string;
  type: string;
  value: string;
  agencyDir: string;
}

export async function writeCredential(options: WriteCredentialOptions): Promise<void> {
  // 1. Persist secret via ClusterLocalBackend
  // 2. Write metadata to .agency/credentials.yaml (atomic YAML write)
  // 3. Emit relay event
}
```

The `ClusterLocalBackend` instance is initialized once at server startup (in `bin/control-plane.ts` or lazy on first request) with default paths (`/var/lib/generacy/credentials.dat`, `/var/lib/generacy/master.key`).

### Phase 3: Wire Credential Route Handlers

**`handlePutCredential`**: Parse body, validate with Zod schema, call `writeCredential()`, emit relay event, return 200 or 500 with `failedAt`.

**`handleGetCredential`**: Read `.agency/credentials.yaml`, find entry by ID, return metadata (not the secret value). Replace current stub with real YAML lookup.

### Initialization

`ClusterLocalBackend.init()` must be called before handling requests. Two options:

- **Eager**: Call `init()` in `bin/control-plane.ts` before server listen. Fail-fast if master key is unavailable.
- **Lazy**: Call `init()` on first credential write. Simpler but defers errors.

Decision: **Eager** — matches credhelper-daemon pattern. Control-plane already has sequential startup in `bin/control-plane.ts`.

## Testing Strategy

| Level | Scope | Tests |
|-------|-------|-------|
| **Unit** | `crypto.ts` extraction | Encrypt/decrypt round-trip with known key |
| **Unit** | `file-store.ts` extraction | Load/save with temp directory, atomic write verification |
| **Unit** | `ClusterLocalBackend` extraction | setSecret/fetchSecret/deleteSecret with temp paths |
| **Unit** | `credential-writer.ts` | Mock backend + mock YAML fs, verify write sequence |
| **Unit** | `handlePutCredential` | Mock credential-writer, verify request parsing + response |
| **Integration** | Round-trip | PUT credential → GET credential returns metadata |
| **Integration** | Relay event | PUT credential → verify `cluster.credentials` event emitted |
| **Integration** | Idempotency | PUT same ID twice → second overwrites cleanly |
| **Integration** | Partial failure | Simulate YAML write failure → verify 500 + `failedAt` |

Existing credhelper-daemon tests should continue to pass unchanged (re-exports preserve API).

## Key Technical Decisions

1. **Extract to `@generacy-ai/credhelper` (not a new package)** — The shared package already exists and is a dependency of both credhelper-daemon and control-plane. Adding ~250 LOC of storage logic keeps the dep graph flat.

2. **Re-export from credhelper-daemon** — Daemon's existing imports (`from './crypto.js'`) continue to work because the re-export files maintain the same API surface. Zero changes needed in daemon business logic.

3. **Eager backend initialization** — `ClusterLocalBackend.init()` called at startup, not lazily on first request. Matches daemon pattern, fail-fast on missing master key.

4. **YAML metadata separate from encrypted store** — `.agency/credentials.yaml` holds type/backend/status metadata. Secret values live only in the encrypted file store. GET endpoint returns metadata only, never the secret.

5. **Follow `default-role-writer.ts` pattern** — Atomic YAML writes (temp+rename), `yaml` package for round-trip editing, `ControlPlaneError` for error responses.

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Extraction breaks credhelper-daemon | Re-export files maintain identical API surface; existing tests validate |
| Master key unavailable at control-plane startup | Fail-fast with clear error message; key is created by credhelper-daemon on first boot |
| Concurrent writes from daemon and control-plane | File-store uses fd-based advisory locking on `credentials.dat.lock` |
| `.agency/` dir doesn't exist | `mkdir -p` before write (matches `default-role-writer.ts` pattern) |
| Partial failure leaves orphaned secret | Harmless per AD-3 — encrypted, no readers, retryable via idempotent PUT |

---

*Generated by speckit*
