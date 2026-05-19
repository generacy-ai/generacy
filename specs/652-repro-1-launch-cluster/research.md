# Research: Post-Activation Retry on Cluster Restart

## Technology Decisions

### 1. State Persistence: File Flag vs JSON State File

**Decision**: Simple file flag at `/var/lib/generacy/post-activation-complete`

**Rationale**: The completion state is a single boolean — "did post-activation succeed?" A `touch`-created empty file is the simplest possible signal, readable from both shell (cluster-base's `test -f`) and TypeScript (`existsSync()`). No parsing, no versioning, no corruption risk.

**Alternative considered**: JSON state file with timestamp, script version, exit code. Rejected because:
- Adds parsing complexity for no gain — the only consumer question is "should I retry?"
- The post-activation script is bash; JSON writing from shell is fragile
- Version/timestamp metadata has no current consumer

**Convention**: Matches existing patterns — `/var/lib/generacy/cluster-api-key` (plain file), `/var/lib/generacy/cluster.json` (JSON for structured data). A boolean flag maps to plain file.

### 2. Retry Mechanism: Lifecycle Replay vs Direct Trigger

**Decision**: Replay full `bootstrap-complete` lifecycle action (Q2: Option A)

**Rationale**: The `bootstrap-complete` handler in `control-plane/src/routes/lifecycle.ts` already:
1. Calls `writeWizardEnvFile()` to unseal credentials
2. Writes `/tmp/generacy-bootstrap-complete` sentinel
3. Starts code-server (fire-and-forget)
4. Starts VS Code tunnel

All four steps are needed on retry. Replaying the lifecycle action reuses this exact code path. The alternative (touch sentinel directly) would skip credential re-unsealing — broken if the user updated credentials between failure and restart.

### 3. HTTP Call to Control-Plane Socket

**Pattern**: Native `node:http` request to Unix socket, same as `StatusReporter`

The orchestrator already makes HTTP requests to the control-plane socket in multiple places:
- `StatusReporter.pushStatus()` — `POST /internal/status`
- `probeControlPlaneSocket()` — TCP connect probe

The retry service follows the same pattern: `http.request({ socketPath, path: '/lifecycle/bootstrap-complete', method: 'POST' })`.

### 4. Actor Context for Internal Requests

The lifecycle handler calls `requireActor(actor)`, which reads `x-generacy-actor-user-id` and `x-generacy-actor-session-id` headers. Internal requests need to provide these.

**Decision**: Use synthetic internal actor headers: `x-generacy-actor-user-id: system`, `x-generacy-actor-session-id: post-activation-retry`. This matches the pattern used by relay-forwarded requests (relay injects these headers from the authenticated session).

### 5. Error Propagation: Both Status + Relay Event (Q5)

**Status transition**: `degraded` (not `error`) because the cluster is functional — it just hasn't completed post-activation. The user can fix and restart. Terminal `error` would be wrong since recovery is possible.

**Relay event channel**: `cluster.bootstrap` — existing channel already used for bootstrap-related events (peer repo cloning status, credential unseal warnings).

## Implementation Patterns

### Existing Pattern: `probeControlPlaneSocket()`

```typescript
// packages/orchestrator/src/services/control-plane-probe.ts
export async function probeControlPlaneSocket(
  socketPath?: string,
  timeoutMs?: number,
): Promise<boolean>
```

TCP connect probe, 500ms default timeout. Used in `startServer()` to wait for control-plane readiness. The retry service will use this same function to gate the retry call.

### Existing Pattern: `StatusReporter`

```typescript
// packages/orchestrator/src/services/status-reporter.ts
const statusReporter = new StatusReporter({ socketPath: controlPlaneSocket });
await statusReporter.pushStatus('degraded', 'post-activation failed: ...');
```

Fire-and-forget HTTP POST to control-plane. Swallows errors. Used in relay-bridge initialization. The retry service will use the same class.

### Existing Pattern: Relay Event IPC

```typescript
// From control-plane → orchestrator via HTTP
POST /internal/relay-events
{ channel: 'cluster.bootstrap', payload: { ... } }
```

The control-plane already emits relay events via this IPC endpoint (#594/#598). For the retry failure case, the orchestrator can emit directly via relay bridge (it has the client ref), or via the same IPC route.

## Key Source Files

| File | Role |
|------|------|
| `packages/orchestrator/src/server.ts:337-354` | Wizard-mode vs sync activation branch |
| `packages/orchestrator/src/server.ts:630-672` | `activateInBackground()` — where retry trigger should go |
| `packages/orchestrator/src/activation/index.ts:30-57` | Existing key detection (line 46: `if (existingKey)`) |
| `packages/control-plane/src/routes/lifecycle.ts:99-137` | `bootstrap-complete` handler |
| `packages/orchestrator/src/services/status-reporter.ts` | StatusReporter pattern |
| `packages/orchestrator/src/services/control-plane-probe.ts` | Socket probe pattern |
| `packages/orchestrator/src/routes/internal-relay-events.ts` | Relay event IPC route |
