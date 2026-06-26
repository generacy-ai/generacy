# Contract: Orchestrator client

## Factory

```ts
function createOrchestratorClient(config: {
  baseUrl?: string;                    // default: 'http://127.0.0.1:3100'
  token?: string;                      // when absent: factory returns the stub
  httpClient?: HttpClient;             // override for tests; default: NativeHttpClient
}): OrchestratorClient;
```

### Dispatch rule

- If `config.token` is `undefined`, empty, or whitespace-only ⇒ return the **stub** client.
- Otherwise ⇒ return the **live** client wired to the given `httpClient`.

The factory **never throws** at construction. Token absence is a runtime data state, not an error.

## Interface

```ts
interface OrchestratorClient {
  isAvailable(): boolean;
  health(): Promise<HealthResult>;
  getJobs(): Promise<JobsResult>;
  getWorkers(): Promise<WorkersResult>;
}
```

### `isAvailable()`

- Stub: returns `false`.
- Live: returns `true` (the live client trusts `config.token` is present at construction time; it does not pre-flight).

### `health()`, `getJobs()`, `getWorkers()`

Stub return values (FR-010 — never throws):

```ts
{ available: false, reason: 'no-token' }
```

Live return values:

| HTTP outcome                       | Result                                                          |
|------------------------------------|-----------------------------------------------------------------|
| 2xx with valid JSON                | `{ available: true, ... }` (parsed body)                        |
| 2xx with malformed JSON            | `{ available: false, reason: 'http-error', statusCode: <code> }`|
| Non-2xx                            | `{ available: false, reason: 'http-error', statusCode: <code> }`|
| Network failure / timeout          | `{ available: false, reason: 'cloud-unreachable' }`             |

The live client never throws — every error path is captured into the result envelope. This satisfies SC-005 in both modes.

## Endpoint mapping (v1)

| Method        | HTTP                                                 |
|---------------|------------------------------------------------------|
| `health()`    | `GET ${baseUrl}/health`                              |
| `getJobs()`   | `GET ${baseUrl}/queue`                               |
| `getWorkers()`| `GET ${baseUrl}/dispatch/queue/workers`              |

Headers (live client):

```
Authorization: Bearer ${config.token}
Accept: application/json
```

These endpoints exist today in `packages/orchestrator/src/routes/{health,queue,dispatch}.ts`. G5.1 will expand the surface and may revise the mapping; this PR locks the v1 shape.

## Result shapes

```ts
type HealthResult =
  | { available: false; reason: 'no-token' | 'cloud-unreachable' | 'http-error'; statusCode?: number }
  | { available: true; status: 'ok' | 'degraded'; data: Record<string, unknown> };

type JobsResult =
  | { available: false; reason: 'no-token' | 'cloud-unreachable' | 'http-error'; statusCode?: number }
  | { available: true; jobs: JobSummary[] };

type WorkersResult =
  | { available: false; reason: 'no-token' | 'cloud-unreachable' | 'http-error'; statusCode?: number }
  | { available: true; workers: WorkerSummary[] };

interface JobSummary {
  id: string;
  status: string;
  workflowId?: string;
}

interface WorkerSummary {
  id: string;
  status: string;
  currentJobId?: string;
}
```

The pass-through `status: string` on `JobSummary` / `WorkerSummary` accepts whatever the orchestrator emits — the cockpit foundation should not lock orchestrator status values until G5.1 stabilizes them.

## Invariants

- No method ever throws.
- `isAvailable() === false` ⇒ every result-returning method resolves to `{ available: false, reason: 'no-token' }`.
- `isAvailable() === true` ⇒ result envelopes reflect the HTTP outcome; result type discrimination is the caller's contract for safe rendering.

## Test approach

- Stub tests: construct without a token, assert `isAvailable() === false`, assert each method resolves to `{ available: false, reason: 'no-token' }`, assert no `httpClient` calls were made (when injected).
- Live tests: construct with a token and an injected `httpClient` stub returning canned responses for each endpoint. Assert URL / method / Authorization header / parsed result.
- Failure tests: inject HTTP errors (non-2xx, network error, malformed JSON) and assert the discriminated result envelope.
