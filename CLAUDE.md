# Generacy

Frontend application for Generacy.

## Per-feature technology notes

Per-feature technology, dependency, and integration notes live in
`specs/<feature>/stack.md` on each feature branch. This file is not
updated by `/plan` — see [#899](https://github.com/generacy-ai/generacy/issues/899).

## Development

```bash
pnpm install
pnpm dev
```

## Changesets (required — CI gate)

**If your diff touches a non-test file under `packages/<pkg>/src/`, the PR must add
a new `.changeset/*.md` file.** Otherwise CI fails with:

> ::error::This PR modifies packages/*/src/ but adds no changeset.

Speckit phases do **not** generate changesets, so the implement phase must write one
itself — this is the single most common reason a speckit PR lands red. Add it as part
of the implementation, not as an afterthought:

```bash
pnpm changeset            # interactive
# or hand-write .changeset/<issue-number>-<slug>.md
```

Rules:

- It must be a **newly added** file in the PR diff (the gate greps `--diff-filter=A`
  against the base). Editing an existing changeset does not satisfy it.
- **Test-only** changes under `packages/*/src/` are exempt — the gate skips diffs whose
  in-scope files are all `*.test.ts` / `*.spec.ts` / `__tests__/`.
- List **every** package whose non-test `src/` changed. The gate only checks that *some*
  changeset was added, so a changeset missing a package still passes CI but silently
  ships that package unreleased — get this right by hand.
- Bump level: new capability → `minor`; defect fix (`workflow:speckit-bugfix`) → `patch`;
  new label vocabulary in `workflow-engine` → `minor`.
- New exports that are **not** re-exported from the package's public `index.ts` are
  internal surface, not API — still `patch`.
- Genuinely needs no release (comment-only, or a refactor with no public surface)?
  `pnpm changeset --empty`.
- When unsure, copy the shape of a comparable existing changeset in `.changeset/`.

Note: `pnpm changeset status --since=origin/develop` will not see your changeset until
it is committed (it reads git, not the working tree). Plain `changeset status` reads the
directory.

Gate definition: `.github/workflows/changeset-bot.yml`.

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

## Shipped subsystem invariants

Condensed from per-issue notes that used to live in this file in full. Each bullet is a
standing fact about code that is already merged — the narrative of *how* it was built is in
git history and the linked issue/PR threads.

### Process topology and IPC

- **Control-plane and orchestrator are separate processes** with no shared memory. Anything
  in control-plane that needs the relay must go over HTTP IPC: `POST /internal/relay-events`
  on the orchestrator, authenticated with `ORCHESTRATOR_INTERNAL_API_KEY` (ephemeral UUID
  minted by `entrypoint-orchestrator.sh`). Never query an orchestrator-process singleton for
  control-plane state — probe the socket instead (`code-server-probe.ts`,
  `control-plane-probe.ts`). (#594, #586/#596, #624)
- That route and its API key are registered in `createServer()` **before** `server.listen()`,
  with a `() => ClusterRelayClient | null` getter (503 until activation). Fastify rejects
  post-listen route registration, and wizard mode initialises the relay bridge after listen —
  registering there silently kills the whole bridge. (#598)
- Relay event wire shape is `{ event: <channel>, data: <payload>, timestamp: <ISO> }` — not
  `{ channel, event }`. The `as unknown as RelayMessage` cast hides mismatches. (#600)
- Code-server's socket is `/run/generacy-control-plane/code-server.sock` (reuses the
  control-plane tmpfs; `/run` itself is root-owned). Override: `CODE_SERVER_SOCKET_PATH`. (#588)
- Post-activation branch selection is centralised in
  `orchestrator/src/services/post-activation-dispatch.ts` (`runPostActivationBranch`), which
  owns the retry / resume / noop decision. Both `server.ts` call sites (existing-API-key and
  wizard/background-activation) must go through it — the wizard branch is the one that gets
  forgotten, and a per-branch `if/else` is how #824 regressed into #834.
- Control-plane app-config stores fall back to `/tmp/generacy-app-config/` on
  EACCES/EPERM/EROFS and then to a disabled no-op mode (GET empty, PUT 503
  `app-config-store-disabled`); the daemon keeps running either way and writes
  `/run/generacy-control-plane/init-result.json`. The orchestrator waits up to
  `CONTROL_PLANE_WAIT_TIMEOUT` (15 s) for the control socket, pushes an `error` status, then
  exits 1 after a grace window. (#624)
- VS Code tunnel names are capped at 20 chars by Microsoft, so cluster UUIDs cannot be used
  raw — `deriveTunnelName(clusterId)` in `vscode-tunnel-manager.ts` yields `g-<18 hex>`. (#608)
- `bootstrap-complete` is a control-plane lifecycle action: it writes a sentinel at
  `POST_ACTIVATION_TRIGGER` (default `/tmp/generacy-bootstrap-complete`), starts code-server
  fire-and-forget, and writes the wizard env file. Readiness propagates via relay metadata,
  not the HTTP response. (#562, #586)

### Cluster credentials and git auth

- Credential backends live in **`packages/credhelper/src/backends/`** as the single source of
  truth (`ClusterLocalBackend`, `CredentialFileStore`, AES-256-GCM `crypto.ts`).
  `credhelper-daemon/src/backends/` is re-exports only. Defaults: `/var/lib/generacy/credentials.dat`,
  `/var/lib/generacy/master.key`; atomic writes + fd advisory lock. (#558)
- **Git auth is just-in-time, not a static token.** `git-credential-generacy` (a
  `@generacy-ai/control-plane` bin) speaks the git credential-helper protocol and POSTs
  `/git-token` on the control socket; `GitTokenManager` caches `{ token, expiresAt }` in memory
  and synchronously refreshes from the cloud pull endpoint inside a 5 min window, sharing one
  in-flight promise. It never falls back to `GH_TOKEN` and never reads a token off disk.
  Workers reach it only through the `git-token-proxy` bin, which allows exactly
  `POST /git-token` (everything else 404s, no upstream contact). (#766, #768)
- Anything that rewrites git config (`generacy setup auth` / `setup workspace`) can clobber the
  JIT helper with a stale wizard `GH_TOKEN` — re-run `setup-credentials.sh` to restore it.
- Non-git `gh` calls in the **orchestrator process** must resolve tokens explicitly via the
  `tokenProvider` pattern (`createWizardCredsTokenProvider`, mtime-cached read of
  `/var/lib/generacy/wizard-credentials.env`) and pass `{ env: { GH_TOKEN } }`. Never rely on
  ambient `gh auth`. Worker-process callers pass `undefined` and use the credhelper session env. (#620)
- `wizard-env-writer.ts` unseals wizard credentials into
  `/var/lib/generacy/wizard-credentials.env` (mode 0600) at `bootstrap-complete`. `github-app`
  values are **JSON** (`{ installationId, token, accountLogin, … }`) — extract `token` →
  `GH_TOKEN` and `accountLogin` → `GH_USERNAME` / `GH_EMAIL`; `github-pat` uses the raw value.
  Failures are best-effort/non-fatal. (#589, #592, #628)
- `gh` HTTP 401 surfaces as a distinct exported `GhAuthError` from
  `workflow-engine/.../client/gh-cli.ts`. Orchestrator monitors catch it *before* their generic
  catch and feed `GitHubAuthHealthService`, which rate-limits `refresh-requested` emissions on
  `cluster.credentials` to one per credential per 60 s; `CredentialExpiryWatcher` proactively
  requests a refresh inside 5 min of `expiresAt`. (#762)
- The docker socket proxy validates `POST /containers/create` bind mounts against
  `GENERACY_SCRATCH_DIR` (per-session `/var/lib/generacy/scratch/<session-id>/`, mode 0700) —
  host-socket mode only; DinD (`ENABLE_DIND=true`) skips the guard. (#497)

### Cloud URLs

- `GENERACY_CLOUD_URL` is **dead** — it is read nowhere. Use `GENERACY_API_URL` (HTTP REST,
  required in the orchestrator, CLI default `https://api.generacy.ai`), `GENERACY_RELAY_URL`
  (WebSocket relay), and `GENERACY_APP_URL` (dashboard, CLI-only, never written to cluster
  `.env`). The canonical CLI flag is `--api-url`; `--cloud-url` is a hidden deprecated alias.
  Cloud pre-appends `projectId`. (#549, #551)

### Multi-repo workflows

- `siblingWorkdirs: Record<string, string>` (repo name → absolute path) rides on
  `ActionContext` / `ExecutionOptions` / `CliSpawnOptions`. Caller-injection is deliberate: the
  orchestrator resolves it with `config/src/repos.ts` `resolveSiblingWorkdirs()` so
  `workflow-engine` stays decoupled from `@generacy-ai/config`. Fails closed to `{}`. (#687)
- `phase:after` is the generic post-phase extension hook (`PhaseLoopDeps.phaseAfterHandlers`).
  Handlers run sequentially after commit/push + PR-ensure and before the gate check, fail-fast,
  and do **not** run at implement increment boundaries or on retry paths. Register there rather
  than editing `phase-loop.ts`. (#690)
- Review coordination: gate condition `on-sibling-review`, `GateChecker.checkGates()` returns
  *all* gates matching a phase (multi-gate-per-phase), and activating the gate flips every
  linked sibling draft PR to ready-for-review. (#692)

### Cockpit / worker gates

- Cockpit CLI verbs must resolve issue refs through **`resolveIssueContext`**, never
  `parseIssueRef` directly (`@internal`, qualified-forms-only). The bare-number branch and its
  rejection copy live in `resolveIssueContext`, and an ESLint `no-restricted-imports` override
  under `commands/cockpit/**` enforces this. `cockpit.repos` config no longer exists. (#850)
- `LabelManager.onGateHit()` clears the paired `resume:<gate>` dedupe key *after* the pause
  labels apply successfully — the clear is paired with the pause, not the resume check, so a
  pause that never manifested never clears a dedupe. `LabelManager` stays Redis-free via a
  narrow `clearResumeDedupe` callback rather than an injected `PhaseTrackerService`. (#849)
- The implement→continue increment has a **tasks.md fallback** (the "safety net"): when an
  implement phase succeeds with no `SPECKIT_IMPLEMENT_PARTIAL` sentinel
  (`result.implementResult === undefined`), `worker/tasks-md-fallback.ts` `evaluateTasksMd()`
  reads the workflow's `tasks.md` and returns `incomplete` / `complete` / `unreadable`. On
  `incomplete` the engine *synthesizes* `implementResult = { partial: true, tasks_remaining, … }`
  so the existing increment block in `phase-loop.ts` drives re-entry unchanged. The sentinel stays
  authoritative and is the fast path; tasks.md is only the fallback. There is no absolute
  re-entry cap — the no-progress guard (`tasksRemaining >= lastTasksRemaining`) is the only
  backstop, and `unreadable` (missing/ambiguous spec dir, unreadable file) advances rather than
  re-enters. (#1187; being refined for manual-verification tasks by #1214 below)
- Implement phases can pause on dependencies: the agent emits
  `SPECKIT_IMPLEMENT_BLOCKED: {"on": ["owner/repo#N", …]}`, the engine commits WIP, posts a
  `<!-- generacy-dependency-block -->` marker comment holding the canonical refs (the *sole*
  persisted store — no Redis, no disk, because dev-cluster Redis has no volume), and applies
  `waiting-for:dependencies` + `agent:paused`. `DependencyMonitorService` polls the refs and
  re-enqueues `continue` once all are closed. Cycle cap is 3 per grant, then
  `waiting-for:dependency-limit` (operator-only); the counter is *derived* from comment
  timestamps, not stored. Blocked coexists with PARTIAL and wins control flow. (#1211)

### Cluster image builds

- Cluster image build/publish workflows live in **this** repo, not the template repos (template
  workflow files got copied into user repos and hit `403 Resource not accessible by
  integration`): `publish-cluster-base-image.yml`, `publish-cluster-microservices-image.yml`,
  and the 5-minute `poll-cluster-images.yml` cron that dispatches them. `develop` → `:preview`,
  `main` → `:stable`, plus an immutable `sha-<short>` tag. GHCR tags are the only state. (#534, #559)

### CLI deploy (BYO VM)

- `generacy deploy ssh://[user@]host[:port][/path]` provisions a cluster on a BYO VM
  (`packages/generacy/src/cli/commands/deploy/`): verify SSH+Docker → device-flow activation →
  fetch LaunchConfig → SCP bootstrap bundle → `docker compose up -d` → poll cloud status →
  register. Defaults: current OS user, port 22, `~/generacy-clusters/<project-id>`. The registry
  entry stores `managementEndpoint: "ssh://…"`, and lifecycle commands (`stop`, `up`, `down`, …)
  transparently forward `docker compose` over SSH when it starts with `ssh://`. (#500)

## Per-issue planning notes are NOT accumulated here

Historically every speckit `plan` phase appended a `## <title> (#NNNN, planning phase)` section
to this file. That grew it to ~285 KB / ~71 K tokens, and because this file is auto-loaded as
project instructions into every worker session, the static preamble crowded out the working
context window until phases started dying on autocompact thrashing.

**Do not append planning notes to this file.** Design notes, clarifications, and
decision records belong in `specs/<feature>/` on the feature branch and in the issue/PR thread.
The removed sections are all recoverable from git history (`git log -p -- CLAUDE.md`) and from
the issues they name.

Only promote something into this file when it is a **durable, repo-wide invariant** a future
agent must not violate — and then write it as one or two lines in the relevant section above,
not as a phase narrative.

The one exception below is the in-flight issue whose worker is still running.

## Manual-task awareness in the #1187 tasks.md safety net (#1214, planning phase)

- Bug: the #1187 tasks.md safety net treats every unchecked task as automatable and re-enters implement; manual-verification tasks (browser checks, deploy checklists) stay unchecked **by design** (agency `implement.md:174-186` protocol: classify manual, leave unchecked, apply `waiting-for:manual-validation`), so the second pass makes no progress and the no-progress guard (`tasksRemaining >= lastTasksRemaining`, `phase-loop.ts:1071`) fails complete-and-green stories with `failed:implement` + `failed:implement-repeated`. Field evidence: Painworth/ai-lawfirm#2723 ("Manually verify …" T028/T029 → keyword tier) and #2714 (`[manual]` markers ignored → marker tier). `workflow:speckit-bugfix`.
- **Load-bearing clarifications**: **Q1=A** completed-at-pause — pause sequence runs `labelManager.onPhaseComplete('implement')` (grants `completed:implement`) THEN `onGateHit('implement', 'waiting-for:manual-validation')`, mirroring the #1133 ci-green precedent (`phase-loop.ts:1937-1952`); the comment at `phase-loop.ts:1930-1932` claiming ci-green is "the one gate where `completed:<phase>` is granted at pause" MUST be updated (manual-validation becomes the second). Ordering safe against the #958 assumption (`label-manager.ts:287-292`) because `onPhaseComplete` already removed `phase:implement` → `onGateHit`'s removeLabels is a no-op. **Q2=B** keyword tier — case-insensitive whole-word `manual`/`manually`/`hand-test` within the **first 4 words** of the task text (after checkbox capture / heading task-ID + optional `[DONE]`); rejects mid-sentence noun uses; `manuals` fails whole-word. Residual false positive accepted: "update the user manual" lands the keyword at word 4 (inside the window) — suppresses re-entry only when ALL remaining unchecked tasks classify manual, producing a visible operator-overridable pause; tests must pin this case. **Q3=A** marker tier — literal `/\[manual\]/i` anywhere in the task line, both grammars (checkbox: anywhere after `- [ ]`; heading: anywhere after the task ID); never affects checked/unchecked counting and never interacts with the strict `HEADING_DONE` `[DONE]`-after-ID rule (a heading carrying both `[DONE]` + `[manual]` is checked, full stop). **Q4=A** label wins — `waiting-for:manual-validation` on the issue suppresses partial synthesis unconditionally; label-read failure falls back to tasks.md classification as if label absent (fail-open to classification, never blind re-entry, never fail-closed); label present + `automatable > 0` → structured divergence warn mirroring `phase-loop.ts:928-946` (`reason: 'manual-validation-label-present'`). **Q5=A** WIP commit before pause — always `prManager.commitPushAndEnsurePr` honoring `pushRefused` (#1051 abort: `return { completed: false, lastPhase: 'implement', gateHit: false }`, no labels applied) and propagate `prUrl` BEFORE labels; the safety-net region (`:919-952`) and #1211 branch (`:956-1064`) both run BEFORE the normal step-5 commit at `:1396`, so an early gate return would otherwise skip the phase's only commit path.
- **Assumption 4 confirmed at plan time**: `GATE_MAPPING['manual-validation'] = { phase: 'validate', resumeFrom: 'validate' }` pre-exists (`phase-resolver.ts:16`) → auto-member of `HUMAN_GATE_SUFFIXES`; **NO** `DEFAULT_RESUME_RETAIN_SUFFIXES` change (set stays `['remediation-limit', 'dependency-limit']`, `label-manager.ts:107`) — the gate resumes *past* the gate check (at `validate`), so the standard resume strip of `completed:manual-validation` correctly re-arms the gate; `completed:implement` is a phase completion `onResumeStart`'s strip never touches (it only removes `completed:<X>` paired with a co-present `waiting-for:<X>`).
- **Classification** (FR-005/006/007): `countTasks` in `tasks-md-fallback.ts` widens to `{ unchecked, checked, total, manual }` (manual = unchecked tasks classified manual; checked manual tasks are just checked). `TasksMdEvaluation` gains `manual-only` variant (`unchecked > 0 && automatable === 0`) and the `incomplete` variant gains `automatable`/`manual` counts (`unchecked === automatable + manual`). `complete`/`unreadable` variants byte-identical to #1187.
- **Safety-net decision table** (FR-001..004/007/008; evaluated only when `phase === 'implement' && result.success && result.implementResult === undefined` — sentinel path untouched, SC-007): label present → pause (+divergence warn if automatable > 0); label absent + `manual-only` → pause; label absent + `incomplete` → synthesize partial from **automatable** count only (`tasks_remaining: evaluation.automatable`, NOT unchecked — no-progress guard compares automatable progress only) and re-enter as today; `complete`/`unreadable` → advance byte-identically; label-read failed → warn + behave per label-absent rows.
- **Pause sequence** (mirrors #1211 structurally, #1133 for labels): WIP commit/push (pushRefused abort) → propagate prUrl → `onPhaseComplete('implement')` → `onGateHit('implement', 'waiting-for:manual-validation')` → `return { completed: false, lastPhase: 'implement', gateHit: true }`. Resume: operator applies `completed:manual-validation` → label monitor enqueues `continue` → resolver resumes at `validate`, resolving cleanly because `completed:implement` exists (the entire point of Q1=A).
- **No-progress guard pause** (FR-009/010): when the guard fires, re-run the label + classification evaluation before `escalateAndAlert`; human-gated remainder (label present OR `manual-only`) → pause instead of `failed:implement`. Covers the sentinel-present path (agent emits `SPECKIT_IMPLEMENT_PARTIAL` over a purely-manual remainder) that the safety-net block never sees. Automatable-remainder guard behavior byte-identical.
- **Non-changes**: zero new label vocabulary (FR-012/SC-008 — `waiting-for:manual-validation`, `completed:manual-validation`, GATE_MAPPING entry all exist); zero GATE_MAPPING / resolver / label-monitor / cockpit changes; sentinel grammar, `ImplementPartialResult` type (`types.ts:178`), increment re-loop mechanics unchanged; no feature flag (inert for stories without manual tasks or the label — SC-005/006); no new persisted state (FR-013 — labels + tasks.md are the only inputs).
- Files: MOD `packages/orchestrator/src/worker/tasks-md-fallback.ts` (classification + `manual-only` variant), MOD `phase-loop.ts` (label pre-check, pause sequence, guard pause, #1133 comment update), MOD `tasks-md-fallback.test.ts` (marker/keyword matrix, counting invariance, #2723/#2714 fixtures — SC-009), NEW `phase-loop.manual-validation.test.ts` (pause paths, label precedence, pushRefused abort, automatable-only synthesis, guard behavior, divergence log shape, sentinel-path-untouched).
- Changeset (implement time): `.changeset/1214-manual-task-safety-net.md` — `@generacy-ai/orchestrator` **patch** (internal worker fix, no new public exports, no new label vocabulary). Plan-phase commit touches only `specs/` + `CLAUDE.md` — no changeset now.
