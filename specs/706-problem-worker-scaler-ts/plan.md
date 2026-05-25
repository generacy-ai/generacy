# Implementation Plan: Worker Scaling via Docker Engine API

**Feature**: Replace `worker-scaler.ts` compose shell-out with direct Docker Engine API calls
**Branch**: `706-problem-worker-scaler-ts`
**Issue**: [#706](https://github.com/generacy-ai/generacy/issues/706)
**Status**: Complete

## Summary

`worker-scaler.ts` currently shells out to `docker compose -f <workspace>/.generacy/docker-compose.yml up -d --scale worker=N`. For clusters launched via `npx generacy launch` (Flow B), the compose file lives on the host and is not bind-mounted into the orchestrator container, so every scale request fails with `ENOENT` before `docker compose` is ever invoked.

This implementation replaces the shell-out with direct Docker Engine API calls over the already-mounted `/var/run/docker-host.sock` socket. We enumerate worker containers by their `com.docker.compose.*` labels, clone an existing replica's config, and create/start/stop/remove replicas directly. The compose-file dependency is removed entirely. The change is contained to `packages/control-plane/src/services/worker-scaler.ts` plus a new low-level Engine API client module; the route handler and request/response shape are unchanged.

Five clarification decisions (Q1–Q5 in `clarifications.md`) drive non-trivial behaviour:

- **Q1 (A)** Multi-network replicas: attach to the first network at create time, `POST /networks/<id>/connect` for the rest before `start`.
- **Q2 (B)** Partial failure: commit what succeeded, write achieved count to `cluster.yaml`, return structured `{ requested, actual }` error.
- **Q3 (A)** Counting: `?all=true` includes exited replicas in the current count; retire them first on scale-down.
- **Q4 (A)** Concurrency: in-process async mutex serializes `scaleWorkers()` calls.
- **Q5 (A)** Name collision on gap-fill: `DELETE /containers/<id>?force=true` then create. Edge case after Q3.

## Technical Context

**Language / runtime**: TypeScript, Node.js >=20 (matches `packages/control-plane/package.json`)
**Module system**: ESM
**Test framework**: Vitest 4.x
**Validation**: Zod 3.x (existing dep — used for schema validation of inspect responses if needed)
**YAML**: `yaml` 2.x (existing dep — preserved for `cluster.yaml` update)
**HTTP client**: Native `node:http` over Unix socket (matches credhelper-daemon and control-plane patterns — no new deps). Decision rationale in [research.md](./research.md#docker-engine-api-client).
**Docker socket**: `/var/run/docker-host.sock` (mounted via DooD in cluster-base). Override via `DOCKER_HOST=unix://<path>` env var (preserved from current implementation).
**Concurrency primitive**: Single in-process async mutex (Promise-chain pattern, no new dep). Pure-helper implementation.

### Dependencies

- **No new runtime dependencies**. Hand-rolled HTTP-over-Unix-socket client using `node:http`. Pattern matches `credhelper-daemon` and `control-plane`'s existing IPC. Spec leaves `dockerode` as an acceptable alternative but the hand-rolled approach is preferred here to keep the package footprint minimal and consistent with sibling packages.
- Existing deps reused: `yaml` (cluster.yaml update), `zod` (response shape validation if used).

### Out of scope (per spec)

- Scale-up from zero workers.
- Per-worker lifecycle ops (pause/drain/individual restart).
- Cloud-deployed scaling (DigitalOcean App Platform, etc.).
- Orchestrator CWD fix for workspace-relative reads (separate `cluster-base` issue).
- Rewriting other compose shell-outs in the codebase.
- Changes to cloud-side `PATCH /workers` contract.

## Project Structure

```
packages/control-plane/
├── src/
│   ├── services/
│   │   ├── worker-scaler.ts          ← REWRITE: Engine API impl + mutex + commit-what-succeeded
│   │   └── docker-engine-client.ts   ← NEW: HTTP-over-Unix-socket client for Docker Engine API
│   ├── routes/
│   │   └── lifecycle.ts              ← MODIFY: surface `{ requested, actual }` in partial-failure error payload
│   └── schemas.ts                    ← MODIFY: extend WorkerScale response schema with optional `actual` field
└── __tests__/
    └── services/
        ├── worker-scaler.test.ts        ← REWRITE: drop spawn mock, mock Engine client
        └── docker-engine-client.test.ts ← NEW: unit tests for client (HTTP fixture)
    └── routes/
        └── lifecycle-worker-scale.test.ts ← MODIFY: drop DOCKER_CLI_UNAVAILABLE case; add partial-failure case
```

### File-level responsibilities

- **`docker-engine-client.ts`** (NEW, ~150 LOC): Thin typed wrapper around `node:http` over Unix socket. Methods needed:
  - `listContainers({ filters, all })` → `ContainerSummary[]` (`GET /containers/json`)
  - `inspectContainer(id)` → `ContainerInspect` (`GET /containers/<id>/json`)
  - `createContainer(name, config)` → `{ Id, Warnings }` (`POST /containers/create`)
  - `startContainer(id)` (`POST /containers/<id>/start`)
  - `stopContainer(id)` (`POST /containers/<id>/stop`)
  - `removeContainer(id, { force })` (`DELETE /containers/<id>`)
  - `connectNetwork(networkId, { Container, EndpointConfig })` (`POST /networks/<id>/connect`)
  - Reads `DOCKER_HOST` env var; defaults to `unix:///var/run/docker-host.sock`. Throws `DOCKER_DAEMON_UNAVAILABLE` on `ECONNREFUSED`/`ENOENT` (replaces `DOCKER_CLI_UNAVAILABLE`).

- **`worker-scaler.ts`** (REWRITE, ~250 LOC after rewrite):
  - Keep public API: `scaleWorkers(ScaleOptions): Promise<ScaleResult>`, `readCurrentCount`, `updateClusterYaml`. Drop `readCurrentCount(envPath)` and `updateEnvFile` (FR-010 removes `.env` writes).
  - **`ScaleResult` extended**: `{ previousCount, requestedCount, actualCount }`. `actualCount` equals `requestedCount` on success; differs on partial failure (FR-012).
  - New helpers (pure, unit-tested):
    - `computeProjectName(): Promise<string>` — Inspect orchestrator's own container by hostname; read `com.docker.compose.project` label.
    - `enumerateWorkers(client, project): Promise<WorkerReplica[]>` — `?all=true` filtered query.
    - `assignContainerNumbers(existing: number[], target: number): { toCreate: number[], toRemove: number[] }` — Pure: gap-fill + scale-up/down planner. Handles FR-006.
    - `cloneReplicaConfig(inspect, newNumber, newName): ContainerCreateBody` — Strips orchestrator-set fields (`Hostname`, `Id`, etc.), mutates only number-label and name.
    - `scaleUp(client, project, source, toCreate)` — Iterate; per replica: create-with-first-network, connect-remaining-networks, start. Stops on first error and returns `{ created: number[], failed: { number, error }[] }`.
    - `scaleDown(client, replicas, toRemove)` — Sort: exited first (highest-numbered), then running (highest-numbered). Stop + delete each.
  - **Mutex**: Module-level `let inflight: Promise<unknown> | null = null` Promise-chain (FR-014). Wrap entire `scaleWorkers` body.
  - **Error surfaces**: Throw `Error` with `name: 'PartialScaleError'` and `{ requested, actual }` on instance for the route handler to map to a 207-style response (or 500 with structured payload).

- **`lifecycle.ts`** (MODIFY, +~10 LOC):
  - In `worker-scale` branch, catch `PartialScaleError` separately; include `actual` in the response body. Existing `DOCKER_CLI_UNAVAILABLE` → `DOCKER_DAEMON_UNAVAILABLE` rename in the error-code mapping. Body still emits status 200 (best-effort succeeded partly) with `partial: true` flag, or 503 with `requested/actual` shape — preferred shape resolved in [contracts/](./contracts/worker-scale-response.md).

- **`schemas.ts`** (MODIFY, +~5 LOC): Extend response schema for `worker-scale` with optional `actualCount?: number` and `partial?: boolean` fields.

## Constitution Check

No `.specify/memory/constitution.md` present in the repository — no constitution constraints to verify.

Repository-level conventions (from `CLAUDE.md`) satisfied:

- Native `node:http`, no Express — matches credhelper-daemon and control-plane patterns. ✓
- Zod-validated schemas at boundaries. ✓
- Atomic file writes for `cluster.yaml` (`temp + rename`). ✓ (preserved)
- Fail-closed on unknown daemon errors. ✓ (PartialScaleError surfaces `{ requested, actual }`)
- No new heavyweight deps (`dockerode` skipped in favor of hand-rolled client). ✓

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Engine API response shape drifts across Docker versions | Use only stable fields (`Id`, `Names`, `Labels`, `NetworkSettings.Networks`, `Config.*`, `HostConfig.*`). Cite Docker Engine API version 1.41+ (matches `apt`-installed docker on Ubuntu 22+). Zod-validate inspect responses defensively, narrow only fields we read. |
| Orchestrator's own labels not set (run outside compose, dev mode) | `computeProjectName` falls back to `COMPOSE_PROJECT_NAME` env var, then throws `ORCHESTRATOR_NOT_COMPOSE_MANAGED`. Surface as `SERVICE_UNAVAILABLE`. |
| Cloned replica's `Hostname` collides if not reset | `cloneReplicaConfig` clears `Hostname` (Docker derives from container name when absent). |
| Networks the source isn't on (but compose would attach) | Out of scope — spec Q1=A explicitly uses source `NetworkSettings.Networks` as the source of truth. Document as expected behaviour in code comment. |
| Source replica has anonymous-volume mounts that re-init per-container | Spec assumes workspace volume is bind-mounted; anonymous volumes are workspace-private. Match compose's clone behaviour: copy `HostConfig.Mounts` verbatim; per-container anonymous-volume mounts get fresh volumes on clone (same as compose). |
| Concurrent `scaleWorkers` from a restart / replacement instance | Out of scope — single-process orchestrator topology (spec FR-014). |

## Open implementation choices

These are implementation-detail decisions deferred to coding-time; the spec doesn't constrain them and either path satisfies the requirements:

- **Engine API JSON field casing**: Docker API uses PascalCase (`Id`, `Names`, `Labels`). Use as-is in TypeScript types rather than translating — saves a layer.
- **Mutex implementation**: Plain Promise-chain (`inflight = (inflight ?? Promise.resolve()).then(...)`). No external dep like `async-mutex`. Pattern matches existing `CredentialFileStore` lock.
- **Logging**: Match existing `worker-scaler.ts` (no logger import; `console.log`/`console.warn`). Defer pino integration to a separate refactor.

## Next Step

Run `/speckit:tasks` to generate the dependency-ordered task list.
