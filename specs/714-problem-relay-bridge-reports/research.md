# Research: Reporting actual worker container count

This document captures the technology and implementation decisions behind the plan, with rationale and rejected alternatives. It supplements `clarifications.md` (which captures the four binding answers) with the lower-level mechanics that did not need a clarification round.

## Decision 1 — Reuse the existing `DockerEngineClient` rather than calling `docker compose ps`

**Decision**: Read worker state via the Docker Engine API (`GET /containers/json?filters=...`) using `DockerEngineClient` and `enumerateWorkers` exactly as they already work in `worker-scaler.ts`.

**Rationale**:
- The orchestrator already has socket access on every variant (cluster-base via DooD, cluster-microservices via the in-container daemon).
- `enumerateWorkers` already filters by `com.docker.compose.project` + `com.docker.compose.service=worker`. The filter is identical to what we need.
- No shell-out, no compose-file dependency. Works on every cluster shape (compose-file-on-host, compose-file-in-image, future runtime-managed).
- Re-introducing `docker compose ps` would re-add the host-compose-file coupling that #706 just eliminated.

**Alternatives considered**:
- *Shell `docker compose -p <project> ps --format json`* — pulls a CLI into the orchestrator image, slower than direct Engine API, has the same compose-file caveat we just removed.
- *Read `docker stats` socket* — wrong granularity (per-container metrics) and still doesn't tell you whether the container exists.

## Decision 2 — Extraction location: `packages/control-plane/src/services/worker-enumeration.ts`

**Decision**: New file containing `WorkerReplica`, `computeProjectName`, `enumerateWorkers`. `worker-scaler.ts` re-imports from there. Public re-export from `packages/control-plane/src/index.ts`.

**Rationale** (per clarification C2):
- Orchestrator already depends on `@generacy-ai/control-plane`; adding exports is the smallest change.
- These helpers have zero orchestrator-specific dependencies, so no risk of a circular workspace dep.
- Extracting them out of `worker-scaler.ts` is a no-behavior-change move; the file becomes a re-export.

**Alternatives considered**:
- *New `@generacy-ai/docker-engine` package* — two consumers don't justify a new workspace package + its build/version overhead.
- *Re-export through a path subpath (`@generacy-ai/control-plane/worker-enumeration`)* — solves a coupling problem that doesn't exist; orchestrator depends on the package proper already.

## Decision 3 — Event subscription: Docker Engine `/events` over HTTP-on-Unix-socket

**Decision**: Subscribe at `RelayBridge.start()` to:

```
GET /events?filters={"label":["com.docker.compose.project=<project>","com.docker.compose.service=worker"],"type":["container"]}
```

Parse line-delimited JSON. On each event with `Action ∈ {die, start, destroy, create}`, call `RelayBridge.sendMetadata()`. On close/error, exponential backoff (5s → 10s → 20s → 60s) and reconnect. Cancel on `RelayBridge.stop()`.

**Rationale** (per clarification C3-B):
- Hits the 10s SLA without raising the heartbeat rate 6×.
- Engine API `/events` is a stable, documented, long-lived stream — same surface the daemon offers to `docker events`.
- The socket the orchestrator already opens supports `Connection: keep-alive` long polls — no infrastructure change.
- This also forms a foundation for the future per-worker liveness work (`busy`/`idle`).

**Filter design notes**:
- `type: ["container"]` keeps us off network/volume/image/system events.
- `label:` is a substring-style filter on the daemon side; pinning both project + service narrows to the relevant worker set even if multiple compose projects share a daemon (common on `cluster-microservices` DinD where daemons are scoped, but harmless either way).
- We do *not* filter on Action server-side. The Engine API's `filters.event` field exists but Action filters cleanly client-side and reduces filter-string complexity; the event stream is sparse enough that the cost of receiving unwanted actions is trivial.

**Reconnect strategy** (mirrors `cluster-relay` WebSocket backoff):
- Initial delay: 5s.
- On each consecutive failure, double up to 60s ceiling.
- Reset to 5s on successful reconnect (a stream open that yields ≥1 event or stays alive for ≥30s — easier to implement as "reset on any received bytes").

**Alternatives considered**:
- *Lower `metadataIntervalMs` to 10s* — 6× more relay payloads for the entire metadata shape; rejected in C3-A.
- *Poll `enumerateWorkers` every 5s* — same chatter as A on the Engine API side without the cloud benefit.
- *Relax the SLA to 60s* — gives up the user-visible improvement; rejected in C3-C.

## Decision 4 — Adding `streamContainerEvents` to `DockerEngineClient` instead of a new module

**Decision**: Add a single method on `DockerEngineClient`:

```ts
streamContainerEvents(opts: {
  filters: { label?: string[]; type?: string[] };
  signal?: AbortSignal;
}): AsyncIterable<EngineEvent>;
```

`EngineEvent` is a minimal type: `{ Type: 'container'; Action: string; id?: string; Actor?: { Attributes?: Record<string,string> } }`. We narrow `unknown` from the wire to this shape (only fields we read).

**Rationale**:
- Keeps the Docker-API surface co-located on the existing client (alongside `listContainers`, `inspectContainer`, etc.).
- `AsyncIterable` composes cleanly with `AbortSignal`; the consumer's `for await` loop ends when the iterator returns.
- The implementation is a thin `node:http` `GET` with stream parsing — same primitive as the other methods.

**Alternatives considered**:
- *EventEmitter on the client* — leakier lifecycle (handlers stay attached after `stop()`), harder to backpressure.
- *Standalone `worker-events-subscriber.ts` module* — duplicates socket-path/timeout config that already lives on `DockerEngineClient`.

## Decision 5 — Failure handling: omit rather than fall back

**Decision** (per clarification C4-A): On any of `DockerDaemonUnavailableError`, generic engine errors, or `ORCHESTRATOR_NOT_COMPOSE_MANAGED`, leave `metadata.workers` undefined on the next payload. Do **not** fall back to `cluster.yaml`'s declared value.

**Rationale**:
- The cloud UI already handles absence (`cluster?.workers?.total ?? …` patterns); honest-unknown is preferable to a stale declared value.
- Falling back to the YAML value is exactly the bug this issue exists to fix; reintroducing it during failure windows would mask the same divergence at the worst time (when something is already wrong).
- Dev-mode (`pnpm dev`, no compose) is acceptable to show as "unknown" in the UI; the YAML value (typically 3) would be more misleading than helpful in that environment.

## Decision 6 — Keep the periodic heartbeat unchanged

**Decision**: `metadataIntervalMs` stays at its current default (60s). The event subscription is the responsiveness mechanism; the heartbeat is the catch-all/health signal.

**Rationale**:
- Heartbeats also carry uptime, git remotes, version, init-result, and cluster-state — none of which need <60s freshness.
- Cutting the heartbeat introduces N× cloud-side write amplification for fields that don't change.
- Two-mechanism design (periodic for shape, events for hot fields) matches the existing pattern used for code-server readiness (#586 push + heartbeat).

## Key references

- `packages/control-plane/src/services/worker-scaler.ts` — current home of `computeProjectName`, `enumerateWorkers`, `WorkerReplica`.
- `packages/orchestrator/src/services/relay-bridge.ts:608–620` — the `readClusterYaml()` site that this change supersedes for the `workers` field.
- `packages/orchestrator/src/types/relay.ts` — `RelayBridgeOptions` (gains `engineClient`) and `ClusterMetadataPayload` (already has `workers?: number`; no shape change).
- Docker Engine API `/events` reference: https://docs.docker.com/engine/api/v1.41/#tag/System/operation/SystemEvents
- Companion issues:
  - [#706](https://github.com/generacy-ai/generacy/issues/706) — added `DockerEngineClient` and `enumerateWorkers`.
  - [generacy-cloud#694](https://github.com/generacy-ai/generacy-cloud/issues/694) — template-default side of the same UX bug.
