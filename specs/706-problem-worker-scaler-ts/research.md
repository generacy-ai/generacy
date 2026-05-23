# Research: Worker Scaling via Docker Engine API

**Issue**: [#706](https://github.com/generacy-ai/generacy/issues/706)
**Branch**: `706-problem-worker-scaler-ts`

This document captures technology decisions and the rationale behind them. The five clarifications in `clarifications.md` cover *behavioural* decisions; this file covers *implementation-substrate* decisions (which client library, which HTTP transport, etc.).

---

## Docker Engine API client

**Decision**: Hand-rolled HTTP-over-Unix-socket client using `node:http` (no new dependencies).

**Alternatives considered**:

| Option | Pros | Cons |
|--------|------|------|
| **dockerode** (spec's primary suggestion) | Mature, typed, batteries-included (network connect, exec, etc.). Wide adoption. | Adds ~30 transitive deps including `tar-stream`, `JSONStream`, `debug`. Maintained but ergonomics are dated (callback-first, Promise wrappers added later). Spec already calls this out as optional. |
| **Hand-rolled `node:http`** *(chosen)* | Zero new deps. Matches existing patterns in `credhelper-daemon` (HTTP-over-Unix-socket for `/sessions`), `control-plane` (HTTP-over-Unix-socket for `/credentials`, `/lifecycle`), and `orchestrator → control-plane` IPC. Only ~150 LOC for the methods we need. | Need to maintain it. Loses type coverage for endpoints we don't implement (acceptable — we use 7 endpoints). |
| **`undici` with Unix-socket dispatcher** | Modern fetch-shape API. Already a transitive dep via Node 20+ built-ins. | Adds direct dep declaration. Adds complexity vs `node:http`. No win over `node:http` for 7-endpoint surface. |

**Rationale**: Hand-rolling wins on three axes: (1) consistency with sibling packages (`credhelper-daemon`, `control-plane` both use `node:http` over Unix sockets), (2) zero dep surface change, (3) we only need 7 Engine API endpoints. The dockerode surface area is overkill for `scaleWorkers`.

**References**:
- Docker Engine API v1.41 reference: https://docs.docker.com/reference/api/engine/version/v1.41/
- Existing pattern in `packages/credhelper-daemon/src/client.ts` (HTTP-over-Unix-socket)
- Existing pattern in `packages/control-plane/src/services/credential-writer.ts` (POST over Unix socket)

---

## Source-of-truth for "current worker count"

**Decision**: Docker Engine API (`GET /containers/json?all=true` filtered by compose labels) is the authoritative current count. Drop `.env`'s `WORKER_COUNT` read.

**Alternatives considered**:

- **Read from `.env`'s `WORKER_COUNT`** (current behaviour) — Drifts from reality if any worker has crashed or been manually removed. The whole point of FR-010 is that `.env` is dead state post-first-boot.
- **Read from `cluster.yaml`'s `workers` field** — Same drift problem, but slightly better intent. Still doesn't reflect actual running state.
- **Docker Engine API enumeration** *(chosen)* — Always reflects truth. With `?all=true` (Q3=A), accounts for exited replicas too.

**Rationale**: Single source of truth (the daemon) eliminates the entire class of "state drifted between files and reality" bugs. Spec FR-002 mandates this.

---

## Container-number assignment algorithm

**Decision**: Gap-fill ascending, then append. Pure function `assignContainerNumbers(existing: number[], target: number)` returns `{ toCreate: number[], toRemove: number[] }`.

**Behaviour**:

- **Scale up (target > existing.length)**:
  - Compute missing numbers in `[1..max(existing)]`, sort ascending → gaps.
  - Allocate from gaps first, then append `max(existing)+1, +2, …` until target reached.
- **Scale down (target < existing.length)**:
  - `toRemove` = highest-numbered exited replicas first (caller passes exited set in via separate arg), then highest-numbered running replicas, until size reduced to target.

**Alternatives considered**:

- **Always append, never gap-fill** — Container numbers grow unboundedly across scale cycles. Violates SC-003 (contiguous numbering).
- **Renumber surviving replicas after scale-down** — Forces recreate of healthy workers. Compose doesn't do this. Spec doesn't ask for it.

**Rationale**: Matches compose's own behaviour and satisfies SC-003. Pure function is trivially unit-testable.

---

## Container config cloning

**Decision**: `GET /containers/<sourceId>/json` → strip orchestrator-set fields → use the rest verbatim in `POST /containers/create`.

**Fields to strip / reset** (these are daemon-assigned and cannot be carried through):

- `Id`, `Created`, `State`, `Status`, `Hostname` (derived from container name when absent)
- `NetworkSettings` (we re-attach explicitly via `EndpointsConfig` + `connect`)
- `Mounts` *populated form* (use `HostConfig.Mounts` / `HostConfig.Binds` from `Config` instead, which are the canonical create-time fields)
- `Args` (already inside `Cmd` after inspect)

**Fields to keep verbatim**:

- `Image`, `Cmd`, `Env`, `Entrypoint`, `WorkingDir`, `User`, `Labels` (with `container-number` overwritten), `Healthcheck`, `StopSignal`, `StopTimeout`
- `HostConfig.*` (Binds, Mounts, RestartPolicy, NetworkMode, LogConfig, Resources, etc.)

**Label mutations**:

- `com.docker.compose.container-number` ← new number (string)
- All others (`com.docker.compose.project`, `com.docker.compose.service`, `com.docker.compose.config-hash`, etc.) → preserved unchanged (FR-007)

**Alternatives considered**:

- **Regenerate config from compose YAML** — Reintroduces the compose-file dependency we're removing. Defeats the whole purpose.
- **Hard-code worker config** — Drifts from compose definition; brittle.

**Rationale**: Cloning from a live source replica is the only path that's both (a) source-of-truth-free of compose YAML and (b) automatically tracks any orchestrator-time config changes (env vars, image tag, mount paths).

**Open question deferred to coding**: Exhaustive list of inspect → create field mappings. Docker's inspect response and create request have *different* field layouts (e.g. inspect has `NetworkSettings.Networks`, create has `NetworkingConfig.EndpointsConfig`). We'll write a `cloneInspectToCreate(inspect)` helper that handles the translation explicitly, unit-tested with a fixture from an actual running worker.

---

## Multi-network attachment sequencing

**Decision** (already locked by clarification Q1=A): `POST /containers/create` with first network in `NetworkingConfig.EndpointsConfig`, then `POST /networks/<id>/connect` per additional network *before* `POST /containers/<id>/start`.

**Sequencing rationale**:

1. **Create** with first network attached — required because `POST /containers/create` accepts at most one `EndpointsConfig` entry.
2. **Connect** remaining networks — `POST /networks/<id>/connect` works on stopped containers; safe pre-start.
3. **Start** — Container comes up with full network membership; workloads inside the worker see all networks from boot, no race with a "now connecting" event mid-boot.

**Source of network set**: `NetworkSettings.Networks` on the source replica's inspect (daemon-authoritative). Not the `com.docker.compose.network.*` labels (which aren't part of compose's stable documented contract).

---

## Partial-failure semantics

**Decision** (already locked by Q2=B): Commit what succeeded.

**Implementation shape**:

```typescript
class PartialScaleError extends Error {
  readonly name = 'PartialScaleError';
  constructor(
    readonly requested: number,
    readonly actual: number,
    readonly cause: Error,
  ) {
    super(`Partial scale: requested ${requested}, achieved ${actual} (${cause.message})`);
  }
}
```

`scaleWorkers` writes `cluster.yaml` with `actual`, fires metadata refresh, then `throw new PartialScaleError(...)`. Route handler in `lifecycle.ts` catches and renders structured response. Caller (cloud UI) can decide whether to retry the delta or surface to the user.

**Edge case**: Full failure (0 of N created). `cluster.yaml` is NOT updated; metadata refresh NOT fired; throw plain `Error` (not `PartialScaleError`). Distinguishes "made progress" from "made none."

---

## In-process mutex

**Decision** (already locked by Q4=A): Plain Promise-chain pattern.

```typescript
let inflight: Promise<unknown> = Promise.resolve();

export async function scaleWorkers(opts: ScaleOptions): Promise<ScaleResult> {
  const previous = inflight;
  let resolveNext!: (v: unknown) => void;
  inflight = new Promise(r => { resolveNext = r; });
  await previous;
  try {
    return await doScale(opts);
  } finally {
    resolveNext(undefined);
  }
}
```

**Alternative**: `async-mutex` package — adds a tiny dep for one use site. Not worth it.

**Rationale**: Already used in `CredentialFileStore` (now replaced by fd-based lock in #521 for cross-process needs, but the in-process Promise-chain remains the standard for single-process serialization). Matches package conventions.

---

## Removal: `.env`'s `WORKER_COUNT` field

**Decision**: Remove the read AND the write of `WORKER_COUNT` from `.env` (FR-010).

**Justification**:

- `.env` is consumed by `docker compose up` at boot; subsequent runtime changes to it have no effect on running containers (compose doesn't watch the file).
- `cluster.yaml` is the on-disk persistence boundary post-boot (already updated atomically by the existing code).
- Keeping the write would create a third source of truth (containers, `.env`, `cluster.yaml`) — guaranteed to drift.

**Risk**: A future `docker compose up -d` from the host (e.g. `generacy up` lifecycle command) would re-read `.env`'s `WORKER_COUNT=1` (default) and either downscale or no-op. **Mitigation**: out of scope for this issue. The host-side CLI lifecycle commands (`up`, `restart`) need to sync `cluster.yaml.workers` → compose's `--scale` arg as a separate fix. We can document this in a code comment to bookmark it.

---

## DOCKER_HOST resolution

**Decision**: Reuse current logic. Env var `DOCKER_HOST` overrides default `unix:///var/run/docker-host.sock`. Daemon-unreachable surfaces as `DOCKER_DAEMON_UNAVAILABLE` (renamed from `DOCKER_CLI_UNAVAILABLE` because we no longer use the CLI).

**Rationale**: Preserves existing override mechanism for dev/test; matches mounted socket path in cluster-base (DooD via `docker-host.sock`).

---

## Testing strategy

**Unit tests** (Vitest, mocked Engine client):

- `docker-engine-client.test.ts`: HTTP transport correctness — URL formation, Unix socket connection, response parsing, error mapping (`ECONNREFUSED` → `DOCKER_DAEMON_UNAVAILABLE`).
- `worker-scaler.test.ts`: Pure helpers (`assignContainerNumbers`, `cloneInspectToCreate`) + orchestration with mocked client. Cases:
  - Scale up: 1 → 3, gap-fill ([1, 3] target 4), multi-network clone, partial failure (mock 3rd create to reject).
  - Scale down: 3 → 1, exited-first removal order (Q3 sub-decision), running-only order.
  - No-op: requested == current.
  - Mutex: two concurrent invocations, assert serialized.
  - Full failure: 0 of N created, `cluster.yaml` unchanged.

**Integration test deferred**: Engine API round-trip against a real or `docker-in-docker` daemon — file as a follow-up if maintenance cost is low. Manual SC-001/SC-002 validation against a live `npx generacy launch` cluster is the spec's primary acceptance gate.

---

## References

- Docker Engine API v1.41: https://docs.docker.com/reference/api/engine/version/v1.41/
- Compose label spec: https://docs.docker.com/reference/compose-file/services/#labels (also see `com.docker.compose.*` reserved labels)
- Issue thread: https://github.com/generacy-ai/generacy/issues/706
- Clarification responses: https://github.com/generacy-ai/generacy/issues/706#issuecomment-4526309027
- Companion `cluster-base` issue (CWD fix): tracked separately per spec "Out of Scope"
