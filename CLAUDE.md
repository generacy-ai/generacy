# Generacy

Generacy core platform: a pnpm monorepo containing the CLI (`packages/generacy`), the cluster
runtime (`orchestrator`, `control-plane`, `cluster-relay`), the credentials system
(`credhelper`, `credhelper-daemon`), `workflow-engine`, `knowledge-store`, and language/tool
plugins.

## Per-feature technology notes

Per-feature technology, dependency, and integration notes live in
`specs/<feature>/stack.md` on each feature branch. `/plan` does not update this file.
Spec-stage phase commits (`specify`/`clarify`/`plan`/`tasks`) exclude and revert repo-root
agent-context files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`)
so a prompt regression can never re-bloat them through a worker commit (#1218).

## Development

```bash
pnpm install
pnpm dev
```

Cross-package imports resolve to built `dist/` output — rebuild a dependency package before
typechecking or testing its dependents, or you get spurious "no exported member" /
"not a function" errors.

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

## Package map

Orientation only — the code is authoritative. Details worth knowing before you touch a
package:

- `packages/credhelper` — shared TypeScript types and Zod schemas for the credentials
  architecture (types + Zod only). Also the single source of truth for credential
  **backends** (see invariants below).
- `packages/credhelper-daemon` — runtime daemon for credential session management.
  HTTP-over-Unix-socket API (`POST /sessions`, `DELETE /sessions/:id`); control socket at
  `/run/generacy-credhelper/control.sock`. Native `node:http`, no Express. Core credential
  type plugins under `src/plugins/core/` are statically registered via an index file, not
  discovered by the plugin loader. Config loads from `.agency/` (`CREDHELPER_AGENCY_DIR`
  overrides the default `${PWD}/.agency`); fails closed on invalid config.
- `packages/control-plane` — in-cluster HTTP service over a Unix socket
  (`/run/generacy-control-plane/control.sock`, override via `CONTROL_PLANE_SOCKET_PATH`)
  terminating control-plane requests forwarded by the cluster-relay dispatcher. Native
  `node:http`; re-exports credential Zod schemas from `@generacy-ai/credhelper`; actor
  identity comes from relay-injected headers (`x-generacy-actor-user-id`,
  `x-generacy-actor-session-id`); error shape `{ error, code, details? }` matches the
  credhelper-daemon's. Must stay crash-tolerant: its failures must never block orchestrator
  boot. The relay tunnel handler only ever streams to code-server's Unix socket — any other
  target is rejected.
- `packages/cluster-relay` — WebSocket relay client connecting the in-cluster orchestrator
  to Generacy cloud. Zod-validated message types (discriminated union on `type`); a
  path-prefix dispatcher routes relayed API requests to HTTP or `unix://` socket targets
  (longest prefix wins, prefix is stripped, orchestrator URL is the implicit fallback).
- `packages/orchestrator` — cluster runtime. Includes the device-flow activation flow (runs
  before the relay handshake on first boot; key persisted at
  `/var/lib/generacy/cluster-api-key`, metadata in `cluster.json`) and the plugin-based
  `AgentLauncher` (resolves intents to plugins, merges env, spawns processes; when
  `LaunchRequest.credentials` is set it begins a credhelper session over the Unix socket,
  wraps the command, and ends the session on exit). `WorkerConfig.credentialRole` comes from
  `.generacy/config.yaml` `defaults.role`; startup fails fast if a role is configured but
  the credhelper daemon is unavailable.
- `packages/activation-client` — shared protocol-level device-flow activation client
  (`initDeviceFlow()`, `pollForApproval()`, status decoding). Consumed by the orchestrator
  (which adds file-based key persistence) and by CLI deploy (which adds browser-open
  behavior).
- `packages/generacy` — main CLI (`@generacy-ai/generacy`, ESM, Node >=22, Commander).
  Cluster lifecycle commands (`up`, `stop`, `down`, `destroy`, `status`, `update`) wrap
  `docker compose` against `.generacy/docker-compose.yml`. Cluster identity lives in
  `.generacy/cluster.yaml` (project config: channel, workers, variant) and
  `.generacy/cluster.json` (runtime identity from activation — snake_case keys, matching the
  orchestrator's `/var/lib/generacy/cluster.json`); the machine-wide registry is
  `~/.generacy/clusters.json` (atomic temp+rename writes, longest-prefix cwd lookup).
  `generacy launch --claim=<code>` bootstraps a cluster from a cloud claim code;
  `generacy deploy ssh://[user@]host[:port][/path]` provisions a cluster on a BYO VM — the
  registry entry stores `managementEndpoint: "ssh://…"` and lifecycle commands transparently
  forward `docker compose` over SSH for such entries. Both share the scaffolder at
  `commands/cluster/scaffolder.ts`; the compose it emits must keep mirroring the
  cluster-base devcontainer compose (tmpfs mounts, app-config volumes, env vars) or freshly
  scaffolded clusters silently diverge from dev clusters.

## Standing subsystem invariants

Durable facts about merged code that a future change must not violate. The narrative of how
each was built lives in git history and the linked issue/PR threads
(`git log -p -- CLAUDE.md` recovers the old per-issue notes).

### Process topology and IPC

- **Control-plane and orchestrator are separate processes** with no shared memory. Anything
  in control-plane that needs the relay must go over HTTP IPC: `POST /internal/relay-events`
  on the orchestrator, authenticated with `ORCHESTRATOR_INTERNAL_API_KEY` (ephemeral UUID
  minted by `entrypoint-orchestrator.sh`). Never query an orchestrator-process singleton for
  control-plane state — probe the socket instead (`code-server-probe.ts`,
  `control-plane-probe.ts`).
- That route and its API key are registered in `createServer()` **before** `server.listen()`,
  with a `() => ClusterRelayClient | null` getter (503 until activation). Fastify rejects
  post-listen route registration, and wizard mode initialises the relay bridge after listen —
  registering there silently kills the whole bridge.
- Relay event wire shape is `{ event: <channel>, data: <payload>, timestamp: <ISO> }` — not
  `{ channel, event }`. The `as unknown as RelayMessage` cast hides mismatches.
- Code-server's socket is `/run/generacy-control-plane/code-server.sock` (reuses the
  control-plane tmpfs; `/run` itself is root-owned). Override: `CODE_SERVER_SOCKET_PATH`.
- Post-activation branch selection is centralised in
  `orchestrator/src/services/post-activation-dispatch.ts` (`runPostActivationBranch`), which
  owns the retry / resume / noop decision. Both `server.ts` call sites (existing-API-key and
  wizard/background-activation) must go through it — the wizard branch is the one that gets
  forgotten, and per-branch `if/else` logic there has caused regressions before.
- Control-plane app-config stores fall back to `/tmp/generacy-app-config/` on
  EACCES/EPERM/EROFS and then to a disabled no-op mode (GET empty, PUT 503
  `app-config-store-disabled`); the daemon keeps running either way and writes
  `/run/generacy-control-plane/init-result.json`. The orchestrator waits up to
  `CONTROL_PLANE_WAIT_TIMEOUT` (15 s) for the control socket, pushes an `error` status, then
  exits 1 after a grace window.
- VS Code tunnel names are capped at 20 chars by Microsoft, so cluster UUIDs cannot be used
  raw — `deriveTunnelName(clusterId)` in `vscode-tunnel-manager.ts` yields `g-<18 hex>`.
- `bootstrap-complete` is a control-plane lifecycle action: it writes a sentinel at
  `POST_ACTIVATION_TRIGGER` (default `/tmp/generacy-bootstrap-complete`), starts code-server
  fire-and-forget, and writes the wizard env file. Readiness propagates via relay metadata,
  not the HTTP response.

### Cluster credentials and git auth

- Credential backends live in **`packages/credhelper/src/backends/`** as the single source of
  truth (`ClusterLocalBackend`, `CredentialFileStore`, AES-256-GCM `crypto.ts`).
  `credhelper-daemon/src/backends/` is re-exports only. Defaults: `/var/lib/generacy/credentials.dat`,
  `/var/lib/generacy/master.key`; atomic writes + fd advisory lock.
- **Git auth is just-in-time, not a static token.** `git-credential-generacy` (a
  `@generacy-ai/control-plane` bin) speaks the git credential-helper protocol and POSTs
  `/git-token` on the control socket; `GitTokenManager` caches `{ token, expiresAt }` in memory
  and synchronously refreshes from the cloud pull endpoint inside a 5 min window, sharing one
  in-flight promise. It never falls back to `GH_TOKEN` and never reads a token off disk.
  Workers reach it only through the `git-token-proxy` bin, which allows exactly
  `POST /git-token` (everything else 404s, no upstream contact).
- Anything that rewrites git config (`generacy setup auth` / `setup workspace`) can clobber the
  JIT helper with a stale wizard `GH_TOKEN` — re-run `setup-credentials.sh` to restore it.
- Non-git `gh` calls in the **orchestrator process** must resolve tokens explicitly via the
  `tokenProvider` pattern (`createWizardCredsTokenProvider`, mtime-cached read of
  `/var/lib/generacy/wizard-credentials.env`) and pass `{ env: { GH_TOKEN } }`. Never rely on
  ambient `gh auth`. Worker-process callers pass `undefined` and use the credhelper session env.
- `wizard-env-writer.ts` unseals wizard credentials into
  `/var/lib/generacy/wizard-credentials.env` (mode 0600) at `bootstrap-complete`. `github-app`
  values are **JSON** (`{ installationId, token, accountLogin, … }`) — extract `token` →
  `GH_TOKEN` and `accountLogin` → `GH_USERNAME` / `GH_EMAIL`; `github-pat` uses the raw value.
  Failures are best-effort/non-fatal.
- `gh` HTTP 401 surfaces as a distinct exported `GhAuthError` from
  `workflow-engine/.../client/gh-cli.ts`. Orchestrator monitors catch it *before* their generic
  catch and feed `GitHubAuthHealthService`, which rate-limits `refresh-requested` emissions on
  `cluster.credentials` to one per credential per 60 s; `CredentialExpiryWatcher` proactively
  requests a refresh inside 5 min of `expiresAt`.
- The docker socket proxy validates `POST /containers/create` bind mounts against
  `GENERACY_SCRATCH_DIR` (per-session `/var/lib/generacy/scratch/<session-id>/`, mode 0700) —
  host-socket mode only; DinD (`ENABLE_DIND=true`) skips the guard.

### Cloud URLs

- `GENERACY_CLOUD_URL` is **dead** — it is read nowhere. Use `GENERACY_API_URL` (HTTP REST,
  required in the orchestrator, CLI default `https://api.generacy.ai`), `GENERACY_RELAY_URL`
  (WebSocket relay), and `GENERACY_APP_URL` (dashboard, CLI-only, never written to cluster
  `.env`). The canonical CLI flag is `--api-url`; `--cloud-url` is a hidden deprecated alias.
  Cloud pre-appends `projectId`.

### Multi-repo workflows

- `siblingWorkdirs: Record<string, string>` (repo name → absolute path) rides on
  `ActionContext` / `ExecutionOptions` / `CliSpawnOptions`. Caller-injection is deliberate: the
  orchestrator resolves it with `config/src/repos.ts` `resolveSiblingWorkdirs()` so
  `workflow-engine` stays decoupled from `@generacy-ai/config`. Fails closed to `{}`.
- `phase:after` is the generic post-phase extension hook (`PhaseLoopDeps.phaseAfterHandlers`).
  Handlers run sequentially after commit/push + PR-ensure and before the gate check, fail-fast,
  and do **not** run at implement increment boundaries or on retry paths. Register there rather
  than editing `phase-loop.ts`.
- Review coordination: gate condition `on-sibling-review`, `GateChecker.checkGates()` returns
  *all* gates matching a phase (multi-gate-per-phase), and activating the gate flips every
  linked sibling draft PR to ready-for-review.

### Cockpit / worker gates

- Cockpit CLI verbs must resolve issue refs through **`resolveIssueContext`**, never
  `parseIssueRef` directly (`@internal`, qualified-forms-only). The bare-number branch and its
  rejection copy live in `resolveIssueContext`, and an ESLint `no-restricted-imports` override
  under `commands/cockpit/**` enforces this. There is no `cockpit.repos` config.
- `LabelManager.onGateHit()` clears the paired `resume:<gate>` dedupe key *after* the pause
  labels apply successfully — the clear is paired with the pause, not the resume check, so a
  pause that never manifested never clears a dedupe. `LabelManager` stays Redis-free via a
  narrow `clearResumeDedupe` callback rather than an injected `PhaseTrackerService`.
- The implement→continue increment has a **tasks.md fallback** (the "safety net"): when an
  implement phase succeeds with no `SPECKIT_IMPLEMENT_PARTIAL` sentinel
  (`result.implementResult === undefined`), `worker/tasks-md-fallback.ts` `evaluateTasksMd()`
  reads the workflow's `tasks.md` and returns `incomplete` / `complete` / `unreadable`. On
  `incomplete` the engine *synthesizes* `implementResult = { partial: true, tasks_remaining, … }`
  so the existing increment block in `phase-loop.ts` drives re-entry unchanged. The sentinel stays
  authoritative and is the fast path; tasks.md is only the fallback. There is no absolute
  re-entry cap — the no-progress guard (`tasksRemaining >= lastTasksRemaining`) is the only
  backstop, and `unreadable` (missing/ambiguous spec dir, unreadable file) advances rather than
  re-enters.
- Implement phases can pause on dependencies: the agent emits
  `SPECKIT_IMPLEMENT_BLOCKED: {"on": ["owner/repo#N", …]}`, the engine commits WIP, posts a
  `<!-- generacy-dependency-block -->` marker comment holding the canonical refs (the *sole*
  persisted store — no Redis, no disk, because dev-cluster Redis has no volume), and applies
  `waiting-for:dependencies` + `agent:paused`. `DependencyMonitorService` polls the refs and
  re-enqueues `continue` once all are closed. Cycle cap is 3 per grant, then
  `waiting-for:dependency-limit` (operator-only); the counter is *derived* from comment
  timestamps, not stored. Blocked coexists with PARTIAL and wins control flow.

### Cluster image builds

- Cluster image build/publish workflows live in **this** repo, not the template repos (template
  workflow files got copied into user repos and hit `403 Resource not accessible by
  integration`): `publish-cluster-base-image.yml`, `publish-cluster-microservices-image.yml`,
  and the 5-minute `poll-cluster-images.yml` cron that dispatches them. `develop` → `:preview`,
  `main` → `:stable`, plus an immutable `sha-<short>` tag. GHCR tags are the only state.

## Per-issue planning notes are NOT accumulated here

This file is auto-loaded as project instructions into every worker session; anything appended
here permanently taxes every future context window. Accumulated planning-phase sections once
grew it to ~285 KB and caused phases to die on autocompact thrashing.

**Do not append planning notes to this file.** Design notes, clarifications, and
decision records belong in `specs/<feature>/` on the feature branch and in the issue/PR thread.
Removed sections are recoverable from git history (`git log -p -- CLAUDE.md`) and from the
issues they name.

Only promote something into this file when it is a **durable, repo-wide invariant** a future
agent must not violate — and then write it as one or two lines in the relevant section above,
not as a phase narrative.
