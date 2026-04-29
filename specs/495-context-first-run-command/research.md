# Research: CLI Launch Command (Claim-Code First-Run Flow)

**Branch**: `495-context-first-run-command` | **Date**: 2026-04-29

## Technology Decisions

### 1. HTTP Client for Cloud API

**Decision**: Use `node:https` / `node:http` (native Node.js modules)

**Rationale**:
- Matches the pattern used by `credhelper-daemon`, `control-plane`, and `orchestrator/src/activation/client.ts`
- Zero additional dependencies
- Sufficient for a single GET request with JSON response

**Alternatives considered**:
- `fetch` (global in Node 20+) — viable but `node:https` is more consistent with the codebase
- `undici` / `axios` — unnecessary dependency for a single HTTP call

### 2. Interactive Prompts

**Decision**: Use `@clack/prompts` (already installed)

**Rationale**:
- `init` command already uses `@clack/prompts` for all interactive prompts
- Styled terminal output with spinners, confirmations, and text input
- Cancel handling with exit code 130

**Patterns from init**:
- `text()` for claim code input
- `confirm()` for directory confirmation
- `spinner()` for long-running operations (pull, compose up)
- `isCancel()` guard on every prompt result

### 3. Cross-Platform Browser Open

**Decision**: Platform-specific `child_process.exec` with no external dependency

**Implementation**:
```typescript
// macOS: open <url>
// Windows: start "" "<url>"
// Linux: print URL with instructions (per clarification Q5 + dev-cluster-architecture.md)
```

**Rationale**:
- `xdg-open` on Linux is unreliable in containers/WSL/headless environments
- The spec explicitly says Linux should print the URL as fallback
- macOS `open` and Windows `start` are reliable system commands
- No need for an `open` npm package dependency

**Alternatives considered**:
- `open` npm package — adds a dependency for a simple exec call
- Always print URL — worse UX on macOS/Windows where auto-open is expected

### 4. Docker Compose Interaction

**Decision**: Shell out to `docker compose` CLI via existing `exec.ts` utilities

**Rationale**:
- Docker Compose V2 is the standard (plugin-based `docker compose`, not standalone `docker-compose`)
- `exec()` and `execSafe()` in `utils/exec.ts` already handle subprocess execution with error capture
- Log streaming requires `child_process.spawn` with `stdio: 'pipe'` for line-by-line parsing

**Implementation details**:
- `docker compose -f .generacy/docker-compose.yml pull` — pull image
- `docker compose -f .generacy/docker-compose.yml up -d` — start detached
- `docker compose -f .generacy/docker-compose.yml logs -f` — stream logs, parse for activation URL
- All commands run with `cwd` set to the project directory

### 5. Cluster Config Files

**Decision**: Three files in `.generacy/` subdirectory

| File | Format | Purpose |
|------|--------|---------|
| `cluster.yaml` | YAML | Runtime config: variant, image tag, port mappings, cloud URL |
| `cluster.json` | JSON | Machine-readable metadata: clusterId, projectId, projectName |
| `docker-compose.yml` | YAML | Docker Compose service definition |

**Rationale**:
- `cluster.yaml` uses YAML to match `.generacy/config.yaml` convention
- `cluster.json` uses JSON for easy programmatic consumption (matches container-internal `/var/lib/generacy/cluster.json`)
- `docker-compose.yml` is standard Docker Compose format
- All scoped under `.generacy/` to avoid polluting the project root (clarification Q4 — launch is standalone)

### 6. Cluster Registry

**Decision**: Consume `~/.generacy/clusters.json` format defined by #494

**Entry shape** (from clarification Q2):
```typescript
{
  clusterId: string;       // Cloud-generated, globally unique
  name: string;            // projectName from launch-config
  path: string;            // Absolute path to project directory
  composePath: string;     // Absolute path to docker-compose.yml
  variant: string;         // e.g., "standard"
  channel: string;         // e.g., "stable"
  cloudUrl: string;        // Cloud API URL
  lastSeen: string;        // ISO 8601 timestamp
  createdAt: string;       // ISO 8601 timestamp
}
```

**File operations**:
- Read existing array (or initialize `[]` if file doesn't exist)
- Append new entry
- Atomic write via `writeFileSync` to temp + `renameSync`

### 7. Activation URL Detection

**Decision**: Regex match on `docker compose logs` output for `"Go to:"` pattern

**Pattern** (from clarification Q5 + orchestrator activation code):
```
Go to: https://...verification_uri...
Enter code: XXXX-XXXX
```

**Implementation**:
- Spawn `docker compose logs -f` as a child process
- Read stdout line-by-line
- Match `/Go to:\s+(https?:\/\/\S+)/` to extract `verification_uri`
- Match `/Enter code:\s+(\S+)/` to extract `user_code`
- Display `user_code` prominently in CLI output
- Auto-open `verification_uri` on macOS/Windows
- Timeout after configurable duration (default 120s) with helpful error

### 8. Stub Mode for Development

**Decision**: Env var `GENERACY_LAUNCH_STUB=1` returns a hardcoded launch-config response

**Rationale**:
- The cloud endpoint `GET /api/clusters/launch-config` may not exist yet (FR-012)
- Enables development and testing of the full flow without cloud dependency
- Stub response matches the full schema so all downstream code exercises real paths

**Stub response**:
```json
{
  "projectId": "proj_stub001",
  "projectName": "stub-project",
  "variant": "standard",
  "cloudUrl": "http://localhost:3000",
  "clusterId": "cluster_stub001",
  "imageTag": "ghcr.io/generacy-ai/cluster-base:dev",
  "repos": { "primary": "generacy-ai/example-project" }
}
```

## Implementation Patterns

### Error Handling Strategy

Every failure mode produces a user-friendly error with remediation hint:

| Failure | Message | Remediation |
|---------|---------|-------------|
| Node < 20 | "Node.js 20+ is required" | "Install via nvm: `nvm install 20`" |
| Docker not running | "Docker daemon is not running" | "Start Docker Desktop or run `sudo systemctl start docker`" |
| Cloud unreachable | "Could not reach Generacy cloud at {url}" | "Check your internet connection and GENERACY_CLOUD_URL" |
| Invalid claim code | "Claim code is invalid or expired" | "Request a new claim code from your project admin" |
| Image pull failure | "Failed to pull cluster image {tag}" | "Check Docker Hub / GHCR access. Run `docker login ghcr.io`" |
| Compose start failure | "Failed to start cluster" | "Check `docker compose logs` for details" |
| Directory exists | "Directory {path} already exists" | "Use `--dir` to specify a different location, or remove the existing directory" |
| Activation timeout | "Timed out waiting for activation URL" | "Check cluster health with `docker compose logs`" |

### Command Flow

```
npx generacy launch --claim=<code> [--dir <path>]
│
├── 1. Validate Node version (>=20)
├── 2. Validate Docker reachable (docker info)
├── 3. Read --claim or prompt for it
├── 4. Fetch launch-config from cloud API
├── 5. Determine project directory + confirm
├── 6. Create .generacy/ and write config files
├── 7. docker compose pull (with spinner)
├── 8. docker compose up -d
├── 9. Stream logs → match "Go to:" → extract URL + code
├── 10. Display user_code, auto-open verification_uri
└── 11. Register cluster in ~/.generacy/clusters.json
```

## Key Sources

- Existing `init` command: `packages/generacy/src/cli/commands/init/`
- Docker doctor check: `packages/generacy/src/cli/commands/doctor/checks/docker.ts`
- Orchestrator activation: `packages/orchestrator/src/activation/`
- Dev cluster architecture: `docs/dev-cluster-architecture.md` (in tetrad-development)
- Cluster registry schema: #494
- Device code flow: RFC 8628
