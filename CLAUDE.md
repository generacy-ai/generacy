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
