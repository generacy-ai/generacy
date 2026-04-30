# Clarifications for #516: control-plane /state returns hardcoded values

## Batch 1 — 2026-04-30

### Q1: Status Update Mechanism
**Context**: The control-plane is a standalone HTTP server (`ControlPlaneServer`) running on a Unix socket, separate from the orchestrator and relay. The `deploymentMode` and `variant` fields are static (read from env vars at startup), but `status` is a runtime value that changes as the cluster progresses through its lifecycle (`bootstrapping → ready ↔ degraded → error`).
**Question**: How should the control-plane receive status updates? Should there be a new internal endpoint (e.g. `POST /internal/status`) that the orchestrator calls to push state transitions, or should the control-plane constructor accept a mutable state object/callback that the orchestrator updates directly?
**Options**:
- A: New `POST /internal/status` endpoint — orchestrator pushes status changes over the Unix socket (consistent with existing `POST /internal/audit-batch` pattern)
- B: Mutable shared state object — orchestrator passes a reference to the constructor and mutates it directly (simpler but couples packages)
- C: Status file — orchestrator writes state to a well-known file, control-plane reads on each request

**Answer**: *Pending*

### Q2: Error State Recoverability
**Context**: The spec describes the state machine as `bootstrapping → ready ↔ degraded → error`. The arrow notation suggests `error` may be terminal (no arrow out), but in practice a relay reconnect after an extended outage might recover the cluster.
**Question**: Is the `error` state terminal (requires container restart to recover), or can it transition back to `ready`/`degraded` if conditions improve?
**Options**:
- A: Terminal — `error` means unrecoverable; only a restart can leave `error` state
- B: Recoverable — `error` can transition back to `degraded` or `ready` if the issue resolves
- C: Configurable — allow both behaviors based on the error type

**Answer**: *Pending*

### Q3: Degradation/Error Reason Field
**Context**: When `status` is `degraded` or `error`, the cloud UI may need to display a reason to the user (e.g., "relay disconnected", "activation failed"). The current `ClusterState` schema only has `status`, `deploymentMode`, `variant`, and `lastSeen`.
**Question**: Should the `GET /state` response include an optional `statusReason` (or `message`) field explaining why the cluster is in a non-ready state?
**Options**:
- A: Yes — add optional `statusReason: string` to `ClusterState` schema
- B: No — status enum alone is sufficient; reasons are logged server-side only

**Answer**: *Pending*

### Q4: Initial Status on Startup
**Context**: The spec says status should be `bootstrapping` before activation completes and `ready` after relay handshake. The control-plane server starts independently of the orchestrator's activation flow.
**Question**: Should the control-plane always start with `status: 'bootstrapping'` and wait for the orchestrator to push it to `ready`, or should it start as `ready` if the activation key file already exists (i.e., cluster was previously activated)?
**Options**:
- A: Always start `bootstrapping` — orchestrator explicitly transitions to `ready` after confirming relay is connected
- B: Start `ready` if key file exists — only use `bootstrapping` on first boot (before activation)

**Answer**: *Pending*
