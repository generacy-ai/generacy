# Fix launch CLI scaffolder to produce a working docker-compose.yml

**Branch**: `543-problem-npx-generacy-launch` | **Date**: 2026-05-08 | **Status**: Draft

## Summary

`npx generacy launch` scaffolds a single-service `docker-compose.yml` that is fundamentally incompatible with the `cluster-base` image. The container starts, runs `node` (the default CMD), exits cleanly with code 0, and `restart: unless-stopped` creates a crash loop. The fix is to make the scaffolder emit a multi-service compose matching the canonical cluster-base devcontainer compose structure (orchestrator + worker + redis), with correct entrypoints, volumes, healthchecks, and env vars.

## Problem

The `cluster-base:preview` image is a devcontainer image whose Dockerfile sets `CMD: ["node"]` (inherited from the upstream typescript-node base). The orchestrator entrypoint (`/usr/local/bin/entrypoint-orchestrator.sh`) exists in the image but is only invoked via the cluster-base repo's own `docker-compose.yml` using a `command:` override.

The launch CLI's `scaffoldDockerCompose` emits a single `cluster` service with no `command:` override, no Redis sidecar (required by the orchestrator's startup sequence), no worker service, wrong volume mounts, and missing healthchecks. The result is a dead-on-arrival cluster.

See the [detailed delta table in the issue](https://github.com/generacy-ai/generacy/issues/543) for every difference between the scaffolded and working compose files.

## User Stories

### US1: First-time user runs `npx generacy launch`

**As a** developer using Generacy for the first time,
**I want** `npx generacy launch --claim=<code>` to produce a fully working cluster,
**So that** I can start using Generacy immediately without manual Docker debugging.

**Acceptance Criteria**:
- [ ] `docker compose up -d` on the scaffolded compose starts orchestrator, worker(s), and Redis
- [ ] All three services reach healthy state within 60 seconds
- [ ] The orchestrator completes activation and connects to the cloud relay
- [ ] No crash loops, no exit-code-0 restarts, no hanging on Redis connection

### US2: Deploy command produces equivalent cluster

**As a** user deploying to a remote VM via `generacy deploy ssh://...`,
**I want** the scaffolded compose to work identically to the launch flow,
**So that** remote clusters boot correctly without manual intervention.

**Acceptance Criteria**:
- [ ] Deploy scaffolder uses the same `scaffoldDockerCompose` and produces the same multi-service compose
- [ ] Remote `docker compose up -d` over SSH boots all three services

### US3: Worker scaling respects project config

**As a** user who has configured `workers: N` in their cluster.yaml,
**I want** the scaffolded compose to deploy N worker replicas,
**So that** I get the parallelism I configured.

**Acceptance Criteria**:
- [ ] `WORKER_COUNT` env var is set from `cluster.yaml` workers field (or `ScaffoldComposeInput`)
- [ ] `deploy.replicas: ${WORKER_COUNT:-1}` in worker service definition

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `scaffoldDockerCompose` emits three services: `orchestrator`, `worker`, `redis` | P0 | Mirrors cluster-base devcontainer compose |
| FR-002 | Orchestrator service has `command: /usr/local/bin/entrypoint-orchestrator.sh` | P0 | Without this the image runs `node` and exits |
| FR-003 | Worker service has `command: /usr/local/bin/entrypoint-worker.sh` | P0 | Same issue as orchestrator |
| FR-004 | Redis service uses `redis:7-alpine` with ping healthcheck | P0 | Orchestrator blocks on Redis at startup |
| FR-005 | Orchestrator `depends_on: redis (service_healthy)` | P0 | Ensures boot order |
| FR-006 | Worker `depends_on: orchestrator (service_healthy)` | P0 | Ensures boot order |
| FR-007 | Orchestrator healthcheck on `/health` endpoint | P1 | Enables `depends_on` and `generacy status` |
| FR-008 | Worker healthcheck on `:9001/health` (internal only) | P1 | Enables `depends_on` chain |
| FR-009 | Docker socket mounted at `/var/run/docker-host.sock` (not default path) | P0 | Required for DinD/host-socket architecture |
| FR-010 | Named volumes: `workspace`, `claude-config`, `shared-packages`, `npm-cache`, `generacy-data`, `redis-data` | P1 | Matches cluster-base for persistence |
| FR-011 | Worker tmpfs mounts: `/run/generacy-credhelper` (uid 1002), `/run/generacy-control-plane` (uid 1000) | P0 | Load-bearing for credentials architecture |
| FR-012 | Dedicated `cluster-network` bridge network | P1 | Service isolation |
| FR-013 | `stop_grace_period: 30s` on orchestrator and worker | P1 | Clean credhelper shutdown |
| FR-014 | `extra_hosts: host.docker.internal:host-gateway` | P1 | Required for host networking |
| FR-015 | `ScaffoldComposeInput` gains `workers` field; compose uses it for `WORKER_COUNT` | P1 | Respects project config |
| FR-016 | Scaffolder generates `.env` file alongside compose with LaunchConfig values | P2 | Matches cluster-base pattern |
| FR-017 | Pre-create `~/.claude.json` if missing (empty JSON object) to prevent bind-mount failure | P1 | Prevents Docker error on first run |
| FR-018 | Remove `version: '3.8'` from emitted compose (deprecated in Compose v2) | P2 | Cleanup |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Launch cluster boots successfully | 100% of launches produce running clusters | Manual test: `npx generacy launch`, all 3 services healthy |
| SC-002 | No crash loop on fresh launch | 0 restarts within first 5 minutes | `docker inspect` shows `RestartCount: 0` |
| SC-003 | Deploy produces equivalent cluster | Same compose shape as launch | Diff scaffolded files between launch and deploy |
| SC-004 | Existing tests pass | All unit tests green | `pnpm test` in packages/generacy |

## Assumptions

- The cluster-base image continues to ship `/usr/local/bin/entrypoint-orchestrator.sh` and `/usr/local/bin/entrypoint-worker.sh` at those paths.
- The cluster-base image will not change its service architecture (orchestrator + worker + redis) without a coordinated update.
- Approach **A** (inline compose in scaffolder) is used initially. Drift risk is acceptable for now; approach B can be pursued later if needed.
- `cluster-microservices` variant follows the same compose structure as `cluster-base` (same entrypoints, same Redis dependency).

## Out of Scope

- Changing the cluster-base image's ENTRYPOINT/CMD (the image is intentionally dual-purpose).
- Approach B (fetching compose template from the image at runtime).
- Reconciling with #539 port-allocation changes (will be handled in #539 or a follow-up).
- Fixing the misleading 4xx error message in `cloud-client.ts` (separate issue).
- Adding integration tests that actually boot Docker containers.

## Open Questions

- **Q1**: Should `.env` and `.env.local` be generated, or should all values be inlined into the compose `environment:` block? (Proposed: generate `.env` for cloud-provided values, inline for static values.)
- **Q2**: Should `~/.claude.json` bind-mount be replaced with a named volume to avoid the missing-file problem? (Proposed: pre-create empty file for now, consider named volume later.)
- **Q3**: Are there additional env vars beyond what the issue lists that the orchestrator/worker need at boot? (Need to cross-reference cluster-base `.env.example`.)

---

*Generated by speckit*
