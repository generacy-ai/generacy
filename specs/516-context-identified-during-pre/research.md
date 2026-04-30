# Research: Dynamic /state Endpoint

## Technology Decisions

### 1. State Injection Pattern: Module-Level Setter

**Decision**: Use module-level `let` + exported setter function (e.g., `initClusterState()`, `updateClusterStatus()`)

**Rationale**: The control-plane already uses this pattern for `setRelayPushEvent()` in the audit route and `setCodeServerManager()` for the code-server lifecycle. Constructor injection would require changing the `ControlPlaneServer` API and all test setup code.

**Alternatives considered**:
- **Constructor injection**: Cleaner DI but breaks existing pattern; `ControlPlaneServer()` is intentionally parameterless
- **Shared mutable state object**: Couples orchestrator and control-plane packages at the type level
- **Status file on disk**: Adds filesystem dependency for pure runtime state; introduces read latency on every `GET /state`

### 2. Status Update Protocol: Internal HTTP Endpoint

**Decision**: `POST /internal/status` over Unix socket

**Rationale**: Consistent with `POST /internal/audit-batch` from #499. Decouples orchestrator from control-plane internals. Unix socket access (mode 0660) provides sufficient auth — only processes in the `node` group can write.

**Wire format**:
```json
{
  "status": "ready",
  "statusReason": "Relay connected"
}
```

### 3. Environment Variable Reading

**Decision**: Read `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` at startup in `bin/control-plane.ts`, pass to state initialization

**Rationale**: These values are static for the container's lifetime (set by entrypoint). Reading once at startup avoids per-request `process.env` access and keeps the values immutable.

**Defaults**:
- `DEPLOYMENT_MODE` → `'local'` (safe fallback for dev/local clusters)
- `CLUSTER_VARIANT` → `'cluster-base'` (most common variant)

### 4. Orchestrator Status Reporter

**Decision**: Thin HTTP client in `services/status-reporter.ts` using `node:http` over Unix socket

**Rationale**: Same pattern as `CredhelperHttpClient`. Fire-and-forget with error logging — status push failures should not crash the orchestrator. The control-plane socket path is known (`/run/generacy-control-plane/control.sock`) or configurable via env var.

## Implementation Patterns

### Module-Level State Store Pattern

```typescript
// State stored at module level
let state: ClusterState = { status: 'bootstrapping', ... };

// Exported setter for initialization
export function initClusterState(config: { deploymentMode: DeploymentMode; variant: ClusterVariant }): void { ... }

// Exported function for status updates
export function updateClusterStatus(status: ClusterStatus, statusReason?: string): void { ... }

// Exported getter for route handler
export function getClusterState(): ClusterState { ... }
```

### Status Reporter Pattern (Orchestrator Side)

```typescript
export class StatusReporter {
  constructor(private socketPath: string) {}

  async pushStatus(status: ClusterStatus, statusReason?: string): Promise<void> {
    // POST /internal/status over Unix socket
    // Fire-and-forget with error logging
  }
}
```

## Key Sources

- Existing `POST /internal/audit-batch`: `packages/control-plane/src/routes/audit.ts`
- `setRelayPushEvent()` pattern: same file, lines 10-15
- `setCodeServerManager()` pattern: `packages/control-plane/src/services/code-server-manager.ts`
- Relay lifecycle hooks: `packages/orchestrator/src/services/relay-bridge.ts` (handleConnected/handleDisconnected)
- Activation flow: `packages/orchestrator/src/server.ts` lines 305-322
- `CredhelperHttpClient` (Unix socket HTTP pattern): `packages/orchestrator/src/launcher/credhelper-client.ts`
