# Data Model: Worker Scaling via Docker Engine API

**Issue**: [#706](https://github.com/generacy-ai/generacy/issues/706)
**Branch**: `706-problem-worker-scaler-ts`

This document defines the TypeScript interfaces used by the rewritten `worker-scaler.ts` and the new `docker-engine-client.ts`. No persistent schemas change — `cluster.yaml`'s `workers: number` field is preserved as-is. Engine API DTOs use PascalCase to match the Docker daemon's wire format directly.

---

## Public surface (`worker-scaler.ts`)

### `ScaleOptions`

```typescript
export interface ScaleOptions {
  /** Target worker count. Must be >= 1 (validated upstream in lifecycle route). */
  count: number;

  /** Override orchestrator URL for metadata-refresh callback. Default: env ORCHESTRATOR_URL or http://127.0.0.1:3100. */
  orchestratorUrl?: string;

  /** Override orchestrator internal API key. Default: env ORCHESTRATOR_INTERNAL_API_KEY. */
  orchestratorApiKey?: string;

  /** Override Docker socket path. Default: env DOCKER_HOST or unix:///var/run/docker-host.sock. */
  dockerHost?: string;
}
```

### `ScaleResult`

```typescript
export interface ScaleResult {
  /** Worker count observed before scaling (from Engine API enumeration, not .env). */
  previousCount: number;

  /** Target count from ScaleOptions.count. */
  requestedCount: number;

  /** Actual achieved count after the operation. Equals requestedCount on success; differs on partial failure. */
  actualCount: number;
}
```

### `PartialScaleError`

Thrown when scale-up partially succeeds (≥1 replica created, but not all requested replicas).

```typescript
export class PartialScaleError extends Error {
  override readonly name = 'PartialScaleError';
  readonly requested: number;
  readonly actual: number;
  readonly cause: Error;
  constructor(requested: number, actual: number, cause: Error);
}
```

**Distinguishing from full failure**: If zero replicas were created, throw a plain `Error` (no `PartialScaleError`), and `cluster.yaml` is NOT updated. The route handler distinguishes by `error.name === 'PartialScaleError'`.

---

## Internal types (`worker-scaler.ts`)

### `WorkerReplica` (computed from Engine API)

```typescript
export interface WorkerReplica {
  /** Container ID from Docker. */
  id: string;

  /** Compose container number, parsed from com.docker.compose.container-number label. */
  number: number;

  /** Container name (e.g. "microservices-test-1-worker-3"). */
  name: string;

  /** State as reported by Engine: 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'created'. */
  state: ContainerState;

  /** Network IDs the container is currently attached to, in EndpointsConfig source order. */
  networkIds: string[];
}

export type ContainerState = 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'created';
```

### `ScalePlan` (output of `assignContainerNumbers`)

```typescript
export interface ScalePlan {
  /** New container-number slots to create, ascending (gap-fill first, then append). */
  toCreate: number[];

  /** Container IDs to remove. Selection order: exited replicas (highest-numbered first), then running (highest-numbered first). */
  toRemove: string[];
}
```

`assignContainerNumbers(existing: WorkerReplica[], target: number): ScalePlan` is pure and unit-tested. Either `toCreate` or `toRemove` is non-empty (never both). No-op returns `{ toCreate: [], toRemove: [] }`.

---

## Engine API DTOs (`docker-engine-client.ts`)

These are narrow subsets of Docker Engine API responses — we declare only the fields we read. Full responses are typed as `unknown` from `node:http` and validated/narrowed at the boundary.

### `ContainerSummary` (from `GET /containers/json`)

```typescript
export interface ContainerSummary {
  Id: string;
  Names: string[];                        // e.g. ['/microservices-test-1-worker-3']
  Labels: Record<string, string>;
  State: ContainerState;
  NetworkSettings?: {
    Networks?: Record<string, { NetworkID: string }>;
  };
}
```

### `ContainerInspect` (from `GET /containers/{id}/json`)

The clone source — we read enough fields to reconstruct a `ContainerCreateBody`. Stable across Docker Engine 1.41+.

```typescript
export interface ContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  Config: {
    Hostname?: string;                    // Stripped on clone
    Domainname?: string;
    User?: string;
    Env?: string[];
    Cmd?: string[];
    Entrypoint?: string[] | string;
    Labels?: Record<string, string>;
    WorkingDir?: string;
    Healthcheck?: HealthConfig;
    StopSignal?: string;
    StopTimeout?: number;
    ExposedPorts?: Record<string, Record<string, never>>;
  };
  HostConfig: {
    Binds?: string[];
    Mounts?: Mount[];
    NetworkMode?: string;
    RestartPolicy?: { Name: string; MaximumRetryCount?: number };
    LogConfig?: { Type: string; Config: Record<string, string> };
    Resources?: {
      Memory?: number;
      MemorySwap?: number;
      CpuShares?: number;
      CpusetCpus?: string;
    };
    SecurityOpt?: string[];
    CapAdd?: string[];
    CapDrop?: string[];
    Devices?: { PathOnHost: string; PathInContainer: string; CgroupPermissions: string }[];
    Init?: boolean;
    IpcMode?: string;
    PidMode?: string;
    ReadonlyRootfs?: boolean;
    Tmpfs?: Record<string, string>;
  };
  NetworkSettings: {
    Networks: Record<string, NetworkEndpoint>;  // Source of multi-network attachment plan
  };
}

export interface NetworkEndpoint {
  NetworkID: string;
  Aliases?: string[];
  IPAddress?: string;
  IPPrefixLen?: number;
  IPAMConfig?: { IPv4Address?: string };
}

export interface HealthConfig {
  Test?: string[];
  Interval?: number;
  Timeout?: number;
  Retries?: number;
  StartPeriod?: number;
}

export interface Mount {
  Type: 'bind' | 'volume' | 'tmpfs';
  Source?: string;
  Target: string;
  ReadOnly?: boolean;
  BindOptions?: { Propagation?: string };
  VolumeOptions?: { NoCopy?: boolean; Labels?: Record<string, string> };
}
```

### `ContainerCreateBody` (sent to `POST /containers/create?name=...`)

Mirrors `ContainerInspect.Config` + `HostConfig` shape, plus a single-network `NetworkingConfig`.

```typescript
export interface ContainerCreateBody {
  Hostname?: string;                      // Omitted — Docker derives from container name
  User?: string;
  Env?: string[];
  Cmd?: string[];
  Entrypoint?: string[] | string;
  Image: string;
  Labels?: Record<string, string>;        // With container-number overwritten to new number
  WorkingDir?: string;
  Healthcheck?: HealthConfig;
  StopSignal?: string;
  StopTimeout?: number;
  ExposedPorts?: Record<string, Record<string, never>>;
  HostConfig: ContainerInspect['HostConfig'];
  NetworkingConfig: {
    EndpointsConfig: Record<string, NetworkEndpointCreate>;  // Exactly one entry — first network from source
  };
}

export interface NetworkEndpointCreate {
  Aliases?: string[];
  IPAMConfig?: { IPv4Address?: string };
}
```

### `NetworkConnectBody` (sent to `POST /networks/{id}/connect`)

```typescript
export interface NetworkConnectBody {
  Container: string;                      // Container ID to attach
  EndpointConfig?: NetworkEndpointCreate;
}
```

### Engine API error envelope

Engine returns `{ message: string }` on 4xx/5xx. Our client wraps these:

```typescript
export class DockerEngineError extends Error {
  override readonly name = 'DockerEngineError';
  constructor(
    readonly statusCode: number,
    readonly endpoint: string,
    readonly engineMessage: string,
  );
}

export class DockerDaemonUnavailableError extends Error {
  override readonly name = 'DockerDaemonUnavailableError';
  constructor(socketPath: string, cause: Error);
}
```

`DockerDaemonUnavailableError.message === 'DOCKER_DAEMON_UNAVAILABLE'` for backward-compatible string-matching in the route handler (replaces `DOCKER_CLI_UNAVAILABLE`).

---

## Validation rules

- `ScaleOptions.count`: integer ≥ 1. Validated by `WorkerScaleBodySchema` (Zod) in `lifecycle.ts` before reaching `scaleWorkers`. Reaffirm at the start of `scaleWorkers` with a plain check (defense in depth).
- `WorkerReplica.number`: parsed from `com.docker.compose.container-number` label. If the label is missing or non-numeric, the container is **excluded** from the worker set with a `console.warn` log (defensive — could indicate a non-orchestrator-managed worker the user added manually).
- `ContainerInspect.NetworkSettings.Networks`: must be non-empty for clone source (otherwise we can't determine the first-network for create). If empty, scale-up fails with `Error('SOURCE_REPLICA_HAS_NO_NETWORKS')`.

---

## Relationships

```
┌─────────────────────┐    enumerate (filter labels, all=true)
│   ScaleOptions      │ ──────────────────────────────────────► WorkerReplica[]
└─────────────────────┘                                                │
         │                                                             │
         │ assignContainerNumbers(existing, target)                    │
         ▼                                                             │
┌─────────────────────┐         scale-up: inspect first replica        │
│     ScalePlan       │ ◄─────────────────────────────────────────────┘
└─────────────────────┘
         │
         │ scaleUp: per replica → create + connect + start
         │ scaleDown: per id → stop + remove
         ▼
┌─────────────────────┐
│     ScaleResult     │ ──► PartialScaleError on partial-success
│  { previousCount,   │
│    requestedCount,  │
│    actualCount }    │
└─────────────────────┘
```

---

## Persistence

- **`cluster.yaml.workers`**: written to `actualCount` (Q2=B). Atomic temp+rename (preserved from current implementation).
- **`.env.WORKER_COUNT`**: **removed** from the scale path (FR-010). The line stays in any pre-existing `.env` files (we don't delete on scale); it's just no longer read or written.
