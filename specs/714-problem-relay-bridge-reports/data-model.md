# Data Model

This feature changes one wire field's meaning (`metadata.workers` becomes actual-not-declared) and threads a `DockerEngineClient` through one constructor. There is no persistent data model change.

## Wire-format change

### `ClusterMetadataPayload.workers` (semantics-only change)

**File**: `packages/orchestrator/src/types/relay.ts`

**Before**: declared count from merged `cluster.yaml` / `cluster.local.yaml`. Always present when the YAML is readable, regardless of what's actually running.

**After**: count of worker containers with `state === 'running'` enumerated from the Docker Engine API for the orchestrator's compose project. Omitted (undefined) when the Engine API or project-name lookup fails. The TypeScript type stays `workers?: number` — only the meaning changes.

```ts
export interface ClusterMetadataPayload {
  // … unchanged fields …

  /**
   * Count of worker containers currently running for this compose project.
   * Enumerated from the Docker Engine API on every metadata send.
   * Omitted when the Engine API is unreachable, the orchestrator is not
   * compose-managed, or project-name resolution fails.
   */
  workers?: number;

  // … unchanged fields …
}
```

The cloud-side mapping (`regUpdate.workers = { total: m.workers, busy: 0, idle: m.workers }`) is unchanged.

## Type changes

### New: `EngineEvent`

**File**: `packages/control-plane/src/services/docker-engine-types.ts`

Minimal narrowing of the Docker Engine `/events` JSON line shape — only the fields we read.

```ts
export interface EngineEvent {
  Type: 'container';
  Action: string;          // 'die' | 'start' | 'destroy' | 'create' | ... (we filter client-side)
  id?: string;             // container ID for container events
  Actor?: {
    ID?: string;
    Attributes?: Record<string, string>;
  };
  time?: number;           // unix seconds
  timeNano?: number;
}
```

### New: `StreamContainerEventsOptions`

**File**: `packages/control-plane/src/services/docker-engine-client.ts`

```ts
export interface StreamContainerEventsOptions {
  filters: {
    label?: string[];
    type?: ('container' | 'image' | 'network' | 'volume' | 'service' | 'node' | 'secret' | 'config')[];
  };
  /** Abort the stream. The async iterator returns on abort. */
  signal?: AbortSignal;
}
```

### New method: `DockerEngineClient.streamContainerEvents`

```ts
streamContainerEvents(
  opts: StreamContainerEventsOptions,
): AsyncIterable<EngineEvent>;
```

**Behavior**:
- Opens `GET /events?filters=<urlencoded JSON>` on the configured socket.
- Parses newline-delimited JSON; each line yielded as one `EngineEvent` (skips lines that fail to parse, with a single console.warn).
- Resolves the iterator when the response stream ends or `opts.signal` aborts.
- Throws `DockerDaemonUnavailableError` if the initial connection is refused or the socket file is missing — caller is responsible for backoff/retry.

**Non-goals**:
- No built-in reconnect. The caller (`RelayBridge`) implements the reconnect/backoff loop because it owns the lifecycle and the `sendMetadata()` trigger.
- No `since` / `until` cursor support. We don't need event replay; missing an event during a reconnect window is fine because the next heartbeat (≤60s) reconciles.

## Existing types — extracted, not changed

### `WorkerReplica`

**Moves from**: `packages/control-plane/src/services/worker-scaler.ts`
**Moves to**: `packages/control-plane/src/services/worker-enumeration.ts`
**Re-exported from**: `packages/control-plane/src/index.ts`

Definition unchanged:

```ts
export interface WorkerReplica {
  id: string;
  number: number;
  name: string;
  state: ContainerState;
  networkIds: string[];
}
```

### `computeProjectName(client: DockerEngineClient): Promise<string>`

Moves to `worker-enumeration.ts`. Behavior preserved verbatim:
- Inspects `os.hostname()` against the Docker daemon.
- Reads `com.docker.compose.project` label.
- Falls back to `COMPOSE_PROJECT_NAME` env var.
- Throws `Error('ORCHESTRATOR_NOT_COMPOSE_MANAGED')` if neither resolves.

### `enumerateWorkers(client, project): Promise<WorkerReplica[]>`

Moves to `worker-enumeration.ts`. Behavior preserved verbatim:
- `listContainers({ all: true, filters: { label: [project, service=worker] } })`.
- Skips replicas with missing/invalid `com.docker.compose.container-number` label.
- Returns array of `WorkerReplica`.

## Constructor option change

### `RelayBridgeOptions.engineClient` (new, required)

**File**: `packages/orchestrator/src/types/relay.ts`

```ts
export interface RelayBridgeOptions {
  client: ClusterRelayClient;
  server: FastifyInstance;
  sseManager: SSESubscriptionManager;
  logger: Logger;
  config: RelayConfig;

  /**
   * Docker Engine client for enumerating worker containers and subscribing
   * to container lifecycle events. Constructed once at boot in server.ts and
   * shared across all RelayBridge calls.
   */
  engineClient: DockerEngineClient;
}
```

**Validation rules**:
- No runtime validation needed — TypeScript ensures the field is set.
- The orchestrator's `initializeRelayBridge()` constructs the client with default options (`new DockerEngineClient()`) so it picks up `DOCKER_HOST` from env or falls back to `/var/run/docker-host.sock`.

## Internal RelayBridge state additions

```ts
class RelayBridge {
  // … existing fields …

  private readonly engineClient: DockerEngineClient;
  private workerEventAbort: AbortController | null = null;
  private workerEventReconnectTimer: NodeJS.Timeout | null = null;
  private workerEventBackoffMs: number = 5_000;
  private cachedProjectName: string | null = null;
}
```

`cachedProjectName` is a per-boot cache for `computeProjectName()` since the value never changes for the life of the orchestrator container. The cache is invalidated only by process restart.

## Relationships

```
DockerEngineClient (one per orchestrator process)
   │
   ├── injected into → RelayBridge (engineClient)
   │       ├─ collectMetadata() ── one-shot ── listContainers + filter
   │       └─ start()              ── long-lived ── streamContainerEvents
   │             └─ on event → sendMetadata()
   │
   └── injected into → WorkerScaler (existing; unchanged behavior)
            └─ enumerateWorkers / inspectContainer / etc.
```

No new database or persistent file; no migrations.
