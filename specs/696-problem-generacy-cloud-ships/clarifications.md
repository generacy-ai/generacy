# Clarifications

## Batch 1 — 2026-05-22

### Q1: Relay channel for worker-scale events
**Context**: FR-008 specifies pushing a `cluster.status` relay event after scaling. However, the orchestrator's relay-event forwarding route (`packages/orchestrator/src/routes/internal-relay-events.ts:5-10`) only allows 4 channels: `cluster.vscode-tunnel`, `cluster.audit`, `cluster.credentials`, `cluster.bootstrap`. The `cluster.status` channel does not exist in the allowlist and has no cloud-side handler (as far as this repo shows). Using an unregistered channel will silently drop the event.
**Question**: Should we add `cluster.status` as a new allowed relay channel (requires orchestrator change + cloud-side listener), or should we push the event on an existing channel like `cluster.bootstrap`? What payload shape does the cloud expect for this event?
**Options**:
- A: Add new `cluster.status` channel to `ALLOWED_CHANNELS` and implement cloud-side listener
- B: Use existing `cluster.bootstrap` channel with a distinguishable event type (e.g., `{ type: 'worker-scaled', workers: N }`)
- C: Skip the relay event entirely and rely on the relay-bridge's periodic metadata refresh (carries the updated `workers` field from `cluster.yaml`)

**Answer**: *Pending*

### Q2: Compose project name resolution
**Context**: FR-006 requires running `docker compose up -d --scale worker=<n>` from inside the orchestrator container. Docker Compose needs the project name (`-p` flag) to match the one used when the containers were originally launched — otherwise it creates new containers instead of scaling existing ones. The CLI starts clusters with an explicit `--project-name` (derived from `cluster.json` or directory name in `commands/cluster/compose.ts`), but that value is not passed into the container as an environment variable. Docker Compose does not automatically set `COMPOSE_PROJECT_NAME` inside containers.
**Question**: How should the handler determine the correct compose project name from inside the container? Should the scaffolder be updated to inject `COMPOSE_PROJECT_NAME` into the container's environment, or is there another source?
**Options**:
- A: Add `COMPOSE_PROJECT_NAME` as an env var in the scaffolded `docker-compose.yml` (set to the same value the CLI uses)
- B: Read it from Docker container labels (`com.docker.compose.project`) via Docker Engine API
- C: Derive from `cluster.json` fields (e.g., `cluster_id` or project directory name)
- D: Rely on Docker Compose's default (parent directory of compose file, i.e., `.generacy` → project name `generacy`)

**Answer**: *Pending*

### Q3: Docker Compose CLI availability in container
**Context**: FR-006 assumes `docker compose` (Compose V2 plugin) is available inside the orchestrator container. The codebase shows no existing usage of `docker compose` CLI from within the control-plane or orchestrator — other services use `spawn('git', ...)` or `spawn(binPath, ...)` for their respective CLIs. The issue author states "docker compose calls from inside the orchestrator work," but if the cluster-base image doesn't include the Docker CLI + Compose plugin, the handler would need to use the Docker Engine HTTP API over the socket instead.
**Question**: Can you confirm that the cluster-base Docker image includes `docker` CLI with Compose V2 plugin? If not, should the handler use the Docker Engine API (HTTP calls to `/var/run/docker-host.sock`) to scale the service?
**Options**:
- A: Docker CLI + Compose V2 is installed in cluster-base (proceed with `spawn('docker', ['compose', ...])`)
- B: Docker CLI is not available — use Docker Engine API over Unix socket (service update endpoint)
- C: Docker CLI should be added to cluster-base as a prerequisite for this feature

**Answer**: *Pending*
