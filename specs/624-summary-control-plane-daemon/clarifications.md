# Clarifications for #624: Control-plane daemon crash resilience

## Batch 1 — 2026-05-15

### Q1: Socket-wait implementation location
**Context**: FR-003 requires "Orchestrator entrypoint exits non-zero when control-plane socket doesn't appear within timeout." However, the assumptions state the orchestrator entrypoint script lives in the cluster-base image repo (out of scope). The orchestrator's `server.ts` currently has no socket-wait logic — it just registers relay routes assuming the socket exists. This creates ambiguity about what code changes in THIS repo implement FR-003.
**Question**: Where should the in-repo socket-wait logic for FR-003 live?
**Options**:
- A: Add a startup probe in `server.ts` that waits for the control-plane socket and calls `process.exit(1)` if it never appears
- B: Add a `probeControlPlaneSocket()` health-check helper (similar to existing `probeCodeServerSocket()`) and surface unavailability through the `/health` endpoint and relay metadata — let the cluster-base entrypoint script handle the actual exit
- C: Both A and B — socket-wait with exit in `server.ts` AND ongoing health/metadata reflection

**Answer**: C — Both. The probe + health/metadata reflection (B) is independently valuable for cloud UI diagnostics. The exit in `server.ts` (A) provides fail-fast behavior preventing the zombie state. They compose: probe detects the missing socket, metadata surfaces failure for diagnostic UX, exit resolves after a bounded grace window. The cluster-base entrypoint script propagates the non-zero exit to `docker compose`.

### Q2: Orchestrator behavior on missing control-plane socket
**Context**: If the orchestrator's Node.js process exits when the control-plane socket is missing, the entire container restarts and the cluster goes offline in cloud UI. Alternatively, the orchestrator could stay running, push `error` status via relay, and keep the relay connection alive for diagnostic access (logs, status). The issue body says "Exit non-zero so docker compose reports failed" but the assumptions also say "orchestrator's own health/readiness logic should also reflect control-plane availability."
**Question**: When the orchestrator detects the control-plane socket is unavailable at startup, should it exit the process or stay running and report degraded/error status?
**Options**:
- A: Exit the process (`process.exit(1)`) — container restarts, cloud sees cluster offline
- B: Stay running, push `error` status via relay — cloud sees cluster as error, diagnostic access preserved
- C: Time-bounded: stay running for N seconds to push error status via relay, then exit

**Answer**: C — Time-bounded (~30s). Stay running after detecting the socket failure to push an `error` status (with reason `'control-plane socket did not bind within Xs'`) via the relay so the cloud UI displays `error` (not `offline`), then `process.exit(1)`. The 30s matches typical healthcheck `start_period`. This is "fail loudly, then fail eventually" — cloud gets a clear error status with reason, container then exits so docker-compose restart policy or operator sees unhealthy state.

### Q3: Fallback failure escalation
**Context**: FR-001 specifies falling back to `/tmp/generacy-app-config/` when the preferred path is EACCES. In rare cases (e.g., restrictive container runtime, read-only `/tmp/`), the fallback path could also fail. The spec doesn't define what happens in this double-failure scenario.
**Question**: If both the preferred path AND the `/tmp/` fallback are unwritable for non-critical stores (AppConfigEnvStore, AppConfigFileStore), should this escalate to a fatal error or should the store be initialized in a disabled/no-op mode?
**Options**:
- A: Escalate to fatal — if even tmpfs fallback fails, something is fundamentally wrong, exit the daemon
- B: Disabled/no-op mode — store methods return empty/default values, writes are silently dropped, with a clear warning log
- C: Escalate to fatal only if both stores fail; if at least one initializes, continue

**Answer**: B — Disabled/no-op mode. The rest of the daemon (credential resolve/mint, lifecycle endpoints, workflow sessions) can still function. Constraints: disabled state surfaced via init-result and relay metadata. GET endpoints return normal empty shape (`{ env: [], files: [] }`). PUT/POST endpoints return `503 Service Unavailable` with `{ error: 'app-config-store-disabled', reason: '...' }` — never silently appear to succeed.

### Q4: Init result surface area (FR-005)
**Context**: FR-005 requires a "structured init result showing which stores initialized successfully and which fell back." This could be just structured log output (JSON lines on stderr), or it could also be exposed programmatically via the daemon's health/status endpoint or relay metadata. The spec says it "aids debugging without requiring container shell access," which implies it should be accessible remotely.
**Question**: Should the init result be exposed only as structured log output, or also through a programmatic endpoint?
**Options**:
- A: Structured log output only (JSON lines) — operators read via `docker logs` or cloud log aggregation
- B: Log output AND a `/health` or `/status` endpoint field on the control-plane socket listing store statuses
- C: Log output AND relay metadata field — cloud UI can display init status without hitting the control-plane socket

**Answer**: C — Log + relay metadata. Relay metadata piggybacks on existing handshake/heartbeat push — single source of truth, no extra round-trip. Proposed shape: extend `ClusterMetadata` with `initResult: { stores: { appConfigEnv: 'ok' | 'fallback' | 'disabled'; appConfigFile: 'ok' | 'fallback' | 'disabled'; }, warnings: string[] }`. `/health` endpoint can mirror later if useful.
