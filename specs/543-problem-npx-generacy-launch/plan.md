# Implementation Plan: Fix launch CLI scaffolder to produce working multi-service compose

**Feature**: Fix `npx generacy launch` to scaffold a functional Docker Compose configuration
**Branch**: `543-problem-npx-generacy-launch`
**Status**: Complete

## Summary

The `scaffoldDockerCompose()` function in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` currently emits a single-service compose file that cannot run the cluster. The container starts, runs the bare `node` REPL (the image's default CMD), exits with code 0, and restarts in a loop.

This plan rewrites the shared scaffolder to emit a multi-service compose (orchestrator + worker + redis) mirroring the canonical cluster-base devcontainer compose, generates a `.env` file with cloud-provided values, and handles host prerequisites like pre-creating `~/.claude.json`.

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Package manager**: pnpm
- **CLI framework**: Commander.js
- **YAML library**: `yaml` (npm)
- **Test framework**: Vitest (assumed from codebase patterns)
- **Key package**: `packages/generacy/` — the CLI

## Approach: Option A (inline compose generation)

Per the spec, we use **Option A**: the scaffolder emits the full multi-service compose inline. This is simpler than fetching a template from the image and avoids a Docker round-trip at launch time.

## Architecture Changes

### Current flow
```
launch --claim=<code>
  → fetchLaunchConfig()
  → scaffoldProject()
      → scaffoldClusterJson()    → .generacy/cluster.json
      → scaffoldClusterYaml()    → .generacy/cluster.yaml
      → scaffoldDockerCompose()  → .generacy/docker-compose.yml  (broken single-service)
  → pullImage() → startCluster()
```

### New flow
```
launch --claim=<code>
  → fetchLaunchConfig()
  → scaffoldProject()
      → scaffoldClusterJson()    → .generacy/cluster.json       (unchanged)
      → scaffoldClusterYaml()    → .generacy/cluster.yaml       (unchanged)
      → scaffoldDockerCompose()  → .generacy/docker-compose.yml  (multi-service)
      → scaffoldEnvFile()        → .generacy/.env                (NEW)
      → preCreateClaudeJson()    → ~/.claude.json                (NEW, launch only)
  → pullImage() → startCluster()
```

## Project Structure (files to modify/create)

```
packages/generacy/src/cli/commands/
├── cluster/
│   ├── scaffolder.ts           # MODIFY — rewrite scaffoldDockerCompose(), add scaffoldEnvFile(), deriveRelayUrl()
│   └── __tests__/
│       └── scaffolder.test.ts  # MODIFY — update tests for multi-service compose + .env
├── launch/
│   ├── scaffolder.ts           # MODIFY — call scaffoldEnvFile(), add preCreateClaudeJson()
│   ├── index.ts                # MINOR — ensure preCreateClaudeJson runs
│   └── __tests__/
│       └── scaffolder.test.ts  # MODIFY — verify .env generation + ~/.claude.json
└── deploy/
    └── scaffolder.ts           # MODIFY — call scaffoldEnvFile(), use named volume for claude config
```

## Detailed Design

### 1. Shared scaffolder changes (`cluster/scaffolder.ts`)

#### 1a. Extended `ScaffoldComposeInput`

```typescript
export interface ScaffoldComposeInput {
  imageTag: string;
  clusterId: string;
  projectId: string;
  projectName: string;
  cloudUrl: string;              // HTTP base URL from LaunchConfig
  variant: 'cluster-base' | 'cluster-microservices';
  deploymentMode?: 'local' | 'cloud';
  workers?: number;              // NEW — default 1
  orgId: string;                 // NEW — needed for .env
  channel?: 'stable' | 'preview'; // NEW — for .env
  repoUrl?: string;              // NEW — from LaunchConfig.repos.primary
}
```

#### 1b. `deriveRelayUrl(cloudUrl: string, projectId: string): string`

Converts the HTTP cloud URL to the WebSocket relay URL expected by the cluster:
- `https://api.generacy.ai` → `wss://api.generacy.ai/relay?projectId=<id>`
- `http://localhost:3001` → `ws://localhost:3001/relay?projectId=<id>`

This resolves the GENERACY_CLOUD_URL name collision documented in clarifications Q2.

#### 1c. `scaffoldDockerCompose()` — multi-service output

The compose YAML will contain three services matching the cluster-base devcontainer compose:

**orchestrator** service:
- `image: <imageTag>`
- `command: /usr/local/bin/entrypoint-orchestrator.sh`
- `restart: unless-stopped`
- `ports`: `['${ORCHESTRATOR_PORT:-3100}:3100']` (cloud) or `['${ORCHESTRATOR_PORT:-3100}']` (local)
- `volumes`: workspace, claude-config (bind or named — see below), shared-packages, npm-cache, generacy-data, docker-host-socket
- `tmpfs`: `/run/generacy-credhelper:uid=1002`, `/run/generacy-control-plane:uid=1000`
- `healthcheck`: `curl -f http://localhost:3100/health || exit 1` (interval 10s, timeout 5s, retries 5, start_period 30s)
- `depends_on`: redis (service_healthy)
- `stop_grace_period: 30s`
- `extra_hosts`: `host.docker.internal:host-gateway`
- `environment` (inline): `REDIS_URL`, `REDIS_HOST`, `DEPLOYMENT_MODE`, `CLUSTER_VARIANT`
- `env_file`: `.env`, `.env.local` (optional, via `required: false` syntax)

**worker** service:
- Same image, `command: /usr/local/bin/entrypoint-worker.sh`
- `deploy.replicas: ${WORKER_COUNT:-1}`
- Same volumes as orchestrator minus docker socket
- Same tmpfs
- `healthcheck`: `curl -f http://localhost:9001/health || exit 1`
- `depends_on`: orchestrator (service_healthy)
- `environment` (inline): `REDIS_URL`, `REDIS_HOST`, `HEALTH_PORT=9001`, `DEPLOYMENT_MODE`, `CLUSTER_VARIANT`
- `env_file`: `.env`, `.env.local` (optional)

**redis** service:
- `image: redis:7-alpine`
- `restart: unless-stopped`
- `healthcheck`: `redis-cli ping` (interval 5s, timeout 3s, retries 5)
- `volumes`: `redis-data:/data`

**volumes** (named):
- `workspace`, `shared-packages`, `npm-cache`, `generacy-data`, `redis-data`
- `claude-config` (only for deploy/cloud mode)

**networks**:
- `cluster-network` (bridge driver)

#### 1d. `scaffoldEnvFile(dir, input)` — NEW

Writes `.generacy/.env` with the complete variable set from clarifications Q2:

```
# Identity (from cloud LaunchConfig — do not edit)
GENERACY_CLUSTER_ID=<clusterId>
GENERACY_PROJECT_ID=<projectId>
GENERACY_ORG_ID=<orgId>
GENERACY_CLOUD_URL=<derived wss relay URL>

# Project
PROJECT_NAME=<sanitized name>
REPO_URL=<repos.primary>
REPO_BRANCH=main
GENERACY_CHANNEL=<channel>
WORKER_COUNT=<workers>

# Cluster runtime
ORCHESTRATOR_PORT=3100
LABEL_MONITOR_ENABLED=true
WEBHOOK_SETUP_ENABLED=true
SKIP_PACKAGE_UPDATE=false
SMEE_CHANNEL_URL=
```

#### 1e. Docker socket mount path

Changes from `/var/run/docker.sock:/var/run/docker.sock` to `/var/run/docker.sock:/var/run/docker-host.sock` to match cluster-base's convention (enables the bind-mount guard in credhelper-daemon).

### 2. Launch scaffolder changes (`launch/scaffolder.ts`)

#### 2a. `preCreateClaudeJson()`

Before compose-up, check if `~/.claude.json` exists on the host. If not, write an empty JSON file (`{}`). This prevents the bind-mount from failing.

#### 2b. Updated `scaffoldProject()`

- Pass additional fields (`orgId`, `channel`, `workers`, `repoUrl`) through to `scaffoldDockerCompose()` and `scaffoldEnvFile()`.
- Call `scaffoldEnvFile()` after `scaffoldDockerCompose()`.
- Call `preCreateClaudeJson()` for launch (local) only.
- For launch: `~/.claude.json` is a bind mount (host file → container).

### 3. Deploy scaffolder changes (`deploy/scaffolder.ts`)

- Pass additional fields through to shared scaffolder.
- Call `scaffoldEnvFile()` with `deploymentMode: 'cloud'`.
- For deploy: `claude-config` is a named volume (no bind mount to remote host).

### 4. Claude config volume strategy (clarifications Q5)

| Command | `~/.claude.json` handling |
|---------|--------------------------|
| `launch` (local) | Bind mount: `~/.claude.json:/home/node/.claude.json`. Pre-create empty file if missing. |
| `deploy` (remote SSH) | Named volume: `claude-config:/home/node/.claude.json`. No host file needed. |

This is controlled by a `claudeConfigMode` field on `ScaffoldComposeInput` (`'bind'` or `'volume'`), defaulting to `'bind'` for launch and `'volume'` for deploy.

### 5. Port handling

Only the orchestrator exposes ports. Worker healthcheck port (9001) is internal only.
- Local (`launch`): `'${ORCHESTRATOR_PORT:-3100}'` (ephemeral host port)
- Cloud (`deploy`): `'${ORCHESTRATOR_PORT:-3100}:3100'` (fixed for SSH forwarding)

`generacy status` only needs to surface the orchestrator port — confirmed per spec Q5.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Compose generation | Option A (inline) | Simpler, no Docker round-trip; drift managed by tests |
| .env strategy | Generate .env + inline statics | Matches cluster-base pattern; user can override via .env |
| Worker count | Default 1 | Conservative for local; user scales via .env |
| Workspace mount | `/workspaces` named volume | Standard devcontainer convention |
| Claude config (launch) | Bind mount + pre-create | Local credentials flow into cluster |
| Claude config (deploy) | Named volume | Remote VM has no local Claude config |
| Docker socket path | `/var/run/docker-host.sock` | Matches cluster-base; enables bind-mount guard |
| Relay URL | Derived from HTTP cloudUrl | `https://X` → `wss://X/relay?projectId=<id>` |

## Risk Mitigation

1. **Relay URL derivation footgun**: The `GENERACY_CLOUD_URL` env var means different things in different contexts. The `deriveRelayUrl()` function encapsulates this; unit tests cover edge cases (trailing slashes, http vs https, localhost).

2. **Backwards compatibility**: Deploy command also uses the shared scaffolder. The `ScaffoldComposeInput` additions are all optional fields with sane defaults, preserving the existing deploy flow.

3. **Image drift**: Option A means the scaffolded compose may drift from the cluster-base devcontainer compose over time. Mitigation: integration tests that validate the scaffolded compose against a known-good structure.

## Verification

- Unit tests for `scaffoldDockerCompose()` verify three services, correct commands, volumes, tmpfs, healthchecks, depends_on, env_file references
- Unit tests for `scaffoldEnvFile()` verify complete variable set, relay URL derivation
- Unit tests for `preCreateClaudeJson()` verify create-if-missing behavior
- Unit tests for `deriveRelayUrl()` cover https→wss, http→ws, trailing slash, query params
- Manual verification: `npx generacy launch --claim=<code>` on staging produces a compose that boots successfully
