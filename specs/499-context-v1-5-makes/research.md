# Research: Credential Audit Log

**Feature**: #499 — Audit log writer in credhelper-daemon
**Date**: 2026-04-29

## Technology Decisions

### Ring Buffer Implementation

**Decision**: Custom TypeScript ring buffer using a pre-allocated `Array<T | undefined>` with head/tail indices.

**Rationale**:
- No external dependency needed for a simple circular buffer
- Pre-allocated array avoids GC pressure from frequent push/shift on a standard array
- `Array.shift()` is O(n) — unacceptable at 5000 capacity under sustained load
- A ring buffer gives O(1) push and O(1) drain (bulk slice)

**Alternatives considered**:
- **Standard Array with shift()**: O(n) on each drop, unacceptable at scale
- **Linked list**: Higher memory overhead per node, worse cache locality
- **npm `ring-buffer` packages**: Adds external dependency for ~40 lines of code

### Transport Protocol

**Decision**: HTTP POST to control-plane Unix socket (`POST /internal/audit-batch`).

**Rationale** (per clarification Q1):
- Control-plane already runs in orchestrator container with relay access
- Reuses existing Unix socket HTTP pattern (same as credhelper's own control socket)
- Avoids giving daemon its own WebSocket connection (option C — duplicates infrastructure)
- Avoids polling latency (option A — orchestrator polls daemon)

**Wire format**: JSON body with `AuditBatch` schema:
```json
{
  "entries": [AuditEntry, ...],
  "droppedSinceLastBatch": 0
}
```

### Sampling Strategy

**Decision**: Deterministic counter-based sampling (every Nth request) rather than random.

**Rationale**:
- Predictable behavior in tests (counter resets are deterministic)
- No `Math.random()` overhead in hot path
- Simple to override via `recordAllProxy: true` (set counter divisor to 1)
- 1/100 default means ~10 entries per 1000 proxy requests — manageable volume

### Actor Identity

**Decision** (per clarification Q2): Environment variables injected by orchestrator.

- `GENERACY_CLUSTER_ID`: Read from `/var/lib/generacy/cluster.json` by orchestrator, passed to daemon at spawn
- `GENERACY_WORKER_ID`: Set to `$HOSTNAME` per existing `AGENT_ID` convention

Added as optional fields on `DaemonConfig`. Daemon stamps both on every audit entry.

### Audit Field Length Assertion

**Decision**: Dev-mode assertion (checks `NODE_ENV !== 'production'` or `CREDHELPER_AUDIT_ASSERT=1`) that fails tests if any string field in an audit entry exceeds 256 characters.

**Rationale**:
- Defense against accidentally logging credential values (tokens are typically >256 chars)
- Assertion runs in tests and dev mode only — no production perf impact
- Catches issues at development time, not in production

## Implementation Patterns

### Callback-based audit hooks (not plugin modification)

The SessionManager already wraps plugin `mint()` and `resolve()` calls. Audit recording happens at the call site in SessionManager, not inside plugins:

```typescript
// In SessionManager.beginSession():
try {
  const result = await plugin.mint(ctx);
  this.auditLog.record({ action: 'credential.mint', credentialId, pluginId: plugin.type, success: true });
  return result;
} catch (err) {
  this.auditLog.record({ action: 'credential.mint', credentialId, pluginId: plugin.type, success: false, errorCode: err.code });
  throw err;
}
```

This avoids modifying the `CredentialTypePlugin` interface or any of the 7 core plugins.

### Flush lifecycle

```
record() → ring buffer push → check batch size
                                  ├─ >= 50 → immediate flush
                                  └─ < 50 → timer fires at 1s → flush
flush() → drain buffer → HTTP POST → reset dropped counter
                            └─ on error → entries stay in buffer (bounded by capacity)
```

### Control-plane audit route

New route `POST /internal/audit-batch` on the control-plane. The `/internal/` prefix distinguishes intra-cluster endpoints from cloud-proxied routes. The handler:
1. Reads JSON body
2. Validates with Zod `AuditBatchSchema`
3. Emits each entry via relay's `pushEvent('cluster.audit', entry)`
4. Returns 200 OK

The control-plane needs a reference to the relay's `pushEvent` — this is injected at server construction time from the orchestrator, which owns both the relay and control-plane instances.

### Docker proxy sampling

The `DockerProxyHandler` already has an `onRequest` callback pattern. Add a counter that increments per request; when `counter % 100 === 0` (or `recordAllProxy` is true), record audit entry.

## Key Sources

- Spec: `specs/499-context-v1-5-makes/spec.md`
- Clarifications: `specs/499-context-v1-5-makes/clarifications.md`
- Architecture: `docs/credentials-architecture-plan.md` (upstream, open question #4)
- Control-plane: `packages/control-plane/src/router.ts` (route registration pattern)
- Relay events: `packages/cluster-relay/src/relay.ts` (`pushEvent` API)
- SessionManager: `packages/credhelper-daemon/src/session-manager.ts` (hook points)
- RoleConfig: `packages/credhelper/src/schemas/roles.ts` (schema extension point)
