# Clarifications: Audit Log Writer in credhelper-daemon

## Batch 1 — 2026-04-29

### Q1: Relay Transport from Daemon
**Context**: The spec says audit entries are emitted on the relay's `cluster.audit` event channel, and the relay client batches them. However, the relay (`ClusterRelay.pushEvent()`) lives in the orchestrator process, while the credhelper-daemon is a separate process communicating only via HTTP-over-Unix-socket. There is no relay client in credhelper-daemon.
**Question**: How should the credhelper-daemon deliver audit entries to the relay? Should it (A) expose a new HTTP endpoint on its control socket that the orchestrator polls/subscribes to, (B) make HTTP POST calls to the orchestrator/control-plane to forward entries, or (C) instantiate its own relay WebSocket client?
**Options**:
- A: New credhelper endpoint that orchestrator polls (e.g., `GET /audit/drain`)
- B: Credhelper pushes to orchestrator/control-plane via HTTP POST
- C: Credhelper gets its own relay WebSocket connection

**Answer**: *Pending*

### Q2: Cluster ID and Worker ID Injection
**Context**: The spec requires each entry to be stamped with `{actor: {workerId, sessionId?}, cluster_id}`. However, the credhelper-daemon currently has no access to either value — its `DaemonConfig` contains only socket paths, UIDs, and sweep intervals. `cluster_id` is stored in `cluster.json` (orchestrator activation), and there is no "workerId" concept in the daemon layer at all.
**Question**: Should `GENERACY_CLUSTER_ID` and `GENERACY_WORKER_ID` be injected as environment variables from the orchestrator when spawning the daemon, and what does "workerId" represent — the orchestrator instance, the UID (1000/1002), or something else?
**Options**:
- A: Env vars injected by orchestrator (`GENERACY_CLUSTER_ID`, `GENERACY_WORKER_ID` = orchestrator instance ID)
- B: Daemon reads `cluster.json` directly for cluster_id; workerId = daemon process identity
- C: Passed via daemon config file (`.agency/` config)

**Answer**: *Pending*

### Q3: Localhost Proxy Audit Hooks
**Context**: The spec says audit entries should be emitted from the localhost proxy "per allowed/denied request, sampled 1/100." However, the localhost proxy runtime is external to credhelper-daemon — the daemon only writes a `proxy/config.json` file during exposure rendering. The actual request handling happens outside the daemon process.
**Question**: Where should localhost proxy audit hooks be placed? Should they (A) only log at proxy config creation time in the daemon, (B) be implemented in the external proxy process with a callback to the daemon, or (C) be deferred to a follow-up issue?
**Options**:
- A: Audit only proxy setup/teardown in daemon (not per-request)
- B: External proxy calls back to daemon's control socket per-request (new endpoint)
- C: Defer per-request localhost proxy auditing to follow-up

**Answer**: *Pending*

### Q4: Role Config Schema Extension for Full Audit
**Context**: The spec says a "role config flag" can override default 1/100 sampling to "record all" proxy requests. The current `RoleConfig` schema (in `packages/credhelper/src/schemas/roles.ts`) has no audit-related fields. Adding one requires a schema change in the shared `credhelper` types package.
**Question**: What should the role config field look like? Should it be a simple boolean (`audit: { recordAllProxy: true }`) or a more granular structure (per-proxy-upstream sampling rates)?
**Options**:
- A: Simple boolean — `audit?: { recordAllProxy?: boolean }` on RoleConfig
- B: Granular — `audit?: { dockerSampling?: number; localhostSampling?: number }` with 1.0 = record all
- C: Per-credential flag — each `RoleCredentialRef` gets an `auditAll?: boolean`

**Answer**: *Pending*

### Q5: Dropped Count Emission Timing
**Context**: The spec says `dropped_count` is "exposed and emitted as a special audit event when non-zero." It's unclear when this special event fires — should it be emitted (A) once when the first drop occurs, (B) periodically while drops are happening, or (C) piggy-backed onto each batch emission? Also, should the counter reset after emission or be cumulative?
**Question**: When should the `dropped_count` event be emitted, and should the counter reset after each emission or accumulate for the daemon's lifetime?
**Options**:
- A: Emitted with each batch that had drops; counter resets after emission
- B: Periodic heartbeat (e.g., every 30s) when non-zero; counter is cumulative
- C: Piggy-backed as a field on every batch payload; counter resets per-batch

**Answer**: *Pending*
