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
  - Routes (stubs in phase 1, real wiring in later phases): `GET /state`, `GET/PUT /credentials/:id`, `POST /lifecycle/:action`, `POST /internal/audit-batch` (#499, v1.5 phase 9 — receives audit batches from credhelper-daemon, emits entries on relay `cluster.audit` channel), `POST /internal/status` (#516 — receives lifecycle status updates from orchestrator). `/roles/:id` routes removed in #582 (roles are workspace-level, not cluster-level).
  - `GET /state` (#516): Returns dynamic `ClusterState` — `status` (bootstrapping|ready|degraded|error), `deploymentMode` (from `DEPLOYMENT_MODE` env, default 'local'), `variant` (from `CLUSTER_VARIANT` env, default 'cluster-base'), `lastSeen`, optional `statusReason`. Always starts `bootstrapping`; orchestrator pushes transitions via `POST /internal/status`.
  - `POST /internal/status` (#516): Receives `{ status, statusReason? }` from orchestrator. Module-level state store pattern (same as `setRelayPushEvent`). State machine: bootstrapping→ready↔degraded→error (terminal).
  - Uses native `node:http` (same pattern as credhelper-daemon). Re-exports credential/role Zod schemas from `@generacy-ai/credhelper`.
  - Reads actor identity from relay-injected headers (`x-generacy-actor-user-id`, `x-generacy-actor-session-id`).
  - Error shape: `{ error, code, details? }` — matches credhelper-daemon's `CredhelperErrorResponse`.
  - Crash-tolerant: failures must not block orchestrator boot; relay returns 503 from socket prefix.
  - `src/services/tunnel-handler.ts` — NEW in #519: `TunnelHandler` class for bidirectional byte-streaming between relay WebSocket and code-server's Unix socket. Constructor DI: `RelayMessageSender` (just `send(message): void`), `CodeServerManager`, optional `allowedTarget` (default `/run/code-server.sock`). Methods: `handleOpen()` (target validation, auto-start code-server, connect socket, send `tunnel_open_ack`), `handleData()` (base64 decode, socket write, `touch()` idle reset), `handleClose()` (destroy socket), `cleanup()` (destroy all, stateless across reconnects). Tunnel state stored in `Map<tunnelId, net.Socket>`. Security: rejects any target other than `/run/code-server.sock` with `tunnel_open_ack { status: 'error', error: 'invalid target' }`.
  - `src/services/peer-repo-cloner.ts` — NEW in #530: Clones peer repos during bootstrap wizard step 4. Accepts `{ repos: string[], token?: string }` — cloud forwards `cloneRepos` list (excludes primary). Uses `git clone` with optional `x-access-token` HTTPS pattern for private repos. Emits `cluster.bootstrap` channel events via `setRelayPushEvent` (`{ repo, status: 'cloning'|'done'|'failed' }`). Idempotent: existing dirs at `/workspaces/<name>` skip clone and re-emit `done`. Empty repos array emits `{ status: 'done', message: 'no peer repos' }`.
  - `src/services/default-role-writer.ts` — DELETED in #582: Was handling `set-default-role` lifecycle action from bootstrap wizard step 3. Roles are workspace-level (`.agency/roles/`), not cluster-level. The wizard's "Role Selection" step, `set-default-role` lifecycle action, `/roles/:id` routes, and `SetDefaultRoleBodySchema` all removed.
  - `src/relay-events.ts` — NEW in #530: Extracted `setRelayPushEvent`/`getRelayPushEvent` from `audit.ts` into shared module. Used by both audit route and peer-repo-cloner for relay channel event emission.
  - `LifecycleActionSchema` (#530, modified #582, #584): 7 entries: `bootstrap-complete`, `clone-peer-repos`, `code-server-start`, `code-server-stop`, `stop`, `vscode-tunnel-start`, `vscode-tunnel-stop`. `set-default-role` removed in #582. `SetDefaultRoleBodySchema` deleted. `stop` stays as stub for v1.5.
  - `src/services/vscode-tunnel-manager.ts` — NEW in #584: `VsCodeTunnelProcessManager` manages `code tunnel` child process lifecycle. Mirrors `CodeServerProcessManager` pattern (singleton DI, start/stop, SIGTERM/SIGKILL). Parses device code from stdout via regex (`/[A-Z0-9]{4}-[A-Z0-9]{4}/`). Emits relay events on `cluster.vscode-tunnel` channel: `starting`, `authorization_pending` (with `deviceCode` + `verificationUri`), `connected`, `disconnected`, `error`. No idle timeout (tunnels persist). Options from env: `VSCODE_CLI_BIN` (default `/usr/local/bin/code`), `GENERACY_CLUSTER_ID` (tunnel name). Auto-started on `bootstrap-complete` lifecycle action.

## Cluster Relay

- `packages/cluster-relay/` — WebSocket relay client connecting in-cluster orchestrator to Generacy cloud (`@generacy-ai/cluster-relay`). ESM, Node >=20, deps: `ws`, `zod`.
  - `src/messages.ts` — Zod-validated message types: `ApiRequestMessage`, `ApiResponseMessage`, `HandshakeMessage`, `HeartbeatMessage`, `EventMessage`, `ErrorMessage`, `ConversationMessage`, `TunnelOpenMessage`, `TunnelOpenAckMessage`, `TunnelDataMessage`, `TunnelCloseMessage` (#519). Discriminated union on `type` field via `RelayMessageSchema`.
  - `src/proxy.ts` — Forwards relayed `api_request` messages to orchestrator HTTP. v1.5 #489 extends with path-prefix dispatcher: `routes` array of `{ prefix, target }` (HTTP URL or `unix://` socket), longest-prefix-match, prefix stripping, `orchestratorUrl` as implicit fallback. Actor identity propagated as `x-generacy-actor-user-id`/`x-generacy-actor-session-id` headers.
  - `src/config.ts` — `RelayConfig` loaded from env vars + overrides. v1.5 #489 adds `routes: RouteEntry[]`, `activationCode?`, `clusterApiKeyId?`.
  - `src/relay.ts` — `ClusterRelay` class: WebSocket lifecycle, state machine (disconnected→connecting→authenticating→connected), auto-reconnect with exponential backoff, heartbeat, message dispatch. v1.5 #489 adds `activation` field to handshake.
  - `src/dispatcher.ts` — NEW in #489: pure-function path-prefix dispatcher. `sortRoutes()`, `resolveRoute()`, Unix socket detection.
  - `ClusterRelayClientOptions` (#574): Added `routes?: RouteEntry[]` field. Threaded into `RelayConfigSchema.parse()` in constructor's options branch. Allows orchestrator to configure path-prefix routing without constructing raw `RelayConfig`. Defaults to `[]` (non-breaking).

## Orchestrator Activation

- `packages/orchestrator/src/activation/` — Device-flow activation client for first cluster boot (#492, v1.5 phase 2). Runs before relay handshake in orchestrator startup. If no key file at `/var/lib/generacy/cluster-api-key`, initiates RFC 8628 device-code flow against `GENERACY_CLOUD_URL`.
  - `index.ts` — Public API: `activate(options)` returns `ActivationResult` (apiKey, clusterApiKeyId, clusterId, projectId, orgId, cloudUrl). #517 fix: persists `pollResult.cloud_url` (cloud-returned, not input config) and returns `cloudUrl` on both device-flow and existing-key paths.
  - `client.ts` — HTTP client for `POST /api/clusters/device-code` and `POST /api/clusters/device-code/poll`. Uses native `node:http`/`node:https`.
  - `poller.ts` — Poll loop with `slow_down` (+5s) and `expired` (auto-retry up to 3 cycles) handling.
  - `persistence.ts` — Atomic key-file write (`.tmp` + `rename()`, mode 0600) and `cluster.json` metadata.
  - Cloud URL precedence: `GENERACY_CLOUD_URL` env > derived from relay WSS URL > `https://api.generacy.ai`.
  - Retry budget: 5 retries, exponential backoff (2s-32s, ~62s total) for initial cloud requests.
  - Integration: `server.ts` calls `activate()` before relay construction; sets `config.relay.apiKey` and `config.relay.clusterApiKeyId` from result. #517 fix: also overrides `config.activation.cloudUrl` and `config.relay.cloudUrl` (derived WSS: `https://X` → `wss://X/relay`) from `activationResult.cloudUrl` when present. #567 fix: in wizard mode (no existing API key), activation runs as a background promise so `server.listen()` is not blocked. Relay bridge and conversation manager initialization extracted into `initializeRelayBridge()` and `initializeConversationManager()` helper functions, called asynchronously after activation succeeds. `/health` endpoint responds immediately regardless of activation state.
  - #574 fix: `initializeRelayBridge()` now passes `routes: [{ prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock' }]` to `ClusterRelayClientOptions`. This routes cloud-sent `/control-plane/*` API requests to the control-plane unix socket instead of falling back to the orchestrator (which returned 404). Prefix is stripped by the dispatcher, so `/control-plane/credentials/:id` becomes `/credentials/:id` on the socket.
  - #586 fix: `initializeRelayBridge()` adds second route `{ prefix: '/code-server', target: 'unix:///run/code-server.sock' }` (configurable via `CODE_SERVER_SOCKET_PATH` env). Routes cloud IDE proxy traffic to code-server's Unix socket. Same pattern as #574.

## Open IDE Flow (#586)

- Three independent gaps prevented "Open IDE" from working after bootstrap:
  - **Gap A**: No `codeServerReady` producer — cluster metadata never included the field.
  - **Gap B**: No `/code-server` relay route — cloud IDE proxy traffic fell through to orchestrator (404).
  - **Gap C**: Code-server never started — `bootstrap-complete` only wrote sentinel file.
- `packages/control-plane/src/routes/lifecycle.ts` — `bootstrap-complete` handler triggers `code-server-start` async (fire-and-forget). Response returns immediately; readiness propagated via metadata.
- `packages/orchestrator/src/routes/health.ts` — `/health` endpoint gains `codeServerReady` boolean from `CodeServerManager.getStatus() === 'running'`.
- `packages/cluster-relay/src/metadata.ts` — `collectMetadata` reads `codeServerReady` from `/health` response (handshake/reconnect path).
- `packages/orchestrator/src/services/relay-bridge.ts` — `collectMetadata` queries `CodeServerManager.getStatus()` in-process (periodic metadata path).
- `packages/control-plane/src/services/code-server-manager.ts` — `CodeServerManager` interface gains `onStatusChange(callback)`. On transition to `running`, triggers `RelayBridge.sendMetadata()` for seconds-latency propagation (not 60s heartbeat).
- Cloud-side schema for `codeServerReady` exists top-to-bottom (Firestore, SSE, ReadyStep). No cloud changes needed.
- #588 fix: `DEFAULT_CODE_SERVER_SOCKET` changed from `/run/code-server.sock` to `/run/generacy-control-plane/code-server.sock`. The `/run/` dir is root-owned; reuses existing control-plane tmpfs mount (writable by uid 1000). Orchestrator relay-route fallback in `server.ts` updated to match. `CODE_SERVER_SOCKET_PATH` env var override still works.
- #596 fix: `codeServerReady` was always `false` because orchestrator's `getCodeServerManager()?.getStatus()` queries a module-scoped singleton in its own process, but code-server is started by the control-plane process (separate child process with its own singleton). Fix: replace both callsites (`health.ts:87`, `relay-bridge.ts:501`) with `probeCodeServerSocket()` — an async `net.connect()` probe against the unix socket. New shared helper at `packages/orchestrator/src/services/code-server-probe.ts`. `collectMetadata()` and `sendMetadata()` in `relay-bridge.ts` made async. `cluster-relay/src/metadata.ts` fixed transitively (reads from `/health` over HTTP).

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
  - Shared scaffolder at `commands/cluster/scaffolder.ts` (#518): `scaffoldClusterJson()`, `scaffoldClusterYaml()`, `scaffoldDockerCompose()`, `scaffoldEnvFile()`, `deriveRelayUrl()` — used by both launch and deploy commands. Ensures consistent file formats. #531 fix: `ScaffoldComposeInput` gains `variant` (required) and `deploymentMode` (optional, default `'local'`); generated `docker-compose.yml` now includes `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars. Deploy scaffolder passes `deploymentMode: 'cloud'`. #543 fix: `scaffoldDockerCompose()` rewritten to emit multi-service compose (orchestrator + worker + redis) mirroring cluster-base devcontainer compose. New `scaffoldEnvFile()` generates `.generacy/.env` with cloud-provided identity vars and project defaults. `deriveRelayUrl()` converts HTTP cloud URL to wss relay URL (`https://X` → `wss://X/relay?projectId=<id>`). `ScaffoldComposeInput` gains `orgId`, `workers`, `channel`, `repoUrl`, `claudeConfigMode` ('bind'|'volume'). Launch uses bind mount for `~/.claude.json` (pre-creates if missing); deploy uses named `claude-config` volume. #584: adds `vscode-cli:/home/node/.vscode-cli` named volume to orchestrator service for VS Code tunnel auth persistence across container recreation.
  - #634 fix: `scaffoldDockerCompose()` gains app-config entries matching cluster-base#38: tmpfs `/run/generacy-app-config:mode=1750,uid=1000,gid=1000` (both services), named volume `generacy-app-config-data:/var/lib/generacy-app-config` on orchestrator (rw) and worker (ro), top-level `generacy-app-config-data` declaration. Without these, fresh scaffolded clusters lack app-config persistence and secret env rendering.
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

## Cluster Image Build Workflows (#534, #559)

- `.github/workflows/publish-cluster-base-image.yml` — NEW in #534: Manual `workflow_dispatch` workflow to build and push the `cluster-base` Docker image to GHCR. Checks out `generacy-ai/cluster-base` at a specified ref (`develop` or `main`), maps `develop` -> `:preview` and `main` -> `:stable` tags, pushes to `ghcr.io/generacy-ai/cluster-base`. Also pushes `:sha-<short>` immutable tag. Uses `docker/build-push-action@v6`, `docker/login-action@v3`, `docker/setup-buildx-action@v3`. Permissions: `contents: read`, `packages: write`.
- `.github/workflows/publish-cluster-microservices-image.yml` — NEW in #534: Same shape as cluster-base workflow, targeting `generacy-ai/cluster-microservices` repo and `ghcr.io/generacy-ai/cluster-microservices` image.
- `.github/workflows/poll-cluster-images.yml` — NEW in #559: Cron-poll workflow (`schedule: */5 * * * *`) that auto-detects new commits on `cluster-base` and `cluster-microservices` repos (`develop` and `main` branches) and dispatches the existing publish workflows when HEAD SHA has no matching `sha-*` tag in GHCR. Uses `strategy.matrix` with 4 (repo, branch, image, workflow) tuples. GHCR tags are the source of truth (no external state). Per-(repo, branch) concurrency keys with `cancel-in-progress: false`. Permissions: `contents: read`, `packages: read`, `actions: write`.
- Motivation: Template repos previously contained workflow files that got copied into user-project repos during creation, causing `403 Resource not accessible by integration` errors (GitHub App lacks `Workflows: write`). Moving builds here eliminates that. #559 adds automatic triggering so merges don't sit unpublished until manual dispatch.

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

## Phase 4 Cleanup — Remove `GENERACY_CLOUD_URL` Fallback Chains (#551)

- Removes all `GENERACY_CLOUD_URL` fallback chains added in #549 (Phase 2). After this, the old env var is no longer read anywhere.
- `packages/generacy/src/cli/utils/cloud-url.ts`: `resolveApiUrl()` drops tier-3 `GENERACY_CLOUD_URL` fallback. 3-tier only: flag > `GENERACY_API_URL` > default. `resolveCloudUrl` deprecated alias removed.
- `packages/orchestrator/src/config/loader.ts`: Activation reads only `GENERACY_API_URL` (throws if missing — fail-loud). Relay reads only `GENERACY_RELAY_URL` (falls back to channel-derived URL, not old var).
- `packages/cluster-relay/src/relay.ts`: Comment-only update (env var read happens in orchestrator loader).
- CLI flag rename: `--cloud-url` → `--api-url` (canonical) on both `launch` and `deploy` commands. `--cloud-url` kept as hidden alias with deprecation warning for one release cycle.
- Error messages in `cloud-client.ts` updated to reference `GENERACY_API_URL` / `--api-url`.
- Tests: old `GENERACY_CLOUD_URL` assertions replaced with `GENERACY_API_URL`; negative assertions added verifying old var is not honored.
- SC-001: zero `GENERACY_CLOUD_URL` references in `src/` directories (test files may contain negative assertions only).
- Orchestrator context: `GENERACY_API_URL` required (missing = error). CLI context: keeps `https://api.generacy.ai` default.
- Follow-up issues: remove `--cloud-url` hidden alias after one release; generacy-cloud companion issue for `LaunchConfig.cloudUrl` removal.

## Scoped Docker Socket Proxy (#497, v1.5 phase 9)

- `packages/credhelper-daemon/src/docker-bind-mount-guard.ts` — NEW in #497: Validates `POST /containers/create` bind mounts are under `GENERACY_SCRATCH_DIR`. Inspects both `HostConfig.Binds` (string format) and `HostConfig.Mounts` (object format, `Type: "bind"` only). Uses `path.resolve()` for canonicalization. Only active when `upstreamIsHost=true` (host-socket mode); DinD mode skips validation.
- `packages/credhelper-daemon/src/docker-proxy-handler.ts` — MODIFIED in #497: Buffers `POST /containers/create` body on host-socket to run bind-mount guard before forwarding. 10MB body size limit.
- Per-session scratch directory at `/var/lib/generacy/scratch/<session-id>/` (mode 0700, uid 1001). Created at session begin, cleaned at session end. Exposed as `GENERACY_SCRATCH_DIR` env var.
- Upstream selection: `ENABLE_DIND=true` → `/var/run/docker.sock` (DinD, no bind-mount guard) → `/var/run/docker-host.sock` (host, with bind-mount guard) → warn at boot, fail per-session.
- `buildSessionEnv()` in orchestrator already sets `DOCKER_HOST=unix://<sessionDir>/docker.sock`.

## Credential Persistence in Control-Plane (#558)

- `packages/credhelper/src/backends/` — NEW in #558: Extracted from `credhelper-daemon`. `ClusterLocalBackend`, `CredentialFileStore`, and AES-256-GCM crypto helpers (`encrypt`, `decrypt`, `generateMasterKey`). ~250 LOC. Both credhelper-daemon and control-plane import from this single source of truth.
  - `cluster-local-backend.ts` — `ClusterLocalBackend` implements `WritableBackendClient`. Options: `dataPath` (default `/var/lib/generacy/credentials.dat`), `keyPath` (default `/var/lib/generacy/master.key`). Methods: `init()`, `fetchSecret()`, `setSecret()`, `deleteSecret()`. In-memory cache loaded on `init()`.
  - `crypto.ts` — AES-256-GCM `encrypt`/`decrypt` with per-credential random 12-byte IV, 16-byte auth tag. `generateMasterKey()` returns 32-byte random buffer.
  - `file-store.ts` — `CredentialFileStore`: atomic writes (temp+fsync+rename), fd-based advisory locking via `credentials.dat.lock`, master key auto-generation on first boot.
- `packages/credhelper-daemon/src/backends/` — MODIFIED in #558: Original files replaced with re-exports from `@generacy-ai/credhelper`. Existing daemon code unchanged.
- `packages/control-plane/src/routes/credentials.ts` — MODIFIED in #558: `handlePutCredential` wired to persist credentials. Validates body with Zod (`PutCredentialBodySchema`: `{ type, value }`), calls `ClusterLocalBackend.setSecret()`, writes metadata to `.agency/credentials.yaml`, emits `cluster.credentials` relay event. `handleGetCredential` reads metadata from YAML. Returns 500 with `failedAt` field on partial failure (AD-3: fail forward).
- `packages/control-plane/src/services/credential-writer.ts` — NEW in #558: `writeCredential()` orchestrates secret write + YAML metadata write + relay event emission. Follows `default-role-writer.ts` pattern (atomic YAML writes, `yaml` package).
- Cache coherence: credhelper-daemon restarted on bootstrap-complete (AD-2). Follow-up needed for post-bootstrap credential edit cache reload.

## Orchestrator Boot-Time Service Resume (#824)

- Bug: `generacy stop` explicitly stops the VS Code tunnel + code-server (`vscode-tunnel-stop` + `code-server-stop` lifecycle actions), but on `generacy start` neither service ever restarts. Sole auto-start site is the control-plane `bootstrap-complete` handler, which is only *replayed* by `PostActivationRetryService` when `needsRetry === true`. On a healthy already-activated cluster, `activated && postActivationComplete` → `needsRetry === false` → no replay → tunnel/code-server stay dead.
- Fix: New sibling service `BootResumeService` in `packages/orchestrator/src/services/boot-resume-service.ts`. In `server.ts`'s "existing API key" branch, after `PostActivationRetryService.checkPostActivationState()`, a new `else if (activated && postActivationComplete)` branch instantiates `BootResumeService` and calls `triggerBootResume()`.
- Design (per clarifications, spec `#824`): fires two independent, best-effort lifecycle POSTs concurrently via `Promise.allSettled`:
  - `POST /lifecycle/vscode-tunnel-start`
  - `POST /lifecycle/code-server-start`
- Envelope mirrors `PostActivationRetryService.triggerPostActivationRetry()`: 15 s `probeControlPlaneSocket` wait + 1 POST attempt with 10 s request timeout. No retry loop; UI Restart is the manual backstop.
- Failure surface: reuses `cluster.bootstrap` channel with new payload shape `{ status: 'failed', reason: 'resume-failed', service: 'vscode-tunnel' | 'code-server', error }`. Emitted per-service (each POST can fail independently). Does NOT push `cluster.state = degraded` (divergence from sibling — a failed tunnel restart is not cluster-degraded).
- Runs after `initializeRelayBridge()` so `cluster.vscode-tunnel { status: 'starting' }` events from the tunnel manager reach the cloud on the very first emit.
- Control-plane untouched. Both `VsCodeTunnelProcessManager.start()` and `CodeServerProcessManager.start()` are already idempotent.
- Mutually exclusive with sibling: `needsRetry === true` branch fires `bootstrap-complete` (which starts both services); `needsRetry === false && activated && postActivationComplete` branch fires per-service resumes. No overlap.

## Wire boot-resume into the wizard startup path (#834)

- Bug: #824's `BootResumeService` wiring was added only to `createServer()`'s "existing API key" branch (`server.ts:447-503`). Wizard-provisioned clusters boot with `config.relay.apiKey === undefined` (the key persists to `/var/lib/generacy/cluster-api-key` and is reloaded during activation), so they take the `activateInBackground()` branch (`server.ts:433, :799`), which only handles the retry half of the decision matrix (`server.ts:879-896`). Net: on every wizard-cluster stop/start, `BootResumeService` never fires and #824's fix is unreachable.
- Fix: `packages/orchestrator/src/services/post-activation-dispatch.ts` — NEW. Exports `runPostActivationBranch({ logger, sendRelayEvent })` that owns the entire retry/resume/noop decision (internally constructs `PostActivationRetryService`, calls `checkPostActivationState()`, dispatches to `triggerPostActivationRetry()` / `triggerBootResume()` / no-op). Returns `DispatchOutcome = 'retry' | 'resume' | 'noop'` for observability + test hooks. Both `server.ts` branches collapse to a single `await runPostActivationBranch(...)` call — regression is impossible by construction (no per-branch `if/else` to skew).
- Prod call sites pass only `{ logger, sendRelayEvent }`; the two optional `retryServiceFactory` / `resumeServiceFactory` fields on `DispatchOptions` are test-only injection seams for the helper unit test.
- Fire-and-forget preserved: helper does NOT await `triggerPostActivationRetry()` / `triggerBootResume()` — both remain `.catch(logger)`-guarded promises exactly as in `server.ts` today.
- Regression coverage: `packages/orchestrator/src/__tests__/server-boot-resume-wizard-branch.test.ts` — NEW, load-bearing per clarifications Q3→A. Drives `createServer()` with empty `config.relay.apiKey` (forces wizard branch), stubs `activate()` + control-plane + `checkPostActivationState()` → `{ activated: true, postActivationComplete: true, needsRetry: false }`, asserts `BootResumeService.triggerBootResume` fires. Deleting the resume dispatch from either the helper or the wizard call site makes this test fail (SC-003). Optional Q3→C complement: `post-activation-dispatch.test.ts` unit tests the full retry / resume / noop matrix by direct import.
- `PostActivationRetryService`, `BootResumeService`, control-plane, lifecycle handlers, and relay wiring all UNCHANGED — this is purely a call-site consolidation + regression test.

## Bootstrap-Complete Lifecycle Action (#562)

- `packages/control-plane/src/schemas.ts` — MODIFIED in #562: `LifecycleActionSchema` enum extended from 5 to 6 entries, adding `'bootstrap-complete'`.
- `packages/control-plane/src/routes/lifecycle.ts` — MODIFIED in #562: New handler branch for `bootstrap-complete` action. Writes empty sentinel file at `POST_ACTIVATION_TRIGGER` env var path (default `/tmp/generacy-bootstrap-complete`). Idempotent via `flag: 'w'` overwrite. Returns `{ accepted: true, action, sentinel }`. No request body required.
- Sentinel file triggers `post-activation-watcher.sh` (cluster-base#22) which runs `entrypoint-post-activation.sh` for workspace clone and setup.
- Completes the wire between cloud wizard ReadyStep (generacy-cloud#532) and cluster post-activation flow.

## Wizard Credentials Env Bridge (#589, #592, #628)

- `packages/control-plane/src/services/wizard-env-writer.ts` — NEW in #589, MODIFIED in #592, #628: `writeWizardEnvFile()` unseals wizard-stored credentials and writes them to a transient env file at `/var/lib/generacy/wizard-credentials.env` (mode 0600). Reads credential IDs/types from `.agency/credentials.yaml`, calls `ClusterLocalBackend.fetchSecret()` for each, maps to env var names (e.g., `github-app` → `GH_TOKEN` + `GH_USERNAME` + `GH_EMAIL`, `anthropic` pattern → `ANTHROPIC_API_KEY`). Best-effort: partial unseal failures write partial file + emit `cluster.bootstrap` relay warning.
  - #592 fix: `mapCredentialToEnvEntries` splits `github-app` and `github-pat` into separate branches. `github-app` values are JSON-parsed to extract the `token` field (cloud sends `{ installationId, token, accountLogin, ... }`). Returns `[]` on parse failure or missing token (fail-safe). `github-pat` continues to use raw value directly.
  - #628 fix: `mapCredentialToEnvEntries` `github-app` branch also extracts `accountLogin` from the JSON credential value. When present and non-empty, emits `GH_USERNAME=<accountLogin>` and `GH_EMAIL=<accountLogin>@users.noreply.github.com`. Missing `accountLogin` gracefully falls back to `GH_TOKEN` only. Enables automatic git identity configuration via `setup-credentials.sh` in cluster-base.
- `packages/control-plane/src/routes/lifecycle.ts` — MODIFIED in #589: `bootstrap-complete` handler calls `writeWizardEnvFile()` before writing sentinel file. Env file write failure is non-fatal (logged, continues to sentinel).
- Env file consumed by `entrypoint-post-activation.sh` (cluster-base companion PR) which sources it with `set -a; source $WIZARD_CREDS; set +a` then deletes it.
- Root cause: wizard credentials stored encrypted in `credentials.dat` via `PUT /credentials/:id`, but post-activation bash scripts check `$GH_TOKEN` env var — nothing in the bootstrap flow exported tokens as process env vars.

## Control-Plane Relay Event IPC (#594)

- Bug: control-plane process never calls `setRelayPushEvent()` — all relay events (`cluster.vscode-tunnel`, `cluster.audit`, `cluster.credentials`) emitted from control-plane are silently dropped because `getRelayPushEvent()` returns `undefined`.
- Root cause: control-plane and orchestrator are separate processes (no shared memory). Orchestrator owns the `ClusterRelay` WebSocket client but control-plane has no IPC channel to reach it.
- Fix: HTTP-based IPC channel from control-plane to orchestrator.
  - `packages/orchestrator/src/server.ts` — MODIFIED in #594: New `POST /internal/relay-events` Fastify route. Accepts `{ channel, payload }`, validates with Zod, forwards via `relayClient.send({ type: 'event', channel, event: payload })`. Authenticated via `ORCHESTRATOR_INTERNAL_API_KEY` added to `apiKeyStore` (follows existing `relayInternalKey` pattern at line ~628).
  - `packages/control-plane/bin/control-plane.ts` — MODIFIED in #594: Reads `ORCHESTRATOR_INTERNAL_API_KEY` and `ORCHESTRATOR_URL` (default `http://127.0.0.1:3100`) env vars. Calls `setRelayPushEvent()` with an HTTP callback that POSTs to `/internal/relay-events`. Fire-and-forget with `.catch(log)`.
  - Companion change in `cluster-base` entrypoint: `entrypoint-orchestrator.sh` generates ephemeral UUID key via `uuidgen`, exports as `ORCHESTRATOR_INTERNAL_API_KEY` before spawning both processes.
  - Graceful degradation: if `ORCHESTRATOR_INTERNAL_API_KEY` is unset, logs warning and continues (existing `if (pushEvent)` guards remain).

## Wizard-Mode Relay Bridge Fix (#598)

- Bug: In wizard mode (`!config.relay.apiKey` at startup), `setupInternalRelayEventsRoute()` is called inside `initializeRelayBridge()` **after** `server.listen()`. Fastify rejects post-listen route registration, causing the entire relay bridge initialization to fail silently. Cluster stays offline; wizard shows "Cluster is not reachable".
- Root cause: PR #594 added route registration as a side-effect inside `initializeRelayBridge()`, which runs after `server.listen()` in wizard mode (#567 background activation path).
- Fix: Deferred binding pattern — register `/internal/relay-events` route and `ORCHESTRATOR_INTERNAL_API_KEY` in `apiKeyStore` **before** `server.listen()` in `createServer()`. Route handler uses a getter `() => ClusterRelayClient | null` instead of a direct client reference. Returns 503 before activation completes. `initializeRelayBridge()` assigns the client ref post-activation via setter callback; no longer calls `server.post()` or registers API keys.
- `packages/orchestrator/src/routes/internal-relay-events.ts` — MODIFIED in #598: `setupInternalRelayEventsRoute` signature changed to accept `getRelayClient: () => ClusterRelayClient | null`. Returns 503 with `{ error: "relay not yet initialized" }` when getter returns null.
- `packages/orchestrator/src/server.ts` — MODIFIED in #598: Route registration and API key moved from `initializeRelayBridge()` to `createServer()` (before `server.listen()`). Mutable `relayClientRef` closed over by getter. `initializeRelayBridge()` takes optional setter callback to assign client ref post-activation.

## EventMessage Wire-Shape Fix (#600)

- Bug: `POST /internal/relay-events` handler constructs EventMessage with swapped field names (`channel`/`event` instead of `event`/`data`), causing all relay events forwarded from control-plane to be silently dropped by the cloud.
- Root cause: #594 used local `EventMessage` interface field names (`{ channel, event }`) but the cloud expects wire format `{ event: channelName, data: payload, timestamp: ISO }`. The `as unknown as RelayMessage` double-cast hid the type mismatch.
- Fix: `packages/orchestrator/src/routes/internal-relay-events.ts` — change `client.send()` call to use `event: channel, data: payload, timestamp: new Date().toISOString()`. Cast retained because `EventMessage` interface update is out of scope (#572).
- Affects all four IPC channels: `cluster.vscode-tunnel`, `cluster.audit`, `cluster.credentials`, `cluster.bootstrap`.

## VS Code Tunnel Name Derivation (#608)

- Bug: `code tunnel --name <cluster-uuid>` fails on fresh clusters because Microsoft's tunnel service rejects names longer than 20 characters. Cluster UUIDs are 36 chars.
- `packages/control-plane/src/services/vscode-tunnel-manager.ts` — MODIFIED in #608: New exported `deriveTunnelName(clusterId)` pure function: strips hyphens, prefixes `g-`, takes first 18 hex chars (total 20). `loadOptionsFromEnv()` calls `deriveTunnelName()` instead of passing raw cluster ID. For UUID `9e5c8a0d-755e-40b3-b0c3-43e849f0bb90`, yields `g-9e5c8a0d755e40b3b0`.
- Web-side deep link fix is a companion issue in generacy-cloud (reads `tunnelName` from relay event instead of recomputing).

## Orchestrator GitHub Monitors Credential Resolution (#620)

- Decouples orchestrator GitHub monitors from ambient `gh auth` state by injecting tokens explicitly via `tokenProvider` pattern.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — MODIFIED in #620: `GhCliGitHubClient` constructor gains `tokenProvider?: () => Promise<string | undefined>`. Each `gh` CLI method resolves token before `executeCommand` and passes `{ env: { GH_TOKEN } }` in options.
- `packages/workflow-engine/src/actions/github/client/interface.ts` — MODIFIED in #620: `GitHubClientFactory` type gains optional `tokenProvider` parameter.
- `packages/orchestrator/src/services/wizard-creds-token-provider.ts` — NEW in #620: `createWizardCredsTokenProvider(envFilePath, logger)` returns `() => Promise<string | undefined>`. Re-reads `/var/lib/generacy/wizard-credentials.env` on `mtime` change. State-transition logging: one warning when resolution starts failing, one info when it resumes.
- `packages/orchestrator/src/server.ts` — MODIFIED in #620: Creates wizard-creds token provider, passes to `PrFeedbackMonitorService`, `LabelMonitorService`, `LabelSyncService`, `WebhookSetupService` constructors.
- `packages/orchestrator/src/services/webhook-setup-service.ts` — MODIFIED in #620: Resolves token before `executeCommand('gh', ...)` calls, passes `GH_TOKEN` in env option.
- Worker-process callers (`claude-cli-worker.ts`, `pr-feedback-handler.ts`) pass `undefined` for `tokenProvider` — they use credhelper session env.
- Token source: `/var/lib/generacy/wizard-credentials.env`, kept fresh by `handlePutCredential` (#614) on cloud-pushed credential refreshes.

## Control-Plane Daemon Crash Resilience (#624)

- Prevents zombie cluster state when `AppConfigEnvStore.init()` throws EACCES (uid 1000 can't write `/var/lib/generacy-app-config/`). Two fixes:
- **Store resilience**: `AppConfigEnvStore` and `AppConfigFileStore` catch EACCES on preferred path, fall back to `/tmp/generacy-app-config/`. If both fail, store enters disabled/no-op mode: GETs return empty shape, PUTs return 503 `{ error: 'app-config-store-disabled' }`.
  - `packages/control-plane/src/types/init-result.ts` — NEW in #624: `StoreStatus` (`'ok' | 'fallback' | 'disabled'`), `StoreInitResult`, `InitResult`, `StoreDisabledError` types.
  - `packages/control-plane/src/services/app-config-env-store.ts` — MODIFIED in #624: `init()` catches EACCES/EPERM/EROFS, tries `/tmp/generacy-app-config/env` fallback, enters disabled mode on double failure. `getStatus()`/`getInitResult()` accessors. `set()` throws `StoreDisabledError` when disabled; `getAll()` returns `[]`.
  - `packages/control-plane/src/services/app-config-file-store.ts` — MODIFIED in #624: Same fallback + disabled pattern as AppConfigEnvStore.
  - `packages/control-plane/bin/control-plane.ts` — MODIFIED in #624: Structured init sequence — each store initialized individually with try/catch, emits JSON log lines per store (`{ event: 'store-init', store, status, path?, reason? }`). Writes aggregated `InitResult` to `/run/generacy-control-plane/init-result.json`. Daemon continues running regardless of store status.
- **Orchestrator detection**: New `probeControlPlaneSocket()` helper mirrors `probeCodeServerSocket()`. Health endpoint and relay metadata gain `controlPlaneReady` and `initResult` fields. Startup socket-wait with error push + grace exit.
  - `packages/orchestrator/src/services/control-plane-probe.ts` — NEW in #624: `probeControlPlaneSocket(socketPath?, timeoutMs?)` → `Promise<boolean>`. Same `net.connect()` pattern as `code-server-probe.ts`. Default socket: `/run/generacy-control-plane/control.sock`, env var: `CONTROL_PLANE_SOCKET_PATH`, timeout: 500ms.
  - `packages/orchestrator/src/routes/health.ts` — MODIFIED in #624: Adds `controlPlaneReady: boolean` field from `probeControlPlaneSocket()`.
  - `packages/orchestrator/src/types/relay.ts` — MODIFIED in #624: `ClusterMetadataPayload` gains optional `controlPlaneReady?: boolean` and `initResult?: { stores: Record<string, StoreStatus>; warnings: string[] }`.
  - `packages/orchestrator/src/services/relay-bridge.ts` — MODIFIED in #624: `collectMetadata()` calls `probeControlPlaneSocket()`, reads `init-result.json` for relay metadata.
  - `packages/cluster-relay/src/metadata.ts` — MODIFIED in #624: Reads `controlPlaneReady` from orchestrator `/health` response.
  - `packages/orchestrator/src/server.ts` — MODIFIED in #624: After `server.listen()`, polls `probeControlPlaneSocket()` every 1s for `CONTROL_PLANE_WAIT_TIMEOUT` (default 15s). On timeout: pushes `error` status via relay with reason, waits ~30s grace window, then `process.exit(1)`.

## Multi-Repo Workflow Support — Phase 1 (#687)

- Foundational change: widens `ActionContext` and `ExecutionOptions` to carry `siblingWorkdirs: Record<string, string>` (repo name → absolute path) for cross-repo workflow support. Not user-visible on its own; consumers land in Phase 2.
- `packages/config/src/repos.ts` — NEW function `resolveSiblingWorkdirs(config, primaryWorkdir, basePath?)`: Builds sibling map from `WorkspaceConfig.repos`. Derives base path from `dirname(primaryWorkdir)`. Excludes primary (path-match via `realpathSync`). Skips non-existent siblings. Returns `{}` if primary can't be identified (fail closed).
- `packages/workflow-engine/src/types/action.ts` — MODIFIED in #687: `ActionContext` gains `siblingWorkdirs: Record<string, string>` (non-optional, defaults to `{}`).
- `packages/workflow-engine/src/types/execution.ts` — MODIFIED in #687: `ExecutionOptions` gains optional `siblingWorkdirs?: Record<string, string>`.
- `packages/workflow-engine/src/executor/index.ts` — MODIFIED in #687: `execute()` caches sibling map once per run; `createActionContext()` threads it to every step.
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — MODIFIED in #687: Resolves sibling map from workspace config after checkout, passes via `CliSpawnOptions`.
- `packages/orchestrator/src/worker/types.ts` — MODIFIED in #687: `CliSpawnOptions` gains `siblingWorkdirs?: Record<string, string>`.
- `packages/orchestrator/src/worker/cli-spawner.ts` — MODIFIED in #687: Forwards `siblingWorkdirs` to `AgentLauncher.launch()`.
- Architecture: Caller-injection pattern — orchestrator resolves map, workflow-engine stays decoupled from `@generacy-ai/config`.

## Multi-Repo Workflow Support — Phase 2 (#690)

- Generic `phase:after` extension hook for post-phase callbacks in the phase loop. Enables registering post-phase behavior (like multi-repo fan-out in Issue E / #691) without modifying phase-loop.ts directly.
- `packages/orchestrator/src/worker/types.ts` — MODIFIED in #690: New types `PhaseAfterContext` (extends `WorkerContext` with `phase: WorkflowPhase` and `commitResult: CommitResult`), `CommitResult` (`{ prUrl?: string; hasChanges: boolean }`), `PhaseAfterHandler` (async function receiving `PhaseAfterContext`).
- `packages/orchestrator/src/worker/phase-loop.ts` — MODIFIED in #690: `PhaseLoopDeps` gains optional `phaseAfterHandlers?: PhaseAfterHandler[]`. Handlers invoked sequentially after `commitPushAndEnsurePr()` + `PHASES_REQUIRING_CHANGES` check + `labelManager.onPhaseComplete()`, before gate check. Fail-fast: first handler that throws stops remaining handlers and blocks the phase. Handlers do NOT run at implement increment boundaries or retry paths — only normal phase completion.
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — MODIFIED in #690: Passes `phaseAfterHandlers` (empty array initially) to `PhaseLoopDeps`. Registration point for future handlers.
- Blocks #691 (multi-repo fan-out handler registers through this hook).

## Multi-Repo Workflow Support — Phase 3 (#692)

- Review-phase coordination for multi-repo workflows. Three components: ready-for-review sync, `on-sibling-review` gate condition, and multi-gate-per-phase support.
- `packages/orchestrator/src/worker/types.ts` — MODIFIED in #692: `GateDefinition.condition` union gains `'on-sibling-review'`. `WorkerContext` gains optional `linkedPRs?: LinkedPR[]` (imported from `@generacy-ai/workflow-engine`).
- `packages/orchestrator/src/worker/config.ts` — MODIFIED in #692: `GateDefinitionSchema` condition enum gains `'on-sibling-review'`. Default `speckit-feature` gates gain `{ phase: 'implement', gateLabel: 'waiting-for:sibling-review', condition: 'on-sibling-review' }`.
- `packages/orchestrator/src/worker/gate-checker.ts` — MODIFIED in #692: New `checkGates()` method returns `GateDefinition[]` (all matching gates for a phase via `.filter()`). Original `checkGate()` preserved (returns first match).
- `packages/orchestrator/src/worker/phase-loop.ts` — MODIFIED in #692: Gate evaluation refactored to iterate all gates from `checkGates()`. For `on-sibling-review` condition: calls `checkSiblingReviews()` on `context.linkedPRs`. When gate activates, flips all sibling drafts to ready-for-review before pausing.
- `packages/orchestrator/src/worker/pr-manager.ts` — MODIFIED in #692: `markReadyForReview()` extended to iterate `linkedPRs`, parse each URL for owner/repo, call `gh pr ready` per sibling (idempotent, best-effort).
- `packages/orchestrator/src/worker/sibling-review-checker.ts` — NEW in #692: `checkSiblingReviews(linkedPRs, github, logger)` → `SiblingReviewResult`. Queries `reviewDecision` via `gh pr view --json reviewDecision` per linked PR. Returns `{ allApproved, statuses[] }`. Empty `linkedPRs` → immediately `allApproved: true`.
- `packages/orchestrator/src/worker/linked-pr-url-parser.ts` — NEW in #692: `parsePRUrl(url)` → `ParsedPRUrl | null`. Regex extracts owner/repo/number from GitHub PR URL.
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — MODIFIED in #692: Loads `linkedPRs` from workflow state store after phase-after handlers, threads to `WorkerContext.linkedPRs`.

## Cluster-Side GH_TOKEN Expiry Detection and Refresh Backstop (#762)

- Backstop for expired/refresh-failed `GH_TOKEN` so the cluster makes the failure observable and requests a refresh proactively. Independent of cloud's primary refresh path (this is the safety net).
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — MODIFIED in #762: `executeGh` parses stderr for `HTTP\s+(\d{3})` and throws new `GhAuthError` (exported alongside the client) on HTTP 401. All other error paths unchanged so callers see today's behavior.
- `packages/orchestrator/src/types/github-auth.ts` — NEW in #762: `GitHubAuthStatus` (`'ok' | 'failing' | 'unknown'`), `GitHubAuthSnapshot`, `PerCredentialState`, `CredentialDescriptor`, `CredentialsEventPayload` discriminated union (`refresh-requested` / `auth-failed` / `auth-recovered`), and Zod schemas mirroring `specs/762-summary-when-cluster-s/contracts/`.
- `packages/orchestrator/src/services/github-auth-health.ts` — NEW in #762: `GitHubAuthHealthService` owns per-credential auth state with state machine (`unknown→ok`, `unknown→failing`, `ok→failing` emits `auth-failed`, `failing→ok` emits `auth-recovered`, `failing→failing` increments counter only). `maybeRequestRefresh(credId, reason)` enforces 60s per-credential rate limit and emits `refresh-requested` on `cluster.credentials`. `snapshot()` selection rule: failing > ok > unknown, lexicographic tiebreak.
- `packages/orchestrator/src/services/label-monitor-service.ts` + `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — MODIFIED in #762: `pollRepo()` catch branches catch `GhAuthError` distinctly **before** generic catch, log structured `warn` (`{ credentialId, statusCode: 401 }`), and call `authHealth.recordResult(credId, { ok: false, statusCode: 401 })`. Non-401 paths unchanged. Both services accept `AuthHealthSink` and `githubAppCredentialId` via constructor (defaults to no-op for backwards compatibility).
- `packages/orchestrator/src/services/credential-expiry-watcher.ts` — NEW in #762: 60s timer reads `<agencyDir>/credentials.yaml` (mtime-cached), iterates credentials and calls `health.maybeRequestRefresh(id, 'near-expiry')` when `expiresAt - now <= 5 min`. All errors swallowed + warn-logged; timer never throws (D9).
- `packages/orchestrator/src/server.ts` — MODIFIED in #762: Constructs `GitHubAuthHealthService` after relay client ref is available (silent drop when ref is null per D2), wires real `emitEvent` callback for `cluster.credentials` channel, resolves first `github-app` credential ID from `.agency/credentials.yaml` once at startup, injects into both monitors. Starts `CredentialExpiryWatcher` after relay wiring; registers `.stop()` in graceful shutdown.
- `packages/orchestrator/src/routes/health.ts` — MODIFIED in #762: `/health` response gains optional `githubAuth: GitHubAuthSnapshot` field (declared in both 200 and 503 Fastify schemas; only `status` and `consecutiveFailures` required, other sub-fields optional per D7).
- Reads `cluster.credentials` channel from `internal-relay-events.ts` allowlist (already present, verified in T042). Companion cloud-side consumer for `action: 'refresh-requested'` tracked in separate generacy-cloud issue.

## Cluster-side JIT Git Credential Helper (#766)

- Replaces the static `wizard-credentials.env` `GH_TOKEN` as the source of truth for **git** auth with an on-demand credential helper. Eliminates mid-workflow expiry by fetching a fresh installation token *at the moment* `git clone`/`fetch`/`push` runs.
- `packages/control-plane/src/services/git-token-manager.ts` — NEW in #766: Singleton in-memory cache of `{ token, expiresAt }`. `getToken(credentialId)` serves from cache when `expiresAt - now > 5 min`, otherwise synchronously refreshes from the cloud pull endpoint. Concurrent callers share a single in-flight Promise (no thundering herd against the cloud). No background timer in v1 — synchronous-on-demand only.
- `packages/control-plane/src/services/cloud-pull-client.ts` — NEW in #766: Minimal `node:https` client for generacy-cloud#817. `Authorization: Bearer <cluster-api-key>` (key read from `/var/lib/generacy/cluster-api-key`). Maps HTTP outcomes to `GitHelperErrorCode` (`CLUSTER_API_KEY_MISSING`/`CLOUD_UNREACHABLE`/`CLOUD_AUTH_REJECTED`/`CLOUD_REQUEST_INVALID`/`CLOUD_UPSTREAM_ERROR`/`CLOUD_RESPONSE_INVALID`). Reads cloud base URL from `GENERACY_API_URL` (v1.5 canonical).
- `packages/control-plane/src/services/cluster-api-key.ts` — NEW in #766: Reads `/var/lib/generacy/cluster-api-key` with mtime-based cache invalidation (mirrors `wizard-creds-token-provider.ts`).
- `packages/control-plane/src/routes/git-token.ts` — NEW in #766: `POST /git-token` on the control socket. Returns `{ token, expiresAt }` on 200; existing control-plane error shape on 4xx/5xx. Telemetry: structured JSON log lines (`event: git-token-get`, `event: git-token-cloud-pull`) — tokens never logged.
- `packages/control-plane/bin/git-credential-generacy.ts` — NEW in #766: CLI bin. Speaks the git credential-helper line protocol (`get`/`store`/`erase`). On `get`, connects to the control socket, POSTs `/git-token`, prints `username=x-access-token\npassword=<token>\n`. `store`/`erase` are no-ops. Non-zero exit + `generacy-git-helper: <CODE>: <msg>` on stderr for any failure (FR-008 loud-failure). Distinct exit codes per failure mode (2–9). No on-disk credential read — does not fall back to `GH_TOKEN`.
- `packages/control-plane/bin/control-plane.ts` — MODIFIED in #766: Instantiates `clusterApiKeyReader`, `cloudPullClient`, `gitTokenManager` and injects via `setGitTokenManager()` before `server.start()`. Resolves default `github-app` credential ID once at startup from `.agency/credentials.yaml` (falls back to literal `'github-app'`). Emits `{ event: 'git-token-init', defaultCredentialId, apiUrlConfigured }`.
- Constants: `REFRESH_WINDOW_MS = 5 * 60_000`. Cache scope: single-token in v1 (multi-credential is a `Map<credentialId, …>` change; public API already takes `credentialId`).
- Companion wiring (cluster-base#61, out of scope for this repo): `git config --global credential.https://github.com.helper /usr/local/bin/git-credential-generacy`, remove static token seeding from `~/.git-credentials`/`~/.netrc`. Helper is built and installable independently; SC-002 ("0 static git tokens on disk") requires the companion PR.
- Blocking upstream: generacy-cloud#817 (cloud on-demand installation-token pull endpoint must accept the cluster API key as caller credential).

## Worker-side git-token Proxy Bin (#768)

- Moves the worker-side `git-token-proxy` from a standalone cluster-base script (`.devcontainer/generacy/scripts/git-token-proxy.js`, ~138 LOC, untested) into `@generacy-ai/control-plane` as a third bin, version-locked to the `POST /git-token` route it forwards. Privilege boundary: workers (uid 1001 / `node` group) reach only `POST /git-token`; every other method/path returns 404 with no upstream contact.
- `packages/control-plane/bin/git-token-proxy.ts` — NEW in #768: thin entry. Parses env (`GIT_TOKEN_PROXY_SOCKET` default `/run/generacy-git-token/control.sock`, `CONTROL_PLANE_SOCKET_PATH` default `/run/generacy-control-plane/control.sock`), creates `http.Server`, unlinks stale listen socket, binds, `chmod 0660`, registers `SIGTERM`/`SIGINT` graceful shutdown (5s timeout → `process.exit(1)`). Does NOT `mkdir` the parent of the listen socket — cluster-base entrypoint owns the tmpfs (clarification Q1); bind failure → structured stderr line + non-zero exit.
- `packages/control-plane/src/git-token-proxy/handler.ts` — NEW in #768: pure-function request handler. Calls `isAllowedRoute`, `pickAllowedHeaders`, buffers body up to `MAX_BODY_BYTES = 64 * 1024` (413 on overflow), forwards via `http.request({ socketPath: upstream, … })` with `UPSTREAM_TIMEOUT_MS = 30_000` (502 `CONTROL_SOCKET_UNREACHABLE` on timeout / transport error via `mapUpstreamErrorToCode`). Transparent passthrough of upstream status + body on success.
- `packages/control-plane/src/git-token-proxy/allowlists.ts` — NEW in #768: `isAllowedRoute(method, url)` (only `POST /git-token`; trailing slash significant; query stripped) + `pickAllowedHeaders(headers)` (only `content-type` + `content-length`, lowercased; `content-length` recomputed from buffered body length, not copied from inbound).
- `packages/control-plane/src/git-token-proxy/upstream-errors.ts` — NEW in #768: `mapUpstreamErrorToCode(err)` collapses every transport failure (ECONNREFUSED / ENOENT / ECONNRESET / EPIPE / timeout / generic) to single `CONTROL_SOCKET_UNREACHABLE` code.
- `packages/control-plane/src/git-token-proxy/logging.ts` — NEW in #768: exactly two stdout JSON event types: `{ event: 'git-token-proxy-init', listenSocket, upstreamSocket }` at start + `{ event: 'git-token-proxy-upstream-error', code }` on upstream failure. No per-request log, no body/header/token content ever (clarification Q3).
- `packages/control-plane/package.json` — MODIFIED in #768: `bin` field gains `"git-token-proxy": "./dist/bin/git-token-proxy.js"`.
- Tests: pure-function vitest tests under `__tests__/bin/git-token-proxy/` (allow-list, header allow-list, body cap, upstream-error mapping) plus one POSIX-only Unix-socket smoke test for bind / `0660` mode / wire-level single-route enforcement / SIGTERM cleanup (clarification Q4 hybrid).
- Companion cluster-base PR: updates `entrypoint-orchestrator.sh` to launch `/shared-packages/node_modules/@generacy-ai/control-plane/dist/bin/git-token-proxy.js` and removes the bundled script. Land #768 first so the bin exists.

## Cockpit `advance` bare-number acceptance & error-copy refresh (#850)

- `cockpit advance <ref>` violated the unified issue-ref grammar (#807 Q5, #822): it rejected bare numbers (`advance 2 --gate implementation-review`) and its rejection message pointed at the removed `cockpit.repos` config (deleted in #806). `cockpit context` had the same skew one directory over.
- Root cause: both verbs called `parseIssueRef` directly instead of the shared `resolveIssueContext` wrapper that `status`/`watch`/`queue`/`merge` adopted in #822. The bare-number gate + FR-002 copy live inside `parseIssueRef`; the `try/catch` fall-through in `resolveIssueContext` at `resolver.ts:153` detected the case by regex-matching the thrown message (`/bare issue number/.test`).
- Fix (per clarifications Q1 → C, Q2 → C, Q3 → A, Q4 → A):
  - `packages/generacy/src/cli/commands/cockpit/resolver.ts` — MODIFIED: `parseIssueRef` narrowed to strict qualified-forms-only parser (owner/repo#N + URL). `BARE_NUMBER` gate moves *out* of `parseIssueRef` and *into* `resolveIssueContext` as the first branch. `/bare issue number/.test(message)` sentinel deleted. Redundant `Number.parseInt` + `Number.isInteger` re-check deleted (regex + `makeRef`'s `> 0` cover it). `parseIssueRef` marked `@internal` in JSDoc.
  - `packages/generacy/src/cli/commands/cockpit/advance.ts` — MODIFIED: swap `parseIssueRef(issue)` → `resolveIssueContext({ issue, runner })`, source `gh` from the ctx bundle (FR-001).
  - `packages/generacy/src/cli/commands/cockpit/context.ts` — MODIFIED: identical swap (FR-005 second offender).
  - `.eslintrc.json` — MODIFIED: new `overrides` entry for `packages/generacy/src/cli/commands/cockpit/**/*.ts` (excluding `resolver.ts` and `__tests__/`) with `no-restricted-imports.paths[]` entry `{ name: "./resolver.js", importNames: ["parseIssueRef"], message: ... }` naming `resolveIssueContext` as the correct import (FR-006). Existing `child_process` / `node:child_process` entries carried forward — overrides replace, they don't merge.
- FR-002 rejection copy (single inline sentence, `parse issue: ` prefix retained): `bare issue number "N" is not accepted here. Accepted: <owner>/<repo>#N, a full issue URL, or a bare number inside a checkout with a resolvable GitHub origin. (cwd-origin inference failed: <inner reason>)`. No `cockpit.repos` or `repos are not configured` substrings anywhere in `packages/generacy/src/` (SC-002 + SC-003 satisfied).
- Fallback for FR-006: if `paths[].importNames` unsupported by CI ESLint version, swap to `patterns[]` with `group: ["**/resolver.js"]` (documented in `contracts/eslint-rule.md`).

## Pause-Paired Resume-Dedupe Clear (#849)

- Bug: `PhaseTrackerService` writes `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` with a 24h TTL when a resume event is enqueued (`label-monitor-service.ts:339`). Legitimate same-gate re-visits within 24h (PR-feedback re-review after request-changes; requeued issues) hit the residual key and strand silently. The `type === 'process'` path clears its stale dedupe before checking (`label-monitor-service.ts:278-280`); the `resume` path did not.
- Fix: pair the DEL with the pause lifecycle, not the resume check. When `LabelManager.onGateHit(phase, gateLabel)` successfully applies `waiting-for:<gate>`, it clears the paired `resume:<gate>` dedupe key. TTL stays as a 24h backstop only.
- `packages/orchestrator/src/worker/label-manager.ts` — MODIFIED in #849: `LabelManager` gains optional `clearResumeDedupe?: (gate: string) => Promise<void>` ctor arg + new `ClearResumeDedupeCallback` exported type. `onGateHit` invokes the callback with `gateSuffix` **after** `retryWithBackoff(removeLabels + addLabels)` returns success (FR-009 / Q1→A — asymmetric partial failure: never clear a dedupe for a pause that didn't manifest on the issue). One-shot, best-effort: try/catch wraps the callback, errors logged at `warn` and swallowed (FR-010 / Q2→A). Emits `logger.info(..., 'Cleared paired resume dedupe on pause')` on success and `logger.warn(...)` on swallowed failure with `{ phase, gateLabel, owner, repo, issueNumber }` fields (FR-011 / Q4→A).
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — MODIFIED in #849: `ClaudeCliWorkerDeps` gains optional `phaseTracker?: PhaseTracker`. At `new LabelManager(...)` site (~line 406), passes a closure that calls `phaseTracker.clear(item.owner, item.repo, item.issueNumber, ` `resume:${gate}` `)`. `LabelManager` stays Redis-free (Q3→A — narrow callback vs. injecting `PhaseTrackerService` directly).
- `packages/orchestrator/src/server.ts` — MODIFIED in #849: worker-mode branch (~line 291) instantiates `PhaseTrackerService(server.log, redisClient)` when `redisClient` is available and threads it via `ClaudeCliWorkerDeps.phaseTracker`. Full-mode `PhaseTrackerService` instantiation at line 347 unchanged; both instances share the same Redis keyspace + key layout, so paired-clear invalidates the same keys `markProcessed` wrote.
- Single-cycle protection preserved (FR-008): within one pause→resume cycle, `onGateHit` fires once → paired-clear runs once → subsequent resume triggers within the same cycle still hit `isDuplicate → true` because no further pause has fired. The fix runs at *pause start*, not at *resume check*.
- Non-changes: `PhaseTrackerService` interface + impl unchanged; `label-monitor-service.ts:273-282` `process` clear pattern unchanged (FR-005); `label-monitor-service.ts:339` `markProcessed` after enqueue unchanged; TTL default 86400s unchanged (FR-006); Redis key layout unchanged.

## Cockpit `resume` — re-arm a failed phase (#891, planning phase)

- New cockpit verb `generacy cockpit resume <issue-ref>` planned. Engine-owned label surgery that clears `agent:error` / `failed:<phase>` / stray `phase:<phase>`, then applies the `waiting-for:<preceding-gate>` + `completed:<preceding-gate>` + `agent:paused` triple that matches a naturally-paused-then-completed gate. Label-monitor's next poll enqueues the issue and worker's `PhaseResolver.resolveFromContinue` picks `<phase>` as `startPhase` — makes the T-S2 by-hand recovery a one-liner and unblocks auto-mode Requeue (auto.md D.7/D.8).
- Gate mapping derived by inverting `GATE_MAPPING` from `packages/orchestrator/src/worker/phase-resolver.ts` (overlaid with `WORKFLOW_GATE_MAPPING[workflowName]`) — NOT `WorkerConfigSchema.gates` from `worker/config.ts` (wrong semantic direction, would send resolver to the phase *after* the target). Truth-table: `validate → implementation-review`, `implement → tasks-review`, `tasks → plan-review`, `clarify → spec-review` (documented cross-phase tie-break), `specify` + `plan` → refuse (no preceding gate; evidence points at `process:*` re-queue).
- `packages/generacy/src/cli/commands/cockpit/resume.ts` — NEW: `resumeCommand()` + `runResume()`, shape mirrors `advance.ts`. Deps-injection (`runner`, `gh`, `loadConfig`, `env`, `now`, `stdout`, `stderr`) for tests. Routes issue-ref through `resolveIssueContext` (per #822/#850). `CockpitExit` for controlled exits: 0 (happy path or no-op), 2 (arg parsing), 3 (refusal — evidence, zero mutations), 1 (transport). No `--force`, no comment posted (diverges from `advance` — log line + labels are the audit trail).
- `packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts` — MODIFIED (planned): export `resolvePrecedingGate(phase, workflowName?)` returning `{ kind: 'found', gate: PrecedingGate } | { kind: 'no-preceding-gate' }`. Algorithm: invert effective gate mapping, filter by `resumeFrom === phase`, prefer cross-phase entries (nearest predecessor by `PHASE_SEQUENCE.indexOf`), fallback to self-loop, else `no-preceding-gate`. Cross-package import of `GATE_MAPPING`/`WORKFLOW_GATE_MAPPING` from orchestrator (add to public exports if not already exported).
- Mutation ordering (per spec Assumptions §7): additions call first (`addLabels([waiting-for:<g>, completed:<g>, agent:paused])`), removals call second (`removeLabels([failed:<phase>, agent:error?, phase:<phase>?])`). Mid-sequence failure → over-labeled (recoverable) not under-labeled (stranded). Defensive removes report only actual mutations in the log line.
- Refusal branches (all exit 3, zero mutations, evidence): multiple `failed:*`, unknown phase, no preceding gate (points at `process:*` re-queue), conflicting `waiting-for:<other-gate>`. Idempotency: no-op on non-failed issues (single-line stdout, exit 0).
- Regression test (`resume.regression.test.ts`) proves the poll-path handoff end-to-end: post-resume label set → `parseLabelEvent` emits `type: 'resume'` → `PhaseResolver.resolveStartPhase(labels, 'continue', workflow)` returns the failed phase. Prior-phase `completed:<earlier-phase>` chain preserved untouched (per Q5).
- No changes to `label-monitor-service.ts`, `phase-resolver.ts`, `label-manager.ts`, or the label protocol. The verb writes labels that satisfy the existing detector and resolver by construction. Auto-mode gate wording flip (auto.md D.7/D.8) lands in a sibling change; this spec ships the primitive only.
