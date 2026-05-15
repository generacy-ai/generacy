# Implementation Plan: App Config & File Exposure for Application Clusters

**Feature**: Application clusters need `file` credential exposure, declarative `appConfig:` manifest in `cluster.yaml`, control-plane CRUD endpoints, and CLI commands to configure env vars and file blobs for user services.
**Branch**: `622-summary-application-clusters`
**Status**: Complete

## Summary

This feature adds three capabilities:

1. **File exposure kind** — A new `file` entry in the credhelper exposure discriminated union, with a `credential-file` plugin and a denylist-based path validation (per clarification C1). Session-scoped files (role-driven) are wiped on session end; persistent app-config files survive across sessions (per clarification C2).

2. **`appConfig:` manifest** — Extends `ClusterYamlSchema` with an optional `appConfig` section declaring env vars and file blobs the app needs. The control-plane reads this from the cluster's local working tree on demand (no caching/watching).

3. **Control-plane endpoints + CLI** — Five REST endpoints under `/control-plane/app-config/` for manifest retrieval, value CRUD, and file upload. Two CLI subcommands (`app-config show`, `app-config set`) that reach the control-plane via `docker compose exec`.

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Packages touched**: `@generacy-ai/credhelper`, `@generacy-ai/credhelper-daemon`, `@generacy-ai/control-plane`, `@generacy-ai/generacy` (CLI)
- **Key dependencies**: Zod (schemas), `node:fs/promises` (atomic file I/O), `node:crypto` (AES-256-GCM via existing backend), `yaml` package (YAML read/write)
- **Testing**: Vitest (unit + integration)

## Project Structure

### Scope 1: File Exposure Kind

| File | Action | Description |
|------|--------|-------------|
| `packages/credhelper/src/schemas/exposure.ts` | Modify | Add `file` variant to `ExposureConfigSchema` and `ExposureOutputSchema` |
| `packages/credhelper/src/schemas/roles.ts` | Modify | Add `as: 'file'` to `RoleExpose`, with `path` and optional `mode` fields |
| `packages/credhelper/src/types/plugin-exposure.ts` | Modify | Add `PluginFileExposure` type |
| `packages/credhelper-daemon/src/exposure-renderer.ts` | Modify | Add `renderFileExposure()` method — write blob to path with mode/ownership, denylist check |
| `packages/credhelper-daemon/src/file-path-denylist.ts` | Create | Pure function `isPathDenied(absPath): boolean` — checks against system-critical prefix denylist |

### Scope 2: `credential-file` Plugin

| File | Action | Description |
|------|--------|-------------|
| `packages/credhelper-daemon/src/plugins/core/credential-file.ts` | Create | New plugin: `resolve()` reads base64 blob from backend, `renderExposure('file')` returns decoded bytes |
| `packages/credhelper-daemon/src/plugins/core/index.ts` | Modify | Register `credentialFilePlugin` in `CORE_PLUGINS` array |
| `packages/credhelper-daemon/src/plugins/core/gcp-service-account.ts` | Modify | Extend `supportedExposures` with `'file'`; add `renderExposure('file')` branch for SA JSON key mode |

### Scope 3: `appConfig:` in `cluster.yaml`

| File | Action | Description |
|------|--------|-------------|
| `packages/generacy/src/cli/commands/cluster/context.ts` | Modify | Add `appConfig` optional field to `ClusterYamlSchema` with `AppConfigSchema` |
| `packages/control-plane/src/schemas.ts` | Modify | Export `AppConfigSchema` (or import from shared location) for control-plane validation |

### Scope 4: Control-Plane Endpoints

| File | Action | Description |
|------|--------|-------------|
| `packages/control-plane/src/router.ts` | Modify | Register 5 new routes under `/app-config/` |
| `packages/control-plane/src/routes/app-config.ts` | Create | Route handlers: `handleGetManifest`, `handleGetValues`, `handlePutEnv`, `handleDeleteEnv`, `handlePostFile` |
| `packages/control-plane/src/services/app-config-env-store.ts` | Create | Atomic read-modify-write for `/var/lib/generacy-app-config/env` with fd-based advisory lock |
| `packages/control-plane/src/services/app-config-file-store.ts` | Create | Persistent file materialization: write blob to `mountPath`, encrypt in backend, metadata tracking |

### Scope 5: CLI `app-config` Commands

| File | Action | Description |
|------|--------|-------------|
| `packages/generacy/src/cli/commands/app-config/index.ts` | Create | Commander.js subcommand group: `app-config show`, `app-config set` |
| `packages/generacy/src/cli/commands/app-config/show.ts` | Create | `docker compose exec orchestrator curl --unix-socket ...` to `GET /app-config/manifest` + `GET /app-config/values` |
| `packages/generacy/src/cli/commands/app-config/set.ts` | Create | `docker compose exec orchestrator curl --unix-socket ... -X PUT` to `PUT /app-config/env` |
| `packages/generacy/src/cli/index.ts` | Modify | Register `app-config` command group |

### Tests

| File | Action | Description |
|------|--------|-------------|
| `packages/credhelper-daemon/src/__tests__/file-path-denylist.test.ts` | Create | Unit tests for denylist validation |
| `packages/credhelper-daemon/src/__tests__/credential-file-plugin.test.ts` | Create | Unit tests for credential-file plugin |
| `packages/credhelper-daemon/src/__tests__/exposure-renderer-file.test.ts` | Create | Unit tests for file exposure rendering |
| `packages/control-plane/src/__tests__/app-config.test.ts` | Create | Integration tests for all 5 endpoints |
| `packages/generacy/src/cli/commands/cluster/__tests__/context-appconfig.test.ts` | Create | Unit tests for `AppConfigSchema` parsing |

## Implementation Order

### Phase A: Schema Foundation (no runtime deps)
1. Add `file` to exposure schemas (`credhelper`)
2. Add `PluginFileExposure` type (`credhelper`)
3. Add `as: 'file'` to role expose schema (`credhelper`)
4. Add `AppConfigSchema` to `ClusterYamlSchema` (`generacy` CLI)
5. Export `AppConfigSchema` from control-plane schemas

### Phase B: Credhelper File Exposure
6. Implement `isPathDenied()` denylist function
7. Implement `renderFileExposure()` in `ExposureRenderer`
8. Implement `credential-file` plugin
9. Register plugin in `CORE_PLUGINS`
10. Extend `gcp-service-account` plugin with `file` exposure
11. Wire `file` exposure in `SessionManager.beginSession()`

### Phase C: Control-Plane App-Config
12. Implement `AppConfigEnvStore` (atomic read-modify-write env file)
13. Implement `AppConfigFileStore` (persistent file materialization + backend)
14. Implement route handlers in `app-config.ts`
15. Register routes in `router.ts`
16. Wire stores in `bin/control-plane.ts`

### Phase D: CLI
17. Implement `app-config show` command
18. Implement `app-config set` command
19. Register in CLI index

### Phase E: Tests
20. Unit tests for denylist, plugin, renderer
21. Unit tests for `AppConfigSchema`
22. Integration tests for control-plane endpoints

## Key Design Decisions

1. **Denylist over allowlist** (Clarification C1): The manifest's `mountPath` is trusted as committed code. A system-path denylist (`/etc/`, `/usr/`, `/bin/`, `/sbin/`, `/lib*/`, `/proc/`, `/sys/`, `/dev/`, `/boot/`, `/run/generacy-credhelper/`, `/var/lib/generacy-credhelper/`) prevents footguns without restricting legitimate paths.

2. **Two-mode file lifecycle** (Clarification C2): `appConfig.files` are persistent (survive sessions, deleted only on explicit DELETE). Role-driven `as: file` exposures remain session-scoped. Same renderer, different lifecycle owner.

3. **Bare `KEY=VALUE` env format** (Clarification C3): Docker Compose's `env_file:` requires bare keys (no `export` prefix). Values double-quoted with escaping. Atomic rewrite under advisory lock.

4. **Strict file ID validation** (Clarification C4): `POST /files/:id` rejects undeclared file IDs (400). Intentional asymmetry with permissive env vars.

5. **`docker compose exec` for CLI transport** (Clarification C5): Matches `claude-login` pattern. No new transport infrastructure. Remote clusters use the cloud UI Settings panel.

## Constitution Check

No `.specify/memory/constitution.md` found — no governance constraints to verify against.
