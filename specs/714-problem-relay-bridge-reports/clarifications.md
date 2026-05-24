# Clarifications

## Batch 1 — 2026-05-24

### Q1: Engine client provisioning
**Context**: FR-005 states "The relay-bridge's existing `engineClient` instance (already used by other metadata paths) is reused." However, `RelayBridge` does not currently hold a `DockerEngineClient` — `RelayBridgeOptions` exposes only `client`, `server`, `sseManager`, `logger`, `config`, and `collectMetadata()` doesn't call the Engine API today. This must be resolved before implementation can start because it determines how the orchestrator process gets a working Docker socket connection (and whether one client is shared across other future Engine-using paths).
**Question**: How should `RelayBridge.collectMetadata()` obtain a `DockerEngineClient` to call `enumerateWorkers`?
**Options**:
- A: Add an `engineClient: DockerEngineClient` field to `RelayBridgeOptions`; the orchestrator constructs a single client at boot (in `server.ts`) and injects it. `RelayBridge` reuses it across calls.
- B: `RelayBridge` lazily constructs its own `DockerEngineClient` on first `collectMetadata()` call and caches it as a private field for subsequent calls.
- C: Have `RelayBridge` call control-plane over its existing Unix socket (e.g. a new `GET /workers` endpoint) so the orchestrator never opens the Docker socket itself.

**Answer**: **A — inject `DockerEngineClient` via `RelayBridgeOptions`.** Orchestrator constructs one client at boot in `server.ts` and injects it. Single shared instance across future Engine-using paths (per-worker liveness, container-event subscription per Q3, etc.) — no risk of multiple clients fighting over the same socket. Easier to test (mock client passes through options). B hides a server-wide resource lifecycle inside a single consumer; C adds a network hop and serialization boundary for data already on a Unix socket the orchestrator can reach directly.

---

### Q2: Location of `enumerateWorkers` and `computeProjectName`
**Context**: FR-004 explicitly offers two options: "Either move helpers into the engine-client package or re-export from a shared location." Today both functions live in `packages/control-plane/src/services/worker-scaler.ts`. Orchestrator already declares `@generacy-ai/control-plane` as a workspace dependency (used for the `probeControlPlaneSocket` helper module path, not the package proper). Picking the wrong layout could create a circular package dependency or pull a large surface into orchestrator unnecessarily.
**Question**: Where should `enumerateWorkers` and `computeProjectName` live so `relay-bridge.ts` can import them without circular deps?
**Options**:
- A: Move both helpers (and any types they need such as `WorkerReplica`) into a new file inside `@generacy-ai/control-plane` that is exported from the package's public entry, then import from `@generacy-ai/control-plane` in orchestrator.
- B: Extract a small new shared package (e.g. `@generacy-ai/docker-engine` or move into an existing types-only package) holding `DockerEngineClient`, `enumerateWorkers`, `computeProjectName`, and shared types; both control-plane and orchestrator depend on it.
- C: Leave the helpers in control-plane but re-export them from a leaf-style submodule path (e.g. `@generacy-ai/control-plane/worker-enumeration`) that has no transitive coupling back to orchestrator-only code.

**Answer**: **A — move helpers into `@generacy-ai/control-plane`'s public exports.** Orchestrator already depends on the package; adding exports is the smallest change with zero new workspace plumbing. The helpers don't depend on anything orchestrator-specific, so no circular-dep risk. B is premature extraction — two consumers don't justify a new workspace package and its build/version/release overhead. C solves a coupling problem that doesn't exist. Practical move: lift them from `packages/control-plane/src/services/worker-scaler.ts` into a new `packages/control-plane/src/services/worker-enumeration.ts`, keep worker-scaler importing from there, and add the named exports to `packages/control-plane/src/index.ts`.

---

### Q3: Responsiveness target vs. heartbeat interval
**Context**: SC-002 and US1's second acceptance bullet both promise the tile drops within ~10s of `docker stop <worker>`. The orchestrator's `metadataIntervalMs` defaults to 60000 (60s), and `worker-scaler.ts` is the only producer that calls `POST /internal/refresh-metadata` to force an immediate push. A manual `docker stop` (no scaler involvement) currently has no path to trigger a refresh, so the worst-case latency is one full heartbeat (~60s), not 10s.
**Question**: How should the implementation meet the ~10s responsiveness target for manual / out-of-band worker container exits?
**Options**:
- A: Lower `metadataIntervalMs` default to ~10s when the field is included (or add a separate `workerMetadataIntervalMs`). Accepts more relay chatter.
- B: Subscribe to Docker Engine events (`/events?filters=...service=worker`) in `RelayBridge` (or control-plane) and call `sendMetadata()` on `die`/`start`/`destroy` events. Keeps heartbeat at 60s but reacts immediately.
- C: Relax the success criterion — accept up to ~60s latency for non-scaler-driven changes, and update SC-002 / US1's acceptance bullets to match.

**Answer**: **B — subscribe to Docker Engine events; fire `sendMetadata()` on container lifecycle events.** The 10s SLA was deliberate; relaxing it (C) gives up responsiveness without a real cost saving. A (drop interval to 10s) does 6× more relay chatter for the whole metadata payload — worker counts change rarely; the rest of the payload almost never changes between calls. Subscribe once at boot to `GET /events?filters={"label":["com.docker.compose.project=<name>","com.docker.compose.service=worker"],"type":["container"]}`; fire `sendMetadata()` on `die`/`start`/`destroy`/`create`. Keep the 60s heartbeat for the rest. Engine API events is a long-lived HTTP stream — needs reconnection on close/error; reuse RelayBridge's WebSocket reconnect pattern. Also a foundation for future per-worker liveness tracking.

---

### Q4: Behavior when Engine API or project-name lookup fails
**Context**: FR-003 says: "On Engine API failure (Docker unreachable, network error, etc.), `metadata.workers` is omitted from the payload rather than set to a stale or zero value." `computeProjectName()` also throws `ORCHESTRATOR_NOT_COMPOSE_MANAGED` when the orchestrator is launched outside compose (dev mode, raw `docker run`, or local `pnpm dev`). In those environments today, `readClusterYaml()` still returns the declared value, so the cloud UI shows *something*. Strictly applying FR-003 would regress dev-mode users from "see declared value" to "see no value."
**Question**: When `computeProjectName()` or `enumerateWorkers()` fails (Engine unreachable, not-compose-managed, etc.), what should `metadata.workers` be?
**Options**:
- A: Omit the field entirely (current FR-003 wording). Cloud UI shows the tile's empty/unknown state until Engine API succeeds.
- B: Fall back to the declared YAML value (`readClusterYaml().workers`) — i.e. preserve today's behavior in failure cases only. Honest in the common case, degrades to declared-value behavior on failure.
- C: Distinguish the two failure modes: omit on transient Engine errors (per FR-003); fall back to declared YAML on `ORCHESTRATOR_NOT_COMPOSE_MANAGED` (dev mode only).

**Answer**: **A — omit `metadata.workers` on Engine API or project-name lookup failure.** Strict honesty. Cloud UI's tile already handles absence of `workers` (`cluster?.workers?.total ?? 1` and similar). Showing nothing when we don't know is more honest than alternatives. C is tempting but the YAML value in dev-mode is misleading — a developer running `pnpm dev` typically has zero worker containers but a `cluster.yaml` declaring 3; showing 3 is worse than showing nothing. B regresses to the bug this issue exists to fix during failure windows. A also gives cloud UI a clear signal for surfacing "cluster metadata unavailable" / stale-state badges later — with B/C, the UI can't distinguish honest-zero from we-don't-know.
