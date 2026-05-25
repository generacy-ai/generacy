# Research: Worker Scale Lifecycle Action

## Technology Decisions

### 1. Docker Compose CLI vs Docker Engine API

**Decision**: Use `docker compose` CLI via `child_process.spawn`

**Rationale**:
- The scaffolder generates a standard `docker-compose.yml` with `replicas: '${WORKER_COUNT:-1}'`
- `docker compose up -d --scale worker=<n>` is the canonical way to change replica count
- The compose file's top-level `name:` field (scaffolder.ts:175) ensures correct project resolution without needing `-p` or `COMPOSE_PROJECT_NAME`
- Pattern matches how the CLI lifecycle commands already interact with compose

**Alternative rejected**: Docker Engine API (HTTP over unix socket)
- Would require reimplementing compose's service discovery, network attachment, volume mounting
- Service update API (`POST /services/{id}/update`) is for Swarm mode, not compose
- Creating individual containers via Engine API would bypass compose's declarative model

### 2. Metadata Refresh Strategy

**Decision**: New `POST /internal/refresh-metadata` endpoint on orchestrator, called from control-plane handler

**Rationale** (from clarification Q1):
- No new relay channel needed (avoids cloud-side listener work)
- Relay-bridge already sends metadata via WebSocket; cloud already maps `metadata.workers` to Firestore
- Only gap was the 60s periodic refresh latency — solved by an on-demand trigger
- Reuses existing IPC pattern: HTTP POST gated by `ORCHESTRATOR_INTERNAL_API_KEY` (same as `/internal/relay-events` from #594)

**Alternatives rejected**:
- A: New `cluster.status` relay channel — requires cloud-side listener, overkill for this
- B: Existing `cluster.bootstrap` channel — semantically wrong, fragile
- C: Rely on periodic refresh only — 60s latency violates <10s requirement

### 3. File Persistence Strategy

**Decision**: Update both `.env` (for compose) and `cluster.yaml` (for metadata/config) atomically

**Rationale**:
- `.env` file is what `docker compose` reads for variable substitution (`WORKER_COUNT`)
- `cluster.yaml` is the source of truth for cluster config (read by relay-bridge metadata)
- Both must reflect the same count to avoid drift
- Use atomic write pattern (write to temp, fsync, rename) to prevent corruption

### 4. Worker Count Validation

**Decision**: Validate `count >= 1` only; no upper bound

**Rationale** (from spec):
- Upper bound is a tier limit enforced by `generacy-cloud` before the request hits the cluster
- The cluster shouldn't second-guess cloud-side business logic
- Simpler validation, fewer failure modes
- If cloud ever adjusts tier limits, no cluster-side deploy needed

### 5. Error Handling for Missing Docker CLI

**Decision**: Return clear error response; don't crash the handler

**Rationale**:
- Docker CLI availability depends on companion cluster-base PR
- During transition period, existing clusters may not have it
- Handler should return `{ error: 'DOCKER_CLI_UNAVAILABLE', code: 400, details }` so cloud can show meaningful error
- Non-fatal: other lifecycle actions continue to work

## Implementation Patterns

### Existing Pattern: Lifecycle Handler

From `lifecycle.ts`, each action follows:
```typescript
if (action === 'some-action') {
  // 1. Parse/validate body
  // 2. Perform action (write file, spawn process, etc.)
  // 3. Emit relay event (optional, via setRelayPushEvent)
  // 4. Return JSON response
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ accepted: true, action, ...extraFields }));
  return;
}
```

### Existing Pattern: Internal IPC (from #594)

Control-plane → Orchestrator communication:
```typescript
// In control-plane handler:
const orchestratorUrl = process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100';
const internalApiKey = process.env['ORCHESTRATOR_INTERNAL_API_KEY'];
await fetch(`${orchestratorUrl}/internal/refresh-metadata`, {
  method: 'POST',
  headers: { 'authorization': `Bearer ${internalApiKey}` },
});
```

### Existing Pattern: Deferred Route Binding (from #598)

Routes registered before `server.listen()` with getter for late-bound dependencies:
```typescript
// In server.ts (before listen):
setupInternalRefreshMetadataRoute(server, () => relayBridgeRef);
// In initializeRelayBridge (after activation):
relayBridgeRef = relayBridge;
```

## Key Sources

- Control-plane lifecycle handler: `packages/control-plane/src/routes/lifecycle.ts:13-179`
- Relay-bridge metadata: `packages/orchestrator/src/services/relay-bridge.ts:507-556, 608-623`
- Project dir resolver: `packages/control-plane/src/services/project-dir-resolver.ts`
- Scaffolder compose output: `packages/generacy/src/cli/commands/cluster/scaffolder.ts:117-267`
- Internal relay-events IPC: `packages/orchestrator/src/routes/internal-relay-events.ts`
- Deferred binding pattern: `packages/orchestrator/src/server.ts:333` (relay-events route setup)
