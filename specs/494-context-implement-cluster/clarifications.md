# Clarifications: CLI Cluster Lifecycle Commands (#494)

## Batch 1 — 2026-04-29

### Q1: CLI Package Location
**Context**: The spec says to implement in `packages/cli/` (greenfield), but there's already a CLI at `packages/generacy/src/cli/` using Commander.js v12 with commands like `run`, `worker`, `agent`, `orchestrator`, `setup`, `validate`, `doctor`, `init`. Adding a separate `packages/cli/` would create two CLI entry points.
**Question**: Should these cluster commands be added to the existing `packages/generacy/` CLI package, or should a new `packages/cli/` package be created as the spec states?
**Options**:
- A: Add to existing `packages/generacy/src/cli/` (reuse Commander.js setup, single CLI binary)
- B: Create new `packages/cli/` as spec states (separate package, separate entry point)

**Answer**: *Pending*

### Q2: Cluster ID Source
**Context**: The spec says "Project name = cluster ID from config" for `dockerComposeArgs`. However, existing `.generacy/cluster.yaml` files (e.g., in `cluster-base`) only contain `channel` and `workers` fields — no cluster ID. The ID needs to come from somewhere to set `--project-name`.
**Question**: Where does the cluster ID come from? Is it stored in `cluster.yaml`, in a separate file like `.generacy/cluster.json` (from activation persistence), or derived from the directory name?

**Answer**: *Pending*

### Q3: Registry Schema and Location
**Context**: The spec assumes "a cluster registry (local file) exists to track registered clusters." The architecture doc references `~/.generacy/clusters.json`. The `status` command needs to list all clusters, and `destroy` needs to remove entries, but the registry schema is not defined in the spec.
**Question**: What fields should each entry in `~/.generacy/clusters.json` contain? At minimum: `clusterId`, `path`, `lastSeen` — but should it also include `variant`, `composePath`, `channel`, `createdAt`?
**Options**:
- A: Minimal — `clusterId`, `path`, `lastSeen` only
- B: Rich — also include `variant`, `composePath`, `channel`, `createdAt`

**Answer**: *Pending*

### Q4: Compose File Path
**Context**: `dockerComposeArgs(context)` needs to build `--file=<path>`, but the spec doesn't specify where the Docker Compose file lives relative to `.generacy/cluster.yaml`. It could be alongside it in `.generacy/`, at the project root, or its path could be stored in `cluster.yaml`.
**Question**: Where is the Docker Compose file located that these commands should target?
**Options**:
- A: `.generacy/docker-compose.yml` (sibling to cluster.yaml)
- B: Path stored as a field in `cluster.yaml` (e.g., `composePath: ./docker-compose.yml`)
- C: Project root `docker-compose.yml` (standard Docker convention)

**Answer**: *Pending*

### Q5: Update Restart Mechanism
**Context**: The `update` command spec says "docker compose pull + restart" but there are multiple restart strategies with different behaviors. `docker compose restart` doesn't pick up new images; `docker compose up -d` recreates only changed containers; `docker compose up -d --force-recreate` recreates all containers.
**Question**: After `docker compose pull`, which restart method should `update` use?
**Options**:
- A: `docker compose up -d` (recreates only containers whose images changed)
- B: `docker compose up -d --force-recreate` (recreates all containers regardless)
- C: `docker compose down` followed by `docker compose up -d` (full stop-start cycle)

**Answer**: *Pending*
