# Data Model: Orchestrator `/health` version field

**Feature**: #907
**Branch**: `907-symptom-connected-clusters`
**Date**: 2026-07-10
**Phase**: 1 — data / type surface

---

## 1. `HealthResponse` — extended shape

### 1.1 Zod schema (`packages/orchestrator/src/types/api.ts`)

**Current (line 210-219)**:
```ts
export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  services: z.record(ServiceStatusSchema),
  codeServerReady: z.boolean().optional(),
  controlPlaneReady: z.boolean().optional(),
  displayName: z.string().optional(),
  clusterId: z.string().optional(),
  githubAuth: GitHubAuthSnapshotSchema.optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
```

**After #907**:
```ts
export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  services: z.record(ServiceStatusSchema),
  version: z.string(),                              // NEW — non-optional, non-empty guaranteed by resolver
  codeServerReady: z.boolean().optional(),
  controlPlaneReady: z.boolean().optional(),
  displayName: z.string().optional(),
  clusterId: z.string().optional(),
  githubAuth: GitHubAuthSnapshotSchema.optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
```

**Field ordering**: `version` inserted immediately after `services` and before `codeServerReady`. Matches the Fastify JSON schema field order added in the same change (`health.ts:70-82` and `84-98`).

**Non-optional**: `z.string()` (not `z.string().optional()`). The resolver guarantees a value — env var, package.json fallback, or `"unknown"` sentinel — so the field is always present in the handler-constructed response.

**No `.min(1)` refinement**: Q4 → C — no format contract is enforced by the type. Empty-string cannot originate from the resolver (the guard rejects it), so a `.min(1)` refinement would only fire on a downstream mistake, and it would then produce a Zod ZodError that's harder to correlate with the on-wire symptom than a plain missing/empty field. Keep the schema loose; keep the resolver strict.

### 1.2 Fastify response JSON Schema (`packages/orchestrator/src/routes/health.ts`)

**Current (200 branch, ~68-82)**:
```ts
response: {
  200: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
      timestamp: { type: 'string', format: 'date-time' },
      services: { type: 'object', additionalProperties: { type: 'string', enum: ['ok', 'error'] } },
      codeServerReady: { type: 'boolean' },
      controlPlaneReady: { type: 'boolean' },
      displayName: { type: 'string' },
      clusterId: { type: 'string' },
      githubAuth: GITHUB_AUTH_SCHEMA,
    },
  },
  // ... 503 branch has identical shape
}
```

**After #907** (both 200 and 503 branches):
```ts
properties: {
  status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
  timestamp: { type: 'string', format: 'date-time' },
  services: { type: 'object', additionalProperties: { type: 'string', enum: ['ok', 'error'] } },
  version: { type: 'string' },                     // NEW — declared in BOTH 200 and 503
  codeServerReady: { type: 'boolean' },
  controlPlaneReady: { type: 'boolean' },
  displayName: { type: 'string' },
  clusterId: { type: 'string' },
  githubAuth: GITHUB_AUTH_SCHEMA,
},
```

**Both branches required**: Fastify strips undeclared fields via `fast-json-stringify`. Declaring `version` only on the 200 branch would silently reintroduce the bug on the 503 (health-degraded) reconnect path. FR-002 in the spec is explicit about this.

**No `required: ['version']` in the Fastify schema**: Fastify's response schema does not enforce `required` on outgoing responses the way it does on incoming request bodies. The Zod schema is the authoritative type contract. If the handler forgets to set `version` (compile error today thanks to the non-optional Zod type), the runtime symptom would be `version: undefined` → serialized as absent — which is exactly what happens today. Adding runtime enforcement here is a belt-and-suspenders move; the compile-time type is load-bearing.

---

## 2. `resolveOrchestratorVersion()` — resolver contract

### 2.1 Signature

```ts
// packages/orchestrator/src/services/orchestrator-version.ts
export function resolveOrchestratorVersion(): string;
```

**Return**: always a non-empty string. Never `undefined`, never `null`, never `""`, never the literal `"0.0.0"` (Q1 → A). Callers assign directly to `HealthResponse['version']` without further checks.

**Side effects**: on the fallback path (env var didn't resolve), one synchronous `readFileSync` of `packages/orchestrator/package.json`. On the env-var path, no I/O. On any fallback failure, no throw — returns `"unknown"` sentinel.

**Determinism**: pure function of `process.env.ORCHESTRATOR_VERSION` + the on-disk `package.json` at call time. Idempotent for the process lifetime (env vars don't change, package.json doesn't change under a running container). Callers may cache the return value in a closure — see plan.md §Decision 5.

### 2.2 Decision matrix

| Row | `process.env.ORCHESTRATOR_VERSION` | `package.json` `.version` | Output |
|---|---|---|---|
| 1 | `"sha-abc1234"` (real, ≠ `"0.0.0"`) | anything | `"sha-abc1234"` |
| 2 | `"0.0.0"` (literal string) | `"0.1.0"` (real) | `"0.1.0"` |
| 3 | `""` (empty string) | `"0.1.0"` (real) | `"0.1.0"` |
| 4 | `undefined` (unset) | `"0.1.0"` (real) | `"0.1.0"` |
| 5 | `undefined` (unset) | `"0.0.0"` (literal) | `"unknown"` |
| 6 | `undefined` (unset) | file unreadable / malformed JSON / missing `version` field | `"unknown"` |
| 7 | `"0.0.0"` (literal) | `"0.0.0"` (literal) | `"unknown"` |
| 8 | `""` (empty) | `""` (empty) | `"unknown"` |

**Invariant covering rows 1–8**: `isRealVersion(candidate)` returns `true` iff `candidate !== undefined && candidate !== "" && candidate !== "0.0.0"`. No trimming, no lowercasing (see research.md §Decision 3). Package.json's `.version` is passed through the same guard as the env var; the guard is uniform (Q1 → A).

### 2.3 Internal helper

```ts
function isRealVersion(candidate: string | undefined): candidate is string {
  return candidate !== undefined && candidate !== '' && candidate !== '0.0.0';
}
```

Type-narrowing predicate. On `true`, TypeScript narrows the input to `string` — lets the resolver body directly return `candidate` without an assertion.

### 2.4 Sentinel

```ts
// Not exported; duplicated in the resolver body and in the FR-007 test (see research.md §Decision 7).
return 'unknown';
```

Literal string. Never derived from a shared constant across files — Q2 → A locks it, and independent duplication is the load-bearing anti-drift check.

---

## 3. `HealthCheckOptions` — no change

The `HealthCheckOptions` interface in `packages/orchestrator/src/routes/health.ts:10-28` is **not** modified. The resolver is called internally by `setupHealthRoutes`, not injected via options.

**Rationale**: injecting the version through options adds a parameter every call site of `setupHealthRoutes` (`server.ts:635` for worker mode, `routes/index.ts:42` for full mode) has to thread. The version isn't cluster-scoped or user-configurable — it's a build-time property of the running binary. Reading it inside `setupHealthRoutes` is the natural encapsulation. Test overrides that need a specific version can `vi.mock('../services/orchestrator-version.js', ...)` — see plan.md §Test.

---

## 4. Downstream — `cluster-relay/metadata.ts` — unchanged

`packages/cluster-relay/src/metadata.ts:56-57`:
```ts
const result: HealthData = {
  version: String(data['version'] ?? '0.0.0'),    // UNCHANGED — FR-006
  // ...
};
```

Not modified. The `?? '0.0.0'` fallback remains as a defensive backstop for the "orchestrator unreachable" path (the `catch { }` branch at line 71-73). After #907, `data['version']` will always be a real non-empty string (the resolver's guarantee), so the `?? '0.0.0'` branch on the happy path is dead code but still correct. Cleaning it up is out of scope (FR-006).

---

## 5. Firestore / cloud dashboard — no schema change

The cloud-side `orchestratorVersion` Firestore field is already `string`-typed. It accepts `"unknown"`, `"sha-abc1234"`, `"0.1.0"`, and any other non-empty string identically. The dashboard renders whatever value is present.

**Post-fix rendering**:
- Fresh-image cluster with `ORCHESTRATOR_VERSION=sha-abc1234` wired: dashboard shows `sha-abc1234`.
- Fresh-image cluster with no env var wired: dashboard shows `0.1.0` (the current orchestrator package.json version — until the workspace default changes).
- Misconfigured cluster (`ORCHESTRATOR_VERSION=0.0.0` and package.json workspace-defaulted to `"0.0.0"`): dashboard shows `unknown` — visibly distinct from the pre-fix `0.0.0`.
- Pre-fix cluster (running an old image): dashboard shows `0.0.0` — the cluster-relay fallback. Unchanged until the image is upgraded (spec §Out of Scope, "Backfilling ... old images").

---

## 6. Validation rules (summary)

| Layer | Validation | Enforcer |
|---|---|---|
| Resolver output | Non-empty string, ≠ `"0.0.0"` | `isRealVersion()` guard + `"unknown"` sentinel |
| Handler assignment | `HealthResponse['version']: string` (non-optional) | TypeScript compile-time via Zod `z.infer<>` |
| Fastify serialization | Field is declared and typed | `response.200.properties.version` + `response.503.properties.version` |
| Wire contract (cluster-relay reader) | `data['version']` non-empty | Cluster-relay's `String(... ?? '0.0.0')` remains the defensive backstop for unreachable orchestrator only |

No layer enforces a format (Q4 → C). Any non-empty, non-`"0.0.0"` string passes end-to-end.

---

## 7. Relationships

```
process.env.ORCHESTRATOR_VERSION ────┐
                                     ├──> resolveOrchestratorVersion() ──> string
packages/orchestrator/package.json ──┘                                       │
                                                                             │
                                    setupHealthRoutes closure ◄──────────────┘
                                             │
                                             │ (per-request)
                                             ▼
                              GET /health  ──> HealthResponse.version
                                             │
                                             │ (Fastify JSON serialization with declared schema)
                                             ▼
                              HTTP body  ──> { "version": "...", ... }
                                             │
                                             │ (5s-interval fetch)
                                             ▼
                              cluster-relay metadata.ts:fetchHealth()
                                             │
                                             │ (WebSocket relay message)
                                             ▼
                              cloud Firestore: cluster.orchestratorVersion
                                             │
                                             │ (dashboard subscription)
                                             ▼
                              dashboard row: "Orchestrator: <version>"
```

Every arrow above is preserved. Only the top-left resolver and the Fastify schema at the third box are new/modified. Everything downstream (cluster-relay, cloud, Firestore, dashboard) is unchanged and just starts seeing real values.
