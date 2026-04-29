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
  - `src/backends/file-store.ts` — NEW in #491: `CredentialFileStore` for atomic file I/O with advisory locking. Master key auto-generation on first boot.

## Control-Plane Package

- `packages/control-plane` — In-cluster HTTP service over Unix socket for the cloud-hosted bootstrap UI (#490, v1.5 phase 1). Terminates control-plane requests forwarded by the cluster-relay dispatcher.
  - Socket at `/run/generacy-control-plane/control.sock` (configurable via `CONTROL_PLANE_SOCKET_PATH`).
  - Routes (stubs in phase 1, real wiring in later phases): `GET /state`, `GET/PUT /credentials/:id`, `GET/PUT /roles/:id`, `POST /lifecycle/:action`.
  - Uses native `node:http` (same pattern as credhelper-daemon). Re-exports credential/role Zod schemas from `@generacy-ai/credhelper`.
  - Reads actor identity from relay-injected headers (`x-generacy-actor-user-id`, `x-generacy-actor-session-id`).
  - Error shape: `{ error, code, details? }` — matches credhelper-daemon's `CredhelperErrorResponse`.
  - Crash-tolerant: failures must not block orchestrator boot; relay returns 503 from socket prefix.

## Cluster Relay

- `packages/cluster-relay/` — WebSocket relay client connecting in-cluster orchestrator to Generacy cloud (`@generacy-ai/cluster-relay`). ESM, Node >=20, deps: `ws`, `zod`.
  - `src/messages.ts` — Zod-validated message types: `ApiRequestMessage`, `ApiResponseMessage`, `HandshakeMessage`, `HeartbeatMessage`, `EventMessage`, `ErrorMessage`, `ConversationMessage`. Discriminated union on `type` field via `RelayMessageSchema`.
  - `src/proxy.ts` — Forwards relayed `api_request` messages to orchestrator HTTP. v1.5 #489 extends with path-prefix dispatcher: `routes` array of `{ prefix, target }` (HTTP URL or `unix://` socket), longest-prefix-match, prefix stripping, `orchestratorUrl` as implicit fallback. Actor identity propagated as `x-generacy-actor-user-id`/`x-generacy-actor-session-id` headers.
  - `src/config.ts` — `RelayConfig` loaded from env vars + overrides. v1.5 #489 adds `routes: RouteEntry[]`, `activationCode?`, `clusterApiKeyId?`.
  - `src/relay.ts` — `ClusterRelay` class: WebSocket lifecycle, state machine (disconnected→connecting→authenticating→connected), auto-reconnect with exponential backoff, heartbeat, message dispatch. v1.5 #489 adds `activation` field to handshake.
  - `src/dispatcher.ts` — NEW in #489: pure-function path-prefix dispatcher. `sortRoutes()`, `resolveRoute()`, Unix socket detection.

## Orchestrator Activation

- `packages/orchestrator/src/activation/` — Device-flow activation client for first cluster boot (#492, v1.5 phase 2). Runs before relay handshake in orchestrator startup. If no key file at `/var/lib/generacy/cluster-api-key`, initiates RFC 8628 device-code flow against `GENERACY_CLOUD_URL`.
  - `index.ts` — Public API: `activate(options)` returns `ActivationResult` (apiKey, clusterApiKeyId, clusterId, projectId, orgId).
  - `client.ts` — HTTP client for `POST /api/clusters/device-code` and `POST /api/clusters/device-code/poll`. Uses native `node:http`/`node:https`.
  - `poller.ts` — Poll loop with `slow_down` (+5s) and `expired` (auto-retry up to 3 cycles) handling.
  - `persistence.ts` — Atomic key-file write (`.tmp` + `rename()`, mode 0600) and `cluster.json` metadata.
  - Cloud URL precedence: `GENERACY_CLOUD_URL` env > derived from relay WSS URL > `https://api.generacy.ai`.
  - Retry budget: 5 retries, exponential backoff (2s-32s, ~62s total) for initial cloud requests.
  - Integration: `server.ts` calls `activate()` before relay construction; sets `config.relay.apiKey` and `config.relay.clusterApiKeyId` from result.

## CLI Package (generacy)

- `packages/generacy/` — Main CLI package (`@generacy-ai/generacy`). ESM, Node >=22, deps: `commander`, `pino`, `zod`.
  - `bin/generacy.js` — Entry point with Node >=22 version gate. Calls `run()` from `src/cli/index.ts`.
  - `src/cli/index.ts` — Commander.js program. Registers existing commands (run, orchestrator, validate, doctor, init, setup) plus v1.5 placeholder subcommands.
  - `src/cli/commands/placeholders.ts` — NEW in #493: data-driven placeholder command factory. Each prints "not yet implemented" with v1.5 phase info, exits 0.
  - `src/cli/utils/error-handler.ts` — NEW in #493: global uncaughtException/unhandledRejection handler. User-friendly messages; stack traces only when `DEBUG=1`.
  - `src/cli/utils/node-version.ts` — NEW in #493: `checkNodeVersion()` — refuses to run on Node <22 with install link.
  - `src/cli/utils/exec.ts` — Shell helpers: `exec()` (sync, throws), `execSafe()` (sync, returns `{ok, stdout, stderr}`), `spawnBackground()` (detached).
  - `src/cli/utils/logger.ts` — Pino logging: `getLogger()`, `setLogger()`, `createLogger()`.
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
  - `index.ts` — Command registration (Commander.js) + main orchestration flow: validate Node/Docker, fetch launch-config, scaffold, compose up, stream logs, open browser, register cluster.
  - `cloud-client.ts` — `fetchLaunchConfig(cloudUrl, claimCode)`: `GET /api/clusters/launch-config?claim=<code>`. Returns `LaunchConfig` (projectId, projectName, variant, cloudUrl, clusterId, imageTag, repos). Uses `node:https`. Stub mode via `GENERACY_LAUNCH_STUB=1`.
  - `scaffolder.ts` — Writes `.generacy/cluster.yaml`, `.generacy/cluster.json`, `.generacy/docker-compose.yml` from `LaunchConfig`.
  - `compose.ts` — `docker compose pull` + `up -d` + log streaming. Matches `"Go to:"` pattern to extract `verification_uri` and `user_code`.
  - `browser.ts` — Cross-platform browser open: `open` (macOS), `start` (Windows), print URL (Linux).
  - `registry.ts` — Appends cluster entry to `~/.generacy/clusters.json` (schema from #494): `{clusterId, name, path, composePath, variant, channel, cloudUrl, lastSeen, createdAt}`.
  - `prompts.ts` — Interactive prompts via `@clack/prompts` for claim code input and directory confirmation.
  - CLI flags: `--claim <code>`, `--dir <path>`. Default project dir: `~/Generacy/<projectName>`.
  - Standalone from `init` command — writes only cloud-flow config files. Convergence deferred.

## CLI claude-login and open Commands

- `src/cli/commands/claude-login/` — NEW in #496: Proxies `claude /login` inside orchestrator container. Spawns `docker compose exec -it orchestrator claude /login` with `stdio: ['inherit', 'pipe', 'inherit']`. Pipes stdout through URL scanner; auto-opens detected URLs on macOS/Windows, prints instructions on Linux. Resolves cluster via shared `getClusterContext` helper.
- `src/cli/commands/open/` — NEW in #496: Opens `{cloudUrl}/clusters/{clusterId}` in default browser. Resolves cluster from cwd or `--cluster <id>` flag. Looks up `cloudUrl` from `~/.generacy/clusters.json` registry.
- `src/cli/utils/cluster-context.ts` — NEW in #496: `getClusterContext(options)` walks up from cwd looking for `.generacy/cluster.json`, cross-references `~/.generacy/clusters.json` for registry metadata. Returns `ClusterContext` with `clusterId`, `cloudUrl`, `projectDir`, etc. Shared by claude-login, open, and #494 lifecycle commands.
- `src/cli/utils/browser.ts` — NEW in #496: `openUrl(url)` cross-platform browser launch. macOS: `open`, Windows: `start`, Linux: print-only (no auto-open per architecture doc).

## Orchestrator Launcher

- `packages/orchestrator/src/launcher/` — Plugin-based process launcher (`AgentLauncher`). Resolves intents to plugins, merges env (3-layer), selects `ProcessFactory` by stdio profile, spawns processes.
- Credentials interceptor (#465, Phase 3): When `LaunchRequest.credentials` is set, begins a credhelper session, merges session env, wraps command in entrypoint, sets uid/gid, ends session on exit. Uses HTTP-over-Unix-socket client (`node:http`) to communicate with credhelper daemon.
- Credentials integration (#478, Phase 6): `createAgentLauncher()` wires `CredhelperHttpClient` when the control socket exists. `WorkerConfig.credentialRole` (from `.generacy/config.yaml` `defaults.role`) flows to all spawn sites (`CliSpawner`, `PrFeedbackHandler`, `ConversationSpawner`), which populate `LaunchRequest.credentials`. Fail-fast at startup if role is configured but daemon is unavailable. Generic launcher paths (`cli-utils.ts`, `subprocess.ts`) deferred to follow-up.
