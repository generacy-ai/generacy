# Research: App Config & File Exposure

## Technology Decisions

### 1. Path Validation: Denylist Approach

**Decision**: Use a prefix-based denylist instead of allowlist roots.

**Rationale**: The manifest `mountPath` is committed code (trusted). An allowlist approach would either be too restrictive (breaking the motivating example `/home/node/.config/gcloud/secrets/sa.json`) or require variant-specific configuration. The denylist approach protects system-critical paths while allowing any legitimate application path.

**Denylist entries**:
- `/etc/`, `/usr/`, `/bin/`, `/sbin/`, `/lib/`, `/lib64/`
- `/proc/`, `/sys/`, `/dev/`, `/boot/`
- `/run/generacy-credhelper/`, `/var/lib/generacy-credhelper/`
- `/run/generacy-control-plane/`
- Root `/` itself (must be a subdirectory)

**Alternative considered**: Per-variant allowlist roots (option A from clarification). Rejected because it creates a maintenance burden and doesn't scale to arbitrary app paths.

### 2. File Lifecycle: Dual-Mode

**Decision**: App-config files are persistent; role-driven file exposures are session-scoped.

**Rationale**: App-config files serve long-running compose services (e.g., a GCP SA JSON mounted by a voice agent container). These must survive individual Claude workflow sessions. Role-driven `as: file` exposures are short-lived scoped credentials for workflows, matching the existing credhelper session lifecycle.

**Implementation**:
- Persistent files: Control-plane writes directly to `mountPath` on PUT, stores encrypted blob in `ClusterLocalBackend`, materializes on boot.
- Session-scoped files: `ExposureRenderer.renderFileExposure()` writes to path, `SessionManager.endSession()` deletes.

### 3. Env File Format

**Decision**: Bare `KEY="escaped_value"` format with atomic rewrite.

**Rationale**: Docker Compose's `env_file:` directive does not support `export` prefix. Bash `source` supports both forms, but Docker Compose doesn't, so we use the common denominator. Atomic rewrite (temp + fsync + rename under advisory lock) prevents corruption from concurrent PUTs.

**Escaping rules**:
- Values wrapped in double quotes
- Internal double quotes escaped as `\"`
- Newlines escaped as `\n`
- Backslashes escaped as `\\`

### 4. Manifest Reading Strategy

**Decision**: Re-read `cluster.yaml` from the working tree on every `GET /app-config/manifest` call.

**Rationale**: The spec explicitly states "reading from the working tree (not GitHub) means a user can save edits without pushing and the UI sees them on next refresh." No caching or file-watching needed — the UI polls on demand. This is the simplest correct approach.

### 5. CLI Transport

**Decision**: `docker compose exec` with `curl --unix-socket`.

**Rationale**: Matches the `claude-login` command pattern. Zero new infrastructure. Works for local clusters only; remote clusters (SSH-deployed) use the cloud UI Settings panel exclusively.

**Command pattern**:
```bash
docker compose --project-name <name> --project-directory <dir> \
  exec orchestrator \
  curl -s --unix-socket /run/generacy-control-plane/control.sock \
  http://localhost/app-config/manifest
```

## Implementation Patterns

### Exposure Pipeline Extension

The existing exposure pipeline follows a clean discriminated-union pattern:

1. `ExposureConfigSchema` (Zod) — configuration discriminated on `kind`
2. `RoleExpose` (Zod) — role-level `as:` field selects exposure kind
3. `PluginExposureData` (TypeScript) — plugin output discriminated on `kind`
4. `ExposureRenderer` — dispatches to type-specific render methods

Adding `file` requires touching all four layers but follows the exact same pattern as existing exposure kinds. No architectural changes needed.

### Control-Plane Route Pattern

Existing routes follow a consistent pattern:
- Route handler receives `(req, res, actor, params)` from router
- Validates body with Zod schema
- Delegates to service layer
- Returns JSON with appropriate status code
- Errors use `sendError(res, { status, code, error, details? })` shape

The new `app-config` routes will follow this same pattern.

### Atomic File Operations

Two proven patterns exist in the codebase:
1. `CredentialFileStore` — temp + fsync + rename with fd-based advisory lock (`credentials.dat.lock`)
2. `writeCredential()` — YAML metadata write with atomic temp+rename

The `AppConfigEnvStore` will reuse pattern #1 (advisory lock + atomic rename) for the env file.

## Key Sources

- Existing exposure schemas: `packages/credhelper/src/schemas/exposure.ts`
- Existing plugins: `packages/credhelper-daemon/src/plugins/core/`
- Session manager: `packages/credhelper-daemon/src/session-manager.ts`
- Credential writer: `packages/control-plane/src/services/credential-writer.ts`
- Wizard env writer: `packages/control-plane/src/services/wizard-env-writer.ts`
- Router: `packages/control-plane/src/router.ts`
- CLI claude-login: `packages/generacy/src/cli/commands/claude-login/index.ts`
- ClusterYamlSchema: `packages/generacy/src/cli/commands/cluster/context.ts`
