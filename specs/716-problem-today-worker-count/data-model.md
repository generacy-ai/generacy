# Data Model: workers is per-host; CLI launch picks the count

**Issue**: [#716](https://github.com/generacy-ai/generacy/issues/716)
**Branch**: `716-problem-today-worker-count`

## Entities

### `LaunchOptions` (modified)

CLI-parsed options passed to the launch handler in `packages/generacy/src/cli/commands/launch/types.ts`.

```ts
export interface LaunchOptions {
  claim?: string;
  dir?: string;
  apiUrl?: string;
  cloudUrl?: string;
  logLevel?: string;
  workers?: number;        // NEW — from --workers=N flag; absent triggers prompt or no-TTY default
}
```

**Validation rules**:
- When provided via `--workers=N`, Commander parses to a string; the handler coerces with `parseInt(value, 10)` and rejects non-positive-integers with `commander.InvalidArgumentError`.
- When provided, must satisfy `1 <= workers <= tierCap`. Values above the cap are rejected with a clear error referencing the tier upgrade path (see error messages in `worker-count-resolver.md` contract).

**Relationships**:
- Consumed by `resolveWorkerCount(opts, launchConfig, isTTY) → number` (new helper).
- Result flows into `scaffoldProject(projectDir, config, workers)` → into both `.env` and `docker-compose.yml`.

### `LaunchConfigSchema` (modified)

Cloud launch-config response in `packages/generacy/src/cli/commands/launch/types.ts`.

```ts
export const LaunchConfigSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  variant: z.string().min(1),
  channel: z.enum(['stable', 'preview']).optional(),
  cloudUrl: z.string().url(),
  clusterId: z.string().min(1),
  imageTag: z.string().min(1),
  orgId: z.string().min(1),
  repos: z.object({ /* unchanged */ }),
  cloud: CloudUrlsSchema.optional(),
  registryCredentials: z.array(RegistryCredentialSchema).optional(),
  tierCap: z.number().int().min(1).optional(),  // NEW — org's worker cap; cloud-supplied
});
```

**Validation rules**:
- `tierCap`, when present, is a positive integer (≥ 1).
- Absence is permitted (companion cloud field may not yet ship); the CLI uses `CLI_FALLBACK_TIER_CAP = 8` as the fallback in that case and logs a warning.

**Relationships**:
- Consumed by `resolveWorkerCount`.
- Not otherwise referenced; the value is informational only.

### `WorkerCountResolution` (new internal type)

Return shape of `resolveWorkerCount(opts, launchConfig, isTTY)` in `packages/generacy/src/cli/commands/launch/worker-count-resolver.ts`.

```ts
export interface WorkerCountResolution {
  workerCount: number;                    // 1 ≤ workerCount ≤ tierCap
  source: 'flag' | 'prompt' | 'default';  // where the value came from
  tierCapSource: 'launch-config' | 'fallback';   // whether real cap or CLI fallback was used
  warnings: string[];                     // emitted via Clack p.log.warn by caller
}
```

**Validation rules**:
- `workerCount`: integer, `1 ≤ workerCount ≤ tierCap`. Rejection at this point throws — the caller exits with a non-zero code referencing the tier upgrade path.
- `source`:
  - `'flag'` when `opts.workers` was set explicitly.
  - `'prompt'` when an interactive prompt was shown (TTY present, no flag).
  - `'default'` when neither flag nor TTY was available — Q5's no-TTY path.
- `tierCapSource`:
  - `'launch-config'` when `launchConfig.tierCap` was present.
  - `'fallback'` when the baked-in `CLI_FALLBACK_TIER_CAP = 8` was used.
- `warnings`: zero or more strings (e.g., the Q5 no-TTY warning, the Q3 fallback warning).

**Behavioral matrix** (Q3 + Q4 + Q5 from clarifications.md):

| `opts.workers` | `launchConfig.tierCap` | `process.stdout.isTTY` | Action                                      | source     | tierCapSource    | warnings                                       |
|----------------|------------------------|------------------------|---------------------------------------------|------------|------------------|------------------------------------------------|
| set, ≤ cap     | set                    | (any)                  | accept value                                | `flag`     | `launch-config`  | —                                              |
| set, ≤ cap     | absent                 | (any)                  | accept value (cap=8 fallback applies)       | `flag`     | `fallback`       | `tierCap fallback (8) in use…`                 |
| set, > cap     | set or absent          | (any)                  | throw                                       | —          | —                | error text references tier upgrade path        |
| absent         | set                    | TTY                    | prompt; default = min(cap, 2)               | `prompt`   | `launch-config`  | —                                              |
| absent         | absent                 | TTY                    | prompt; default = min(8, 2) = 2             | `prompt`   | `fallback`       | `tierCap fallback (8) in use…`                 |
| absent         | set                    | no TTY                 | default = min(cap, 2); no prompt            | `default`  | `launch-config`  | `No TTY detected and --workers not provided…` |
| absent         | absent                 | no TTY                 | default = min(8, 2) = 2; no prompt          | `default`  | `fallback`       | both warnings above                            |

**Relationships**:
- Caller (`launchAction`) reads `workerCount` and threads into `scaffoldProject`, the activation poll body, and CLI feedback.
- `source` and `tierCapSource` are used only by tests and logging — not by downstream code.

### `PollRequestSchema` (new)

Wire-format request body for `POST /api/clusters/device-code/poll`, defined in `packages/activation-client/src/types.ts`.

```ts
export const PollRequestSchema = z.object({
  device_code: z.string().min(1),
  workers: z.number().int().min(1).optional(),   // NEW — relays chosen launch-time workers to cloud
});
export type PollRequest = z.infer<typeof PollRequestSchema>;
```

**Validation rules**:
- `workers`, when present, is a positive integer.
- Absent on subsequent polls within the same activation cycle — only the first poll where the orchestrator passes through `initialWorkers` carries it. In practice the same value rides every poll within an activation cycle; the cloud just persists it once on the `approved` transition.

**Relationships**:
- Constructed inside `pollDeviceCode(cloudUrl, deviceCode, httpClient, workers?)`.
- Read cloud-side by the companion PR (#696) when status transitions to `approved` → set `targetWorkers` on the cluster document.

### `ActivationOptions` (modified)

Orchestrator-specific options in `packages/orchestrator/src/activation/types.ts`.

```ts
export interface ActivationOptions {
  cloudUrl: string;
  keyFilePath: string;
  clusterJsonPath: string;
  logger: Logger;
  maxCycles?: number;
  maxRetries?: number;
  httpClient?: HttpClient;
  initialWorkers?: number;     // NEW — from GENERACY_INITIAL_WORKERS env, threaded into poll body
}
```

**Validation rules**:
- `initialWorkers`, when present, is a positive integer. Caller (`server.ts`) parses with `Number()`/`parseInt()` and validates before passing.

**Relationships**:
- `activate(options)` → `pollForApproval({ …, workers: options.initialWorkers })` → `pollDeviceCode(…, options.workers)`.

### `PollOptions` (modified)

Internal poller state in `packages/activation-client/src/poller.ts`.

```ts
export interface PollOptions {
  cloudUrl: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  httpClient: HttpClient;
  logger: ActivationLogger;
  workers?: number;            // NEW — forwarded to pollDeviceCode body
}
```

**Validation rules**: same as `PollRequest.workers`.

**Relationships**: thin pass-through to `pollDeviceCode`.

## File-level shape changes

### `.generacy/.env` (generated by `scaffoldEnvFile`)

Already contains a `WORKER_COUNT=N` line (`scaffolder.ts:297`). The line's value flips from hardcoded `1` to the resolved `WorkerCountResolution.workerCount`.

```text
# Project
PROJECT_NAME=…
…
WORKER_COUNT=4          # ← now reflects user's --workers / prompt / default choice
```

### `.generacy/docker-compose.yml` (generated by `scaffoldDockerCompose`)

Orchestrator service's `environment:` array gains one entry:

```yaml
services:
  orchestrator:
    environment:
      - REDIS_URL=redis://redis:6379
      - REDIS_HOST=redis
      - DEPLOYMENT_MODE=local
      - CLUSTER_VARIANT=cluster-base
      - GENERACY_INITIAL_WORKERS=${WORKER_COUNT}   # ← NEW — interpolated from .env at compose up
```

Worker service's `deploy.replicas: ${WORKER_COUNT:-1}` stays as-is.

### `.generacy/cluster.local.yaml` (written by orchestrator entrypoint — companion PR)

Companion `cluster-base` PR writes the file on first boot when (a) `$GENERACY_INITIAL_WORKERS` is set and (b) the file doesn't yet exist:

```yaml
workers: 4
```

Subsequent boots leave the file alone (idempotency rule). The orchestrator's existing readers (`relay-bridge.ts`, the deriver, etc.) consume it via `readMergedClusterConfig`.

## Relationships

```text
generacy launch --claim=<c> [--workers=N]
  │
  ├──► fetchLaunchConfig(cloud, claim)
  │       └──► LaunchConfig (tierCap?: number)
  │
  ├──► resolveWorkerCount(opts, launchConfig, isTTY) → WorkerCountResolution
  │       │
  │       ├──► [TTY] promptWorkerCount(tierCap, defaultWorkers)
  │       └──► [no-TTY] return defaultWorkers + warning
  │
  ├──► scaffoldProject(projectDir, launchConfig, resolution.workerCount)
  │       ├──► .env → WORKER_COUNT=<N>
  │       └──► docker-compose.yml → GENERACY_INITIAL_WORKERS=${WORKER_COUNT}
  │
  ├──► docker compose pull && up -d
  │       └──► orchestrator container starts
  │              └──► entrypoint-orchestrator.sh (COMPANION cluster-base PR)
  │                     └──► writes .generacy/cluster.local.yaml: workers: N
  │                          (only if file absent AND $GENERACY_INITIAL_WORKERS set)
  │
  └──► (inside orchestrator)
        activate({ …, initialWorkers: parseInt($GENERACY_INITIAL_WORKERS) })
          └──► pollForApproval({ …, workers: initialWorkers })
                └──► pollDeviceCode(cloudUrl, deviceCode, httpClient, workers)
                       └──► POST /api/clusters/device-code/poll
                              body: { device_code, workers: N }
                              └──► (COMPANION generacy-cloud PR) cluster.targetWorkers = N on approve
```

## Out-of-scope reads

The orchestrator's existing readers consume `cluster.local.yaml` transparently:
- `packages/orchestrator/src/services/relay-bridge.ts` — for `metadata.workers` push (#714)
- `packages/control-plane/src/services/worker-scaler.ts` — for subsequent scale operations
- `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts` — for `npx generacy up` / `update`

None of these need changes; the local-wins semantics established by #709/#712 already do the right thing.
