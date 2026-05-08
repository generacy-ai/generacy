# Research: Fix launch CLI scaffolder

## Technology Decisions

### 1. Compose generation approach: Option A (inline)

**Decision**: Emit the full multi-service compose YAML from the scaffolder code.

**Alternatives considered**:
- **Option B (fetch template from image)**: Run `docker run --rm <image> cat /path/to/template > docker-compose.yml`, then patch values. Always in sync with image, but adds:
  - A Docker round-trip before compose-up (slow on first pull)
  - A templating layer (mustache, envsubst, or custom)
  - A new contract between image and CLI (template path)
  - Failure modes if the image doesn't have the template

**Rationale**: Option A is simpler and has fewer failure modes. Drift risk is mitigated by tests and the fact that the cluster-base compose changes infrequently. If drift becomes a problem, Option B can be adopted later.

### 2. Environment variable strategy: .env file + inline statics

**Decision**: Generate a `.env` file for cloud-provided and user-overridable values; inline static/derived values in the compose `environment:` block.

**Alternatives considered**:
- **Inline everything**: Simplest, but users can't override `WORKER_COUNT` or `GENERACY_CHANNEL` without editing the compose file.
- **Everything in .env**: Exposes identity values like `GENERACY_CLUSTER_ID` to accidental editing.

**Rationale**: Matches the cluster-base devcontainer pattern exactly. `.env` + `.env.local` (optional) gives users a clean override mechanism.

### 3. Relay URL derivation

**Problem**: `GENERACY_CLOUD_URL` is overloaded:
- In the CLI and LaunchConfig: HTTP API base URL (e.g., `https://api.generacy.ai`)
- In the cluster `.env`: WebSocket relay URL (e.g., `wss://api.generacy.ai/relay?projectId=<id>`)

**Decision**: Add a `deriveRelayUrl(httpUrl, projectId)` helper that converts protocol and appends path.

**Implementation**:
```typescript
function deriveRelayUrl(cloudUrl: string, projectId: string): string {
  const url = new URL(cloudUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/relay';
  url.searchParams.set('projectId', projectId);
  return url.toString();
}
```

**Verification**: The cluster-relay package's `RelayConfigSchema` defaults to `wss://api.generacy.ai/relay`, confirming the `/relay` path convention.

### 4. Docker socket mount path

**Decision**: Mount at `/var/run/docker-host.sock` (not the default `/var/run/docker.sock`).

**Rationale**: The credhelper-daemon's Docker proxy and bind-mount guard (`docker-bind-mount-guard.ts`) activates when `upstreamIsHost=true`, which requires the socket at the non-default path. The `buildSessionEnv()` in the orchestrator writes `DOCKER_HOST=unix://<sessionDir>/docker.sock` per session, so the per-agent Docker socket is distinct from the host socket.

### 5. tmpfs mounts for credentials architecture

**Decision**: Include tmpfs mounts for `/run/generacy-credhelper` (uid 1002) and `/run/generacy-control-plane` (uid 1000) on both orchestrator and worker services.

**Rationale**: These are load-bearing for the credentials architecture (CLAUDE.md documents this explicitly). Without them, the credhelper daemon and control-plane cannot create their Unix sockets, and credential sessions fail silently.

### 6. Claude config handling

**Decision**: Bind mount `~/.claude.json` for launch (local); named volume for deploy (remote).

**Rationale per clarifications Q5**:
- Launch: User's existing Claude credentials should flow into the cluster. Pre-create empty `{}` file if missing to prevent bind-mount failure.
- Deploy: Remote VM doesn't have user's Claude config; bind-mounting would mount the wrong file (VM operator's). Named volume + wizard auth = same UX as cloud deploy.

### 7. Worker count default

**Decision**: Default to 1 for both launch and deploy.

**Rationale**: `launch` is a single-developer-on-one-task workflow. 3 workers consumes >1GB RAM and starts idle processes. Conservative default; user scales via `.env`.

## Implementation Patterns

### YAML generation with `yaml` package

The existing scaffolder uses `stringify()` from the `yaml` npm package. The new multi-service compose uses the same approach — build a plain JS object representing the compose structure, then `stringify()` it.

Key consideration: `yaml` package preserves key ordering from the object. Build the object in the order that reads naturally in the YAML output (services first, then volumes, then networks).

### Atomic file writes

The existing scaffolder uses `writeFileSync()`. This is adequate for the `.env` file. No need for temp+rename since the scaffolder runs before compose-up and the directory is freshly created.

### Healthcheck format

Docker Compose v2 healthcheck format:
```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -f http://localhost:3100/health || exit 1"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 30s
```

Redis uses `redis-cli ping` instead of curl.

## Key References

- Cluster-base devcontainer compose: `github.com/generacy-ai/cluster-base/.devcontainer/generacy/docker-compose.yml`
- Cluster-base .env.template: `github.com/generacy-ai/cluster-base/.devcontainer/generacy/.env.template`
- Relay config: `packages/cluster-relay/src/config.ts` (line 29 — `relayUrl` default `wss://api.generacy.ai/relay`)
- Credhelper bind-mount guard: `packages/credhelper-daemon/src/docker-bind-mount-guard.ts`
- Orchestrator activation: `packages/orchestrator/src/activation/index.ts` (cloudUrl handling)
