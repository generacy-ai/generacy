# Clarifications for #516: control-plane /state returns hardcoded values

## Batch 1 — 2026-04-30

### Q1: Status Update Mechanism
**Context**: The control-plane is a standalone HTTP server (`ControlPlaneServer`) running on a Unix socket, separate from the orchestrator and relay. The `deploymentMode` and `variant` fields are static (read from env vars at startup), but `status` is a runtime value that changes as the cluster progresses through its lifecycle (`bootstrapping → ready ↔ degraded → error`).
**Question**: How should the control-plane receive status updates? Should there be a new internal endpoint (e.g. `POST /internal/status`) that the orchestrator calls to push state transitions, or should the control-plane constructor accept a mutable state object/callback that the orchestrator updates directly?
**Options**:
- A: New `POST /internal/status` endpoint — orchestrator pushes status changes over the Unix socket (consistent with existing `POST /internal/audit-batch` pattern)
- B: Mutable shared state object — orchestrator passes a reference to the constructor and mutates it directly (simpler but couples packages)
- C: Status file — orchestrator writes state to a well-known file, control-plane reads on each request

**Answer**: A — New `POST /internal/status` endpoint, consistent with the existing `POST /internal/audit-batch` pattern from #499.** Body shape: `{ status: 'bootstrapping' | 'ready' | 'degraded' | 'error', statusReason?: string }`. Unix-socket-only (mode 0660, accessible to orchestrator uid 1000 via the `node` group, same as the audit-batch endpoint). The orchestrator pushes status transitions at activation completion, on relay connect/disconnect, and on fatal errors. The control-plane stores the latest in-memory state and serves it from `GET /state`. Mutable shared state via the constructor (option B) couples the packages and creates ordering hazards; status file (option C) adds a filesystem dependency for state that's purely runtime.

### Q2: Error State Recoverability
**Context**: The spec describes the state machine as `bootstrapping → ready ↔ degraded → error`. The arrow notation suggests `error` may be terminal (no arrow out), but in practice a relay reconnect after an extended outage might recover the cluster.
**Question**: Is the `error` state terminal (requires container restart to recover), or can it transition back to `ready`/`degraded` if conditions improve?
**Options**:
- A: Terminal — `error` means unrecoverable; only a restart can leave `error` state
- B: Recoverable — `error` can transition back to `degraded` or `ready` if the issue resolves
- C: Configurable — allow both behaviors based on the error type

**Answer**: A — `error` is terminal; only a restart can leave it.** Reserve `error` for truly unrecoverable conditions: fatal config error, master key file unreadable, schema migration needed. Recoverable conditions (relay disconnect, transient cloud unreachable) should set `degraded`, which can transition back to `ready` when the issue resolves. This keeps the state-machine semantics clear: `degraded` = recoverable / self-healing, `error` = needs operator intervention. Configurable-per-error-type (option C) is over-engineering for v1.5; the categorization is unambiguous in practice.

### Q3: Degradation/Error Reason Field
**Context**: When `status` is `degraded` or `error`, the cloud UI may need to display a reason to the user (e.g., "relay disconnected", "activation failed"). The current `ClusterState` schema only has `status`, `deploymentMode`, `variant`, and `lastSeen`.
**Question**: Should the `GET /state` response include an optional `statusReason` (or `message`) field explaining why the cluster is in a non-ready state?
**Options**:
- A: Yes — add optional `statusReason: string` to `ClusterState` schema
- B: No — status enum alone is sufficient; reasons are logged server-side only

**Answer**: A — Add optional `statusReason: string` to `ClusterState`.** Used by the cloud UI to display context (e.g., "Relay disconnected — retrying", "Master key file missing", "Activation pending"). Server-side logs continue to capture full detail; this field is the user-facing one-line summary. Keep it terse (recommend 200 char max). Always present when `status` is `degraded` or `error`; absent or empty for `bootstrapping`/`ready`.

### Q4: Initial Status on Startup
**Context**: The spec says status should be `bootstrapping` before activation completes and `ready` after relay handshake. The control-plane server starts independently of the orchestrator's activation flow.
**Question**: Should the control-plane always start with `status: 'bootstrapping'` and wait for the orchestrator to push it to `ready`, or should it start as `ready` if the activation key file already exists (i.e., cluster was previously activated)?
**Options**:
- A: Always start `bootstrapping` — orchestrator explicitly transitions to `ready` after confirming relay is connected
- B: Start `ready` if key file exists — only use `bootstrapping` on first boot (before activation)

**Answer**: A — Always start `bootstrapping`.** The orchestrator is the source of truth for status; the control-plane should reflect orchestrator state, not infer from filesystem state. Brief "bootstrapping" window (typically a few seconds at startup) is fine; users won't notice. Inferring from key file presence (option B) creates a footgun where filesystem state and orchestrator state can disagree (e.g., key file exists but relay handshake hasn't completed yet — should be `bootstrapping`, not `ready`). The orchestrator pushes `ready` via the new `/internal/status` endpoint after relay handshake confirms.
