# Feature Specification: ## Problem

`npx generacy launch` scaffolds a `docker-compose

**Branch**: `543-problem-npx-generacy-launch` | **Date**: 2026-05-08 | **Status**: Draft

## Summary

## Problem

`npx generacy launch` scaffolds a `docker-compose.yml` that cannot actually run the cluster. The container starts, exits cleanly with code 0 in ~800ms, and `restart: unless-stopped` revives it — producing a crash loop with no logs.

Surfaced during the v1.5 staging walkthrough on 2026-05-08. After fixing the previously-known issues (channel propagation, claim regex, activate auth leak, npm dist-tags), a fresh `launch` succeeds at the cloud / scaffold steps but the resulting cluster is dead-on-arrival.

## Root cause

The `cluster-base:preview` image is a **devcontainer image**, not a runtime image. Inspection of the image config:

```
ENTRYPOINT: ["docker-entrypoint.sh"]   # upstream typescript-node default
CMD: ["node"]                          # upstream typescript-node default
```

The orchestrator entrypoint script (`/usr/local/bin/entrypoint-orchestrator.sh`) is copied into the image by the cluster-base [Dockerfile](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/Dockerfile), but is **never wired up as the container's ENTRYPOINT or CMD**. It's invoked only by the cluster-base repo's [own compose file](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/docker-compose.yml) via a `command:` override.

When `docker compose up` runs the scaffolded compose with no `command:` override, the container runs `node` (the REPL). With no input attached, `node` exits cleanly. Container restarts. Loop forever.

The image is intentionally dual-purpose (devcontainer + runtime), and the cluster-base devcontainer compose handles the wiring. **The launch CLI's scaffolder doesn't.**

## Deltas: scaffolded compose vs. real cluster-base devcontainer compose

The scaffolder ([packages/generacy/src/cli/commands/cluster/scaffolder.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/scaffolder.ts#L62-L89)) currently emits a single-service compose. The real compose ([cluster-base/.devcontainer/generacy/docker-compose.yml](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/docker-compose.yml)) is fundamentally different. Every difference below contributes to the cluster being unable to boot:

| Aspect | Scaffolded (broken) | Real (works) |
|---|---|---|
| Services | One: `cluster` | Three: `orchestrator`, `worker`, `redis` |
| Command override | none — inherits `node` from image, exits immediately | `command: /usr/local/bin/entrypoint-orchestrator.sh` (and `entrypoint-worker.sh` for worker) |
| Worker scaling | n/a | `deploy.replicas: ${WORKER_COUNT:-3}` |
| Redis sidecar | absent | full `redis:7-alpine` service with healthcheck |
| Volumes | `cluster-data`, `/var/run/docker.sock` | `workspace`, `claude-config`, `~/.claude.json`, `shared-packages`, `npm-cache`, `generacy-data`, `redis-data` + the docker socket mounted at the non-default path `/var/run/docker-host.sock` |
| Worker tmpfs | n/a | `/run/generacy-credhelper` (uid 1002) and `/run/generacy-control-plane` (uid 1000) — load-bearing for the credentials architecture |
| Network | default | dedicated `cluster-network` bridge |
| Healthchecks | none | orchestrator on `/health`, worker on `:9001/health`, redis ping |
| `depends_on` chain | n/a | worker → orchestrator → redis (all `service_healthy`) |
| Env vars | 5 inline | 8+ env vars + `env_file: .env` and `.env.local` |
| Stop grace period | none | `30s` (matters for the credhelper daemon's clean shutdown) |
| `extra_hosts` | none | `host.docker.internal:host-gateway` |

The orchestrator entrypoint also blocks waiting for Redis (`while ! nc -z redis 6379; do sleep 1; done`), so even if `command:` were fixed, the absence of the redis service would hang the cluster indefinitely without surfacing any error to the user.

## Constraint

**The cluster-base compose structure should be preserved as-is.** It encodes a lot of intentional state — shared Claude config volumes, npm cache persistence, credentials-architecture isolation (uid 1001/1002 + tmpfs sockets), shared-packages volume orchestrator-writes/worker-reads, etc. The fix is **not** to flatten or simplify the structure, but to make the launch scaffolder produce something equivalent to it.

## Proposed direction

Make `scaffoldDockerCompose` emit a compose file that mirrors the cluster-base devcontainer compose, parameterized by the values the launch flow knows (project name, cluster id, image tag, channel, cloud URL, project id). Where the cluster-base compose pulls from `.env`, the scaffolder either generates a `.env` next to the compose or inlines the equivalents.

Two ways to deliver this:

- **A) Scaffolder emits the full compose inline.** The launch CLI knows the shape; the file it writes mirrors the cluster-base devcontainer compose 1:1. Simple to maintain in one place, but drifts when the cluster-base compose changes.
- **B) Scaffolder fetches a template from the image.** The cluster-base image ships the canonical compose at a known path (e.g. `/usr/local/share/generacy/launch.docker-compose.yml`), and the launch CLI runs a one-shot `docker run --rm cluster-base:<tag> cat <path> > docker-compose.yml`, then patches in the per-project values. Always in sync with the image, but adds a tooling round-trip and a templating concern.

## Open questions for clarify phase

- **Q1**: A or B above? A is simpler today; B avoids drift but adds machinery.
- **Q2**: How should `.env` and `.env.local` be handled? The cluster-base compose declares them as required/optional respectively. Should the scaffolder generate a `.env` from the LaunchConfig, prompt the user, or inline the values into the compose `environment:` block?
- **Q3**: `WORKER_COUNT` defaults to 3 in the cluster-base compose. Should the scaffolder respect the project's workers field (already in `cluster.yaml` as `workers: 1`) and pass it through, or always use the image default?
- **Q4**: `~/.claude.json` is bind-mounted. If the host doesn't have one, `docker compose up` will fail. Should the scaffolder pre-create an empty file, or document the prerequisite, or change the mount to a named volume with copy-from-default semantics?
- **Q5**: Issue #539's port-allocation work assumed a single-service compose. With orchestrator+worker, the host-port binding is just on the orchestrator's `${ORCHESTRATOR_PORT:-3100}`, plus the worker healthcheck is internal-only (port 9001 not host-exposed). Confirm port discovery / `generacy status` only needs to surface the orchestrator port.

## Reproduction

1. Mint a fresh launch claim in staging (or prod, once the same fixes ship).
2. `npx -y @generacy-ai/generacy@preview launch --claim=<fresh>`.
3. Observe the scaffolded `~/Generacy/<project>/.generacy/docker-compose.yml`.
4. `docker ps --filter name=generacy-cluster` shows `Restarting (0)` repeatedly with no logs.
5. `docker inspect <container>` shows `ExitCode: 0`, `Error: ""`, container lifetime ~800ms.

## Related

- #539 — port-allocation strategy (assumes single-service compose; will need to be reconciled with the multi-service shape this issue introduces)
- generacy-ai/cluster-base — source of the canonical compose this issue references
- The misleading 4xx error message in the CLI ([cloud-client.ts:96-98](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/launch/cloud-client.ts#L96-L98)) is a separate cross-cutting issue worth filing — but in this case the symptom (silent crash loop, no logs, exit 0) was misleading on its own without any 4xx involved.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
