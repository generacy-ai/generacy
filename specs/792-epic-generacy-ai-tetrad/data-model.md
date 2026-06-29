# Data Model

All types are TypeScript; runtime validation uses `zod` where the value crosses an I/O boundary (NDJSON stdout, JSON envelope stdout, HTTP request body). Pure in-process state is typed but not zod-validated.

## 1. OrchestratorClient (cockpit package)

```ts
// packages/cockpit/src/orchestrator/client.ts
export type UnavailableReason = 'no-token' | 'cloud-unreachable' | 'http-error' | 'timeout';

export interface JobSummary {
  id: string;
  status: string;
  workflowId?: string;
}

export type HealthResult =
  | { available: false; reason: UnavailableReason; statusCode?: number }
  | { available: true; status: 'ok' | 'degraded'; data: Record<string, unknown> };

export type JobsResult =
  | { available: false; reason: UnavailableReason; statusCode?: number }
  | { available: true; jobs: JobSummary[] };

// CHANGED — was { workers: WorkerSummary[] }
export type WorkersResult =
  | { available: false; reason: UnavailableReason; statusCode?: number }
  | { available: true; count: number };

export interface OrchestratorClient {
  isAvailable(): boolean;
  health(): Promise<HealthResult>;
  getJobs(): Promise<JobsResult>;
  getWorkers(): Promise<WorkersResult>;  // shape change only
}

export interface CreateOrchestratorClientConfig {
  baseUrl?: string;     // default 'http://127.0.0.1:3100'
  token?: string;       // empty/whitespace → stub
  httpClient?: HttpClient;
}
```

**Removed**: `WorkerSummary` (no other consumers), `normalizeWorkers` (no longer called).

**Validation rules**:
- `baseUrl` trimmed of trailing slashes; defaulted to `http://127.0.0.1:3100`.
- `token` `undefined` / `""` / whitespace-only ⇒ factory returns the stub; no HTTP call ever made.
- HTTP non-2xx ⇒ `{ available: false, reason: 'http-error', statusCode }`.
- Network failure ⇒ `{ available: false, reason: 'cloud-unreachable' }`.
- The live client must never throw.

## 2. Token resolution (cli layer)

```ts
// packages/generacy/src/cli/commands/cockpit/shared/orchestrator-token.ts
export interface TokenSources {
  envValue: string | undefined;     // typically process.env.ORCHESTRATOR_API_TOKEN
  configValue: string | undefined;  // typically loaded.config.orchestrator?.token
}

export function resolveOrchestratorToken(sources: TokenSources): string | undefined;
```

**Rules**:
- Trim both. Empty after trim ⇒ treated as `undefined`.
- Return trimmed `envValue` if non-empty.
- Else return trimmed `configValue` if non-empty.
- Else return `undefined`.

This is the **only** place the CLI consults `process.env` for the orchestrator token. Commands inject the resolved string into `createOrchestratorClient({ token })`.

## 3. First-failure warner (cli layer)

```ts
// packages/generacy/src/cli/commands/cockpit/shared/orchestrator-warn.ts
export interface WarnSink {
  write(message: string): void;       // typically process.stderr.write bound
}

export interface FirstFailureWarner {
  (reason: string): void;             // call on each failure; emits once total
  hasFired(): boolean;                // for tests
}

export function createFirstFailureWarner(sink: WarnSink): FirstFailureWarner;
```

**Rules**:
- First call writes `cockpit: orchestrator unavailable: <reason>\n` to the sink, sets internal `fired = true`.
- Subsequent calls return without writing.
- One warner per CLI invocation. Status: trivially one call (since the command is one-shot). Watch: created at startup; sink is `process.stderr.write.bind(process.stderr)`.

## 4. FooterData (cli layer, shared by status and watch)

```ts
// packages/generacy/src/cli/commands/cockpit/shared/orchestrator-footer.ts
export interface FooterData {
  available: boolean;
  reason?: string;       // present when available === false
  jobs?: number;         // present when available === true
  workers?: number;      // present when available === true; value = .count from /dispatch/queue/workers
}

export function getFooter(
  client: OrchestratorClient,
  timeoutMs?: number,    // default 1500
  onFirstFailure?: FirstFailureWarner,
): Promise<FooterData>;

export function renderFooter(footer: FooterData): string;
```

**Rules**:
- `getFooter` runs `getJobs()` and `getWorkers()` in parallel, each raced against the timeout.
- Either timing out ⇒ `{ available: false, reason: 'timeout' }`.
- Either returning unavailable ⇒ `{ available: false, reason: <that reason> }` and the failure is reported once via `onFirstFailure` (if provided).
- Both available ⇒ `{ available: true, jobs: jobsResult.jobs.length, workers: workersResult.count }`.
- `renderFooter`:
  - `available` ⇒ `orchestrator: ${jobs ?? 0} jobs, ${workers ?? 0} active workers` (literal `active workers`).
  - `reason === 'no-token'` ⇒ `orchestrator: (no token; set ORCHESTRATOR_API_TOKEN to enable)`.
  - Otherwise ⇒ `orchestrator: (unavailable — ${reason ?? 'unknown'})`.

## 5. OrchestratorCounts (watch layer)

```ts
// packages/generacy/src/cli/commands/cockpit/watch/orchestrator-counts.ts
export type OrchestratorCountsState =
  | { kind: 'available'; jobs: number; workers: number }
  | { kind: 'unavailable'; reason: string };

export type OrchestratorCountsEvent =
  | { type: 'orchestrator-counts'; jobs: number; workers: number }
  | { type: 'orchestrator-counts'; available: false; reason: string };

export const OrchestratorCountsEventSchema = z.discriminatedUnion(/* ... */);

export async function pollOrchestratorCounts(
  client: OrchestratorClient,
  prev: OrchestratorCountsState | null,
  onFirstFailure: FirstFailureWarner,
  timeoutMs?: number,                   // default 1500
): Promise<{ event: OrchestratorCountsEvent | null; curr: OrchestratorCountsState }>;
```

**State machine** (drives the emit decision):

| `prev`                                | `curr`                                  | `event` |
|---------------------------------------|-----------------------------------------|---------|
| `null` (startup)                      | any                                     | emit |
| `{available, jobs:a, workers:b}`      | `{available, jobs:a, workers:b}`        | `null` |
| `{available, jobs:a, workers:b}`      | `{available, jobs:a', workers:b}` (a≠a')| emit |
| `{available, jobs:a, workers:b}`      | `{available, jobs:a, workers:b'}` (b≠b')| emit |
| `{available, ...}`                    | `{unavailable, reason:r}`               | emit |
| `{unavailable, reason:r}`             | `{unavailable, reason:r}`               | `null` |
| `{unavailable, reason:r}`             | `{unavailable, reason:r'}` (r≠r')       | emit |
| `{unavailable, ...}`                  | `{available, ...}`                      | emit |

**Validation**: emitted events are validated against `OrchestratorCountsEventSchema` before write (mirrors `CockpitEventSchema` pattern). Skippable via `skipValidate` for hot paths if needed (not used in v1).

## 6. JSON envelope (status `--json`)

Existing shape preserved (back-compat for #787 consumers). The orchestrator field already exists in `StatusEnvelope`:

```ts
orchestrator:
  | { available: true; jobs: number; workers: number }
  | { available: false; reason: string };
```

The `workers` JSON field is the **count**, not an array — the data-model is now byte-stable end to end.

## 7. Relationships

```
process.env.ORCHESTRATOR_API_TOKEN ─┐
                                    ├─► resolveOrchestratorToken() ─► createOrchestratorClient({token, baseUrl})
loaded.config.orchestrator.token ───┘                                            │
                                                                                 ▼
                                                                       OrchestratorClient
                                                                                 │
                       ┌──────── status.ts ─────────────────────────┐ ┌── watch.ts ─────────────────────┐
                       │                                            │ │                                  │
                       ▼                                            │ │                                  ▼
              getFooter(client, 1500, warner) ────► FooterData ─────┘ └─► pollOrchestratorCounts(client, prev, warner)
                       │                                                                                │
            ┌──────────┴──────────┐                                                      ┌──────────────┴───────────┐
            ▼                     ▼                                                      ▼                          ▼
    renderFooter(footer)   renderJsonEnvelope(...)                          OrchestratorCountsEvent      curr OrchestratorCountsState
            │                     │                                                      │                          │
            ▼                     ▼                                                      ▼                          ▼
    stdout (table mode)   stdout (--json mode)                              JSON.stringify → stdout    saved as prev for next tick
```
