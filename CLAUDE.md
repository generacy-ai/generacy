# Generacy

Frontend application for Generacy.

## Development

```bash
pnpm install
pnpm dev
```

## MCP Testing Tools

For browser automation and UI testing, see:
[/workspaces/tetrad-development/docs/MCP_TESTING_TOOLS.md](/workspaces/tetrad-development/docs/MCP_TESTING_TOOLS.md)

Use Playwright MCP to automate testing of the frontend:
1. Start the dev server
2. Use `browser_navigate` to open the app
3. Use `browser_snapshot` to inspect elements
4. Use `browser_click`, `browser_type`, etc. to interact

## Development Stack

For Firebase emulators (required for backend):
```bash
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh
```

See [/workspaces/tetrad-development/docs/DEVELOPMENT_STACK.md](/workspaces/tetrad-development/docs/DEVELOPMENT_STACK.md)

## Credhelper Packages

- `packages/credhelper` — Shared TypeScript types and Zod schemas for the credentials architecture (Phase 1, #458). Types-only, Zod-only dependency. Includes `LaunchRequestCredentials` type used by orchestrator.
- `packages/credhelper-daemon` — Runtime daemon for credential session management (#461). HTTP-over-Unix-socket API: `POST /sessions` (begin), `DELETE /sessions/:id` (end). Control socket at `/run/generacy-credhelper/control.sock`. Uses Node.js built-in `http` module, no Express.
  - `src/plugins/core/` — 7 core credential type plugins (#463): github-app, github-pat, gcp-service-account, aws-sts, stripe-restricted-key, api-key, env-passthrough. Statically registered via index file, not discovered via plugin loader.
  - `bin/credhelper-daemon.ts` — Entry point. Loads config from `.agency/` dir via `loadConfig()` (#477, Phase 6), builds `ConfigLoader` adapter, then starts daemon. Env var `CREDHELPER_AGENCY_DIR` overrides default `${PWD}/.agency`. Fails closed on invalid config.
  - `src/backends/` — BackendClient factory and implementations (#481, Phase 7a). `BackendClientFactory` dispatches on `BackendEntry.type`: `env` reads `process.env`, `cluster-local` provides AES-256-GCM encrypted file-backed storage (#491, v1.5 phase 2). Factory injected into `SessionManager` via constructor DI. Cloud-side credential storage (`generacy-cloud` backend) and OIDC session-token auth removed in #488 (v1.5 phase 0).
  - `src/backends/cluster-local-backend.ts` — NEW in #491: `ClusterLocalBackend` implements `WritableBackendClient` (extends `BackendClient` with `setSecret`/`deleteSecret`). AES-256-GCM encryption with per-credential random IV, master key at `/var/lib/generacy/master.key` (mode 0600, uid 1002). Credential store at `/var/lib/generacy/credentials.dat` (JSON envelope with version field). Atomic writes via temp+fsync+rename. fd-based advisory locking (no external deps). Fails closed on corrupt JSON or unknown version.
  - `src/backends/crypto.ts` — NEW in #491: AES-256-GCM encrypt/decrypt helpers using `node:crypto`. Per-credential random 12-byte IV, 16-byte auth tag.
  - `src/backends/file-store.ts` — NEW in #491, MODIFIED in #521: `CredentialFileStore` for atomic file I/O with advisory locking. Master key auto-generation on first boot. #521 replaces in-memory Promise-chain lock with fd-based advisory lock (`FileHandle.lock(true)`, Node >=22) using separate lock file (`credentials.dat.lock`). Provides kernel-level cross-process write serialization.
  - `src/audit/` — NEW in #499 (v1.5 phase 9): Structured audit logging for credential operations. `AuditLog` class with bounded ring buffer (capacity 5000), `record()` API for all credential lifecycle events. Flushes batches to control-plane via `POST /internal/audit-batch` (max 50 entries or 1s interval). `droppedSinceLastBatch` field on every batch payload. Actor identity from `GENERACY_CLUSTER_ID` and `GENERACY_WORKER_ID` env vars. Dev-mode assertion: no field > 256 chars (defense against secret leakage). Docker/localhost proxy hooks sampled at 1/100 unless `RoleConfig.audit.recordAllProxy` overrides to 100%.

## Control-Plane Package

- `packages/control-plane` — In-cluster HTTP service over Unix socket for the cloud-hosted bootstrap UI (#490, v1.5 phase 1). Terminates control-plane requests forwarded by the cluster-relay dispatcher.
  - Socket at `/run/generacy-control-plane/control.sock` (configurable via `CONTROL_PLANE_SOCKET_PATH`).
  - Routes (stubs in phase 1, real wiring in later phases): `GET /state`, `GET/PUT /credentials/:id`, `GET/PUT /roles/:id`, `POST /lifecycle/:action`, `POST /internal/audit-batch` (#499, v1.5 phase 9 — receives audit batches from credhelper-daemon, emits entries on relay `cluster.audit` channel), `POST /internal/status` (#516 — receives lifecycle status updates from orchestrator).
  - `GET /state` (#516): Returns dynamic `ClusterState` — `status` (bootstrapping|ready|degraded|error), `deploymentMode` (from `DEPLOYMENT_MODE` env, default 'local'), `variant` (from `CLUSTER_VARIANT` env, default 'cluster-base'), `lastSeen`, optional `statusReason`. Always starts `bootstrapping`; orchestrator pushes transitions via `POST /internal/status`.
  - `POST /internal/status` (#516): Receives `{ status, statusReason? }` from orchestrator. Module-level state store pattern (same as `setRelayPushEvent`). State machine: bootstrapping→ready↔degraded→error (terminal).
  - Uses native `node:http` (same pattern as credhelper-daemon). Re-exports credential/role Zod schemas from `@generacy-ai/credhelper`.
  - Reads actor identity from relay-injected headers (`x-generacy-actor-user-id`, `x-generacy-actor-session-id`).
  - Error shape: `{ error, code, details? }` — matches credhelper-daemon's `CredhelperErrorResponse`.
  - Crash-tolerant: failures must not block orchestrator boot; relay returns 503 from socket prefix.
  - `src/services/tunnel-handler.ts` — NEW in #519: `TunnelHandler` class for bidirectional byte-streaming between relay WebSocket and code-server's Unix socket. Constructor DI: `RelayMessageSender` (just `send(message): void`), `CodeServerManager`, optional `allowedTarget` (default `/run/code-server.sock`). Methods: `handleOpen()` (target validation, auto-start code-server, connect socket, send `tunnel_open_ack`), `handleData()` (base64 decode, socket write, `touch()` idle reset), `handleClose()` (destroy socket), `cleanup()` (destroy all, stateless across reconnects). Tunnel state stored in `Map<tunnelId, net.Socket>`. Security: rejects any target other than `/run/code-server.sock` with `tunnel_open_ack { status: 'error', error: 'invalid target' }`.
  - `src/services/peer-repo-cloner.ts` — NEW in #530: Clones peer repos during bootstrap wizard step 4. Accepts `{ repos: string[], token?: string }` — cloud forwards `cloneRepos` list (excludes primary). Uses `git clone` with optional `x-access-token` HTTPS pattern for private repos. Emits `cluster.bootstrap` channel events via `setRelayPushEvent` (`{ repo, status: 'cloning'|'done'|'failed' }`). Idempotent: existing dirs at `/workspaces/<name>` skip clone and re-emit `done`. Empty repos array emits `{ status: 'done', message: 'no peer repos' }`.
  - `src/services/default-role-writer.ts` — NEW in #530: Handles `set-default-role` lifecycle action from bootstrap wizard step 3. Validates role exists in `.agency/roles/<role>.yaml`, then writes `defaults.role` to `.generacy/config.yaml` using `yaml` npm package for round-trip YAML editing. Atomic write (temp+rename). Fails closed if role file missing.
  - `src/relay-events.ts` — NEW in #530: Extracted `setRelayPushEvent`/`getRelayPushEvent` from `audit.ts` into shared module. Used by both audit route and peer-repo-cloner for relay channel event emission.
  - `LifecycleActionSchema` (#530): Extended from 3 to 5 entries to match cloud: `clone-peer-repos`, `set-default-role`, `code-server-start`, `code-server-stop`, `stop`. New body schemas: `ClonePeerReposBodySchema`, `SetDefaultRoleBodySchema`. `stop` stays as stub for v1.5.

## Cluster Relay

- `packages/cluster-relay/` — WebSocket relay client connecting in-cluster orchestrator to Generacy cloud (`@generacy-ai/cluster-relay`). ESM, Node >=20, deps: `ws`, `zod`.
  - `src/messages.ts` — Zod-validated message types: `ApiRequestMessage`, `ApiResponseMessage`, `HandshakeMessage`, `HeartbeatMessage`, `EventMessage`, `ErrorMessage`, `ConversationMessage`, `TunnelOpenMessage`, `TunnelOpenAckMessage`, `TunnelDataMessage`, `TunnelCloseMessage` (#519). Discriminated union on `type` field via `RelayMessageSchema`.
  - `src/proxy.ts` — Forwards relayed `api_request` messages to orchestrator HTTP. v1.5 #489 extends with path-prefix dispatcher: `routes` array of `{ prefix, target }` (HTTP URL or `unix://` socket), longest-prefix-match, prefix stripping, `orchestratorUrl` as implicit fallback. Actor identity propagated as `x-generacy-actor-user-id`/`x-generacy-actor-session-id` headers.
  - `src/config.ts` — `RelayConfig` loaded from env vars + overrides. v1.5 #489 adds `routes: RouteEntry[]`, `activationCode?`, `clusterApiKeyId?`.
  - `src/relay.ts` — `ClusterRelay` class: WebSocket lifecycle, state machine (disconnected→connecting→authenticating→connected), auto-reconnect with exponential backoff, heartbeat, message dispatch. v1.5 #489 adds `activation` field to handshake.
  - `src/dispatcher.ts` — NEW in #489: pure-function path-prefix dispatcher. `sortRoutes()`, `resolveRoute()`, Unix socket detection.

## Orchestrator Activation

- `packages/orchestrator/src/activation/` — Device-flow activation client for first cluster boot (#492, v1.5 phase 2). Runs before relay handshake in orchestrator startup. If no key file at `/var/lib/generacy/cluster-api-key`, initiates RFC 8628 device-code flow against `GENERACY_CLOUD_URL`.
  - `index.ts` — Public API: `activate(options)` returns `ActivationResult` (apiKey, clusterApiKeyId, clusterId, projectId, orgId, cloudUrl). #517 fix: persists `pollResult.cloud_url` (cloud-returned, not input config) and returns `cloudUrl` on both device-flow and existing-key paths.
  - `client.ts` — HTTP client for `POST /api/clusters/device-code` and `POST /api/clusters/device-code/poll`. Uses native `node:http`/`node:https`.
  - `poller.ts` — Poll loop with `slow_down` (+5s) and `expired` (auto-retry up to 3 cycles) handling.
  - `persistence.ts` — Atomic key-file write (`.tmp` + `rename()`, mode 0600) and `cluster.json` metadata.
  - Cloud URL precedence: `GENERACY_CLOUD_URL` env > derived from relay WSS URL > `https://api.generacy.ai`.
  - Retry budget: 5 retries, exponential backoff (2s-32s, ~62s total) for initial cloud requests.
  - Integration: `server.ts` calls `activate()` before relay construction; sets `config.relay.apiKey` and `config.relay.clusterApiKeyId` from result. #517 fix: also overrides `config.activation.cloudUrl` and `config.relay.cloudUrl` (derived WSS: `https://X` → `wss://X/relay`) from `activationResult.cloudUrl` when present.

## CLI Package (generacy)

- `packages/generacy/` — Main CLI package (`@generacy-ai/generacy`). ESM, Node >=22, deps: `commander`, `pino`, `zod`.
  - `bin/generacy.js` — Entry point with Node >=22 version gate. Calls `run()` from `src/cli/index.ts`.
  - `src/cli/index.ts` — Commander.js program. Registers existing commands (run, orchestrator, validate, doctor, init, setup) plus v1.5 placeholder subcommands.
  - `src/cli/commands/placeholders.ts` — NEW in #493: data-driven placeholder command factory. Each prints "not yet implemented" with v1.5 phase info, exits 0.
  - `src/cli/utils/error-handler.ts` — NEW in #493: global uncaughtException/unhandledRejection handler. User-friendly messages; stack traces only when `DEBUG=1`.
  - `src/cli/utils/node-version.ts` — NEW in #493: `checkNodeVersion()` — refuses to run on Node <22 with install link.
  - `src/cli/utils/exec.ts` — Shell helpers: `exec()` (sync, throws), `execSafe()` (sync, returns `{ok, stdout, stderr}`), `spawnBackground()` (detached).
  - `src/cli/utils/logger.ts` — Pino logging: `getLogger()`, `setLogger()`, `createLogger()`.
  - `src/cli/utils/cloud-url.ts` — NEW in #545: `resolveCloudUrl(flagValue?)` — 3-tier cloud URL resolution: CLI `--cloud-url` flag > `GENERACY_CLOUD_URL` env var > `https://api.generacy.ai` default. Validates with `z.string().url()`. Used by both `launch` and `deploy` commands.
  - `src/registry/` — NEW in #493: `~/.generacy/clusters.json` registry helper. `loadRegistry()`, `saveRegistry()` (atomic tmp+rename), `addCluster()`, `removeCluster()`, `findClusterByCwd()` (longest-prefix-match). Zod-validated schema: `{version: 1, clusters: [{id, name, path, cloudUrl, lastSeen}]}`.

## CLI Cluster Lifecycle Commands

- `packages/generacy/src/cli/commands/` — Six cluster lifecycle commands (#494, v1.5 phase 5): `up`, `stop`, `down`, `destroy`, `status`, `update`. Each wraps `docker compose` against `.generacy/docker-compose.yml`.
  - `commands/cluster/` — Shared helpers: `context.ts` (resolve `.generacy/` upward, parse `cluster.yaml` + `cluster.json`), `compose.ts` (build `--project-name`/`--file` args, run compose), `registry.ts` (read/write `~/.generacy/clusters.json`), `docker.ts` (availability check).
  - `commands/up/index.ts` — `docker compose up -d`, auto-registers in registry, updates `lastSeen`.
  - `commands/stop/index.ts` — `docker compose stop`. Containers preserved.
  - `commands/down/index.ts` — `docker compose down`. `--volumes` flag to also remove named volumes.
  - `commands/destroy/index.ts` — `docker compose down -v`, removes `.generacy/` dir and registry entry. `--yes` skips confirmation prompt (`@clack/prompts` `p.confirm()`).
  - `commands/status/index.ts` — Lists all clusters from `~/.generacy/clusters.json` with live Docker state via `docker compose ps --format json`. `--json` for machine-readable output.
  - `commands/update/index.ts` — `docker compose pull` + `docker compose up -d` (recreates only changed containers).
  - Cluster identity: `.generacy/cluster.yaml` (project config: channel, workers, variant), `.generacy/cluster.json` (runtime: clusterId, orgId, projectId from activation), `.generacy/docker-compose.yml` (compose file).
  - Registry at `~/.generacy/clusters.json`: array of `{clusterId, name, path, composePath, variant, channel, cloudUrl, lastSeen, createdAt}`. Atomic writes via temp+rename.
  - Pre-activation fallback: if `cluster.json` missing, uses directory basename as compose project name with warning.

## CLI Launch Command

- `packages/generacy/src/cli/commands/launch/` — First-run CLI command for cloud-flow onboarding (#495, v1.5 phase 5). `npx generacy launch --claim=<code>` bootstraps a new cluster from a cloud-issued claim code.
  - `index.ts` — Command registration (Commander.js) + main orchestration flow: validate Node/Docker, fetch launch-config, scaffold, compose up, stream logs, open browser, register cluster. #518 fix: Node version gate `>=22` (was `>=20`), uses shared scaffolder and validated registry writes.
  - `cloud-client.ts` — `fetchLaunchConfig(cloudUrl, claimCode)`: `GET /api/clusters/launch-config?claim=<code>`. Returns `LaunchConfig` (projectId, projectName, variant, cloudUrl, clusterId, imageTag, orgId, repos). Uses `node:https`. Stub mode via `GENERACY_LAUNCH_STUB=1`.
  - `scaffolder.ts` — Delegates to shared `cluster/scaffolder.ts` for writing `.generacy/` config files. #518 fix: writes snake_case `cluster.json` (`cluster_id`, `project_id`, `org_id`, `cloud_url`), minimal `cluster.yaml` (`channel`, `workers`, `variant` only).
  - `types.ts` — `LaunchConfigSchema` with required `orgId` field (#518). `repos.dev` and `repos.clone` are `z.array(z.string()).optional()` (#528 — cloud returns arrays, not strings). Local `ClusterMetadata`/`ClusterYaml`/`ClusterRegistryEntry` types removed in favor of shared schemas.
  - `compose.ts` — `docker compose pull` + `up -d` + log streaming. Matches `"Go to:"` pattern to extract `verification_uri` and `user_code`.
  - `browser.ts` — Cross-platform browser open: `open` (macOS), `start` (Windows), print URL (Linux).
  - `registry.ts` — Validates entries against shared `RegistryEntrySchema` from `cluster/registry.ts` before writing (#518).
  - `prompts.ts` — Interactive prompts via `@clack/prompts` for claim code input and directory confirmation.
  - CLI flags: `--claim <code>`, `--dir <path>`. Default project dir: `~/Generacy/<projectName>`.
  - Standalone from `init` command — writes only cloud-flow config files. Convergence deferred.
  - Shared scaffolder at `commands/cluster/scaffolder.ts` (#518): `scaffoldClusterJson()`, `scaffoldClusterYaml()`, `scaffoldDockerCompose()`, `scaffoldEnvFile()`, `deriveRelayUrl()` — used by both launch and deploy commands. Ensures consistent file formats. #531 fix: `ScaffoldComposeInput` gains `variant` (required) and `deploymentMode` (optional, default `'local'`); generated `docker-compose.yml` now includes `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars. Deploy scaffolder passes `deploymentMode: 'cloud'`. #543 fix: `scaffoldDockerCompose()` rewritten to emit multi-service compose (orchestrator + worker + redis) mirroring cluster-base devcontainer compose. New `scaffoldEnvFile()` generates `.generacy/.env` with cloud-provided identity vars and project defaults. `deriveRelayUrl()` converts HTTP cloud URL to wss relay URL (`https://X` → `wss://X/relay?projectId=<id>`). `ScaffoldComposeInput` gains `orgId`, `workers`, `channel`, `repoUrl`, `claudeConfigMode` ('bind'|'volume'). Launch uses bind mount for `~/.claude.json` (pre-creates if missing); deploy uses named `claude-config` volume.
  - Schema conventions (#518): `cluster.json` uses snake_case (matches orchestrator's `/var/lib/generacy/cluster.json`). `activated_at` optional (populated container-side post-activation). `variant` enum: `'cluster-base' | 'cluster-microservices'` (matches GHCR image names).

## CLI claude-login and open Commands

- `src/cli/commands/claude-login/` — NEW in #496: Proxies `claude /login` inside orchestrator container. Spawns `docker compose exec -it orchestrator claude /login` with `stdio: ['inherit', 'pipe', 'inherit']`. Pipes stdout through URL scanner; auto-opens detected URLs on macOS/Windows, prints instructions on Linux. Resolves cluster via shared `getClusterContext` helper.
- `src/cli/commands/open/` — NEW in #496: Opens `{cloudUrl}/clusters/{clusterId}` in default browser. Resolves cluster from cwd or `--cluster <id>` flag. Looks up `cloudUrl` from `~/.generacy/clusters.json` registry.
- `src/cli/utils/cluster-context.ts` — NEW in #496: `getClusterContext(options)` walks up from cwd looking for `.generacy/cluster.json`, cross-references `~/.generacy/clusters.json` for registry metadata. Returns `ClusterContext` with `clusterId`, `cloudUrl`, `projectDir`, etc. Shared by claude-login, open, and #494 lifecycle commands.
- `src/cli/utils/browser.ts` — NEW in #496: `openUrl(url)` cross-platform browser launch. macOS: `open`, Windows: `start`, Linux: print-only (no auto-open per architecture doc).

## Orchestrator Launcher

- `packages/orchestrator/src/launcher/` — Plugin-based process launcher (`AgentLauncher`). Resolves intents to plugins, merges env (3-layer), selects `ProcessFactory` by stdio profile, spawns processes.
- Credentials interceptor (#465, Phase 3): When `LaunchRequest.credentials` is set, begins a credhelper session, merges session env, wraps command in entrypoint, sets uid/gid, ends session on exit. Uses HTTP-over-Unix-socket client (`node:http`) to communicate with credhelper daemon.
- Credentials integration (#478, Phase 6): `createAgentLauncher()` wires `CredhelperHttpClient` when the control socket exists. `WorkerConfig.credentialRole` (from `.generacy/config.yaml` `defaults.role`) flows to all spawn sites (`CliSpawner`, `PrFeedbackHandler`, `ConversationSpawner`), which populate `LaunchRequest.credentials`. Fail-fast at startup if role is configured but daemon is unavailable. Generic launcher paths (`cli-utils.ts`, `subprocess.ts`) deferred to follow-up.
  - `src/exposure/localhost-proxy.ts` — NEW in #498 (v1.5 phase 9): `LocalhostProxy` class implementing `LocalhostProxyHandle`. HTTP reverse proxy on `127.0.0.1:<port>` with method+path allowlist from role's `proxy:` block. Injects auth headers from plugin `renderExposure` output. 403 JSON response for denied requests (`{ error, code: 'PROXY_ACCESS_DENIED', details }`). Follows `DockerProxy` lifecycle pattern (start/stop). Pure-function `matchAllowlist()` for path matching: literal segments + `{param}` placeholders, query strings stripped, trailing slashes significant, case-sensitive. Session env var written with proxy URL (`envName` field or `<REF_UPPER>_PROXY_URL` fallback). Session creation fails closed (`PROXY_CONFIG_MISSING`) if `proxy:<credRef.ref>` entry missing. Port collision detected at bind time (`PROXY_PORT_COLLISION`). Handles stored in `SessionState.localhostProxies: LocalhostProxyHandle[]`, cleaned up in `endSession()`.

## Activation Client Package

- `packages/activation-client/` — NEW in #500 (v1.5 phase 10): Shared device-flow activation client (`@generacy-ai/activation-client`). Extracted ~200 LOC from `packages/orchestrator/src/activation/`. Protocol-level only: `initDeviceFlow()`, `pollForApproval()`, status decoding. Zero deps beyond `node:http`/`node:https` and `zod`.
  - `src/client.ts` — HTTP client for `POST /api/clusters/device-code` and `POST /api/clusters/device-code/poll`.
  - `src/poller.ts` — Poll loop with `slow_down` (+5s) and `expired` (auto-retry up to 3 cycles) handling.
  - `src/types.ts` — `DeviceCodeResponse`, `PollResponse` (discriminated union), `ActivationResult`, `ActivationClientOptions`. #517 fix: `PollResponseSchema` approved variant includes `cloud_url: z.string().url()`; `ActivationResult` includes optional `cloudUrl?: string`.
  - `src/errors.ts` — `ActivationError` with codes: `CLOUD_UNREACHABLE`, `DEVICE_CODE_EXPIRED`, `INVALID_RESPONSE`.
  - Consumed by orchestrator (wraps with file-based key persistence) and CLI deploy (wraps with browser-open behavior).

## CLI Deploy Command (#500, v1.5 phase 10)

- `packages/generacy/src/cli/commands/deploy/` — NEW in #500: `generacy deploy ssh://[user@]host[:port][/path]` provisions a Generacy cluster on a BYO VM via SSH.
  - `index.ts` — Command registration + main orchestration: verify SSH+Docker, activate device-flow, fetch LaunchConfig, SCP bootstrap bundle, SSH `docker compose up -d`, poll cloud status, register cluster.
  - `ssh-target.ts` — Parse `ssh://` URL into `SshTarget` (user, host, port, remotePath). Defaults: current OS user, port 22, `~/generacy-clusters/<project-id>`.
  - `ssh-client.ts` — SSH/SCP helpers via `node:child_process`. `BatchMode=yes`, `StrictHostKeyChecking=accept-new`.
  - `activation.ts` — Device-flow wrapper: calls `@generacy-ai/activation-client`, opens browser with `verification_uri`.
  - `cloud-client.ts` — Reuses `fetchLaunchConfig()` from launch command.
  - `scaffolder.ts` — Generate bootstrap bundle in temp dir (cluster.yaml, cluster.json, docker-compose.yml).
  - `remote-compose.ts` — SCP bundle + SSH `docker compose pull && up -d`.
  - `status-poller.ts` — Poll cloud cluster status until `connected` or timeout (default 5 min, `--timeout` flag).
  - Registry entry includes `managementEndpoint: "ssh://user@host:port/path"`.
  - Lifecycle commands (`stop`, `up`, `down`, etc.) transparently forward `docker compose` over SSH when `managementEndpoint` starts with `ssh://`. Extended in `commands/cluster/compose.ts`.

## Cluster Image Build Workflows (#534)

- `.github/workflows/publish-cluster-base-image.yml` — NEW in #534: Manual `workflow_dispatch` workflow to build and push the `cluster-base` Docker image to GHCR. Checks out `generacy-ai/cluster-base` at a specified ref (`develop` or `main`), maps `develop` -> `:preview` and `main` -> `:stable` tags, pushes to `ghcr.io/generacy-ai/cluster-base`. Also pushes `:sha-<short>` immutable tag. Uses `docker/build-push-action@v6`, `docker/login-action@v3`, `docker/setup-buildx-action@v3`. Permissions: `contents: read`, `packages: write`.
- `.github/workflows/publish-cluster-microservices-image.yml` — NEW in #534: Same shape as cluster-base workflow, targeting `generacy-ai/cluster-microservices` repo and `ghcr.io/generacy-ai/cluster-microservices` image.
- Motivation: Template repos previously contained workflow files that got copied into user-project repos during creation, causing `403 Resource not accessible by integration` errors (GitHub App lacks `Workflows: write`). Moving builds here eliminates that.

## Cloud URL Disambiguation (#549)

- Split `GENERACY_CLOUD_URL` into three purpose-specific env vars: `GENERACY_API_URL` (HTTP REST), `GENERACY_RELAY_URL` (WebSocket relay), `GENERACY_APP_URL` (dashboard, CLI-only).
- `LaunchConfigSchema` in `packages/generacy/src/cli/commands/launch/types.ts` gains optional `cloud: { apiUrl, appUrl, relayUrl }` object alongside deprecated `cloudUrl`.
- `packages/generacy/src/cli/utils/cloud-url.ts`: `resolveCloudUrl()` renamed to `resolveApiUrl()`, reads `GENERACY_API_URL` first, falls back to `GENERACY_CLOUD_URL` with debug deprecation log.
- `packages/orchestrator/src/config/loader.ts`: Line ~245 reads `GENERACY_API_URL` (was `GENERACY_CLOUD_URL`) for activation; line ~263 reads `GENERACY_RELAY_URL` (was `GENERACY_CLOUD_URL`) for relay. Both fall back to old var with deprecation log. `projectId` append logic (~280-290) removed (cloud pre-appends).
- `packages/cluster-relay/src/relay.ts`: Interface comment updated to reference `GENERACY_RELAY_URL` (env var read happens in orchestrator config loader, not directly here).
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts`: `scaffoldEnvFile()` writes `GENERACY_API_URL` and `GENERACY_RELAY_URL` (not `GENERACY_CLOUD_URL`). When `LaunchConfig.cloud` present, uses cloud-provided values; otherwise derives from `cloudUrl` via `deriveRelayUrl()`.
- `GENERACY_APP_URL` NOT written to cluster `.env` (no consumer). Cloud sends it in `LaunchConfig.cloud.appUrl`; CLI stores it in registry's `cloudUrl` field.
- Registry `cloudUrl` field name unchanged (persisted data). Value sourced from `config.cloud?.appUrl ?? config.cloudUrl`.
- Scope: generacy repo only. Cloud-side (`buildLaunchConfig`), cluster-base (`.env.template`), and Phase 4 cleanup are follow-up issues.

## Scoped Docker Socket Proxy (#497, v1.5 phase 9)

- `packages/credhelper-daemon/src/docker-bind-mount-guard.ts` — NEW in #497: Validates `POST /containers/create` bind mounts are under `GENERACY_SCRATCH_DIR`. Inspects both `HostConfig.Binds` (string format) and `HostConfig.Mounts` (object format, `Type: "bind"` only). Uses `path.resolve()` for canonicalization. Only active when `upstreamIsHost=true` (host-socket mode); DinD mode skips validation.
- `packages/credhelper-daemon/src/docker-proxy-handler.ts` — MODIFIED in #497: Buffers `POST /containers/create` body on host-socket to run bind-mount guard before forwarding. 10MB body size limit.
- Per-session scratch directory at `/var/lib/generacy/scratch/<session-id>/` (mode 0700, uid 1001). Created at session begin, cleaned at session end. Exposed as `GENERACY_SCRATCH_DIR` env var.
- Upstream selection: `ENABLE_DIND=true` → `/var/run/docker.sock` (DinD, no bind-mount guard) → `/var/run/docker-host.sock` (host, with bind-mount guard) → warn at boot, fail per-session.
- `buildSessionEnv()` in orchestrator already sets `DOCKER_HOST=unix://<sessionDir>/docker.sock`.
