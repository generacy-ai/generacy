# Contract: `GET /health` response — `version` field

**Feature**: #907
**Endpoint**: `GET /health` on the orchestrator (Fastify)
**Status**: Extended (adds `version` field)

---

## Pre-conditions

- Orchestrator is running.
- `packages/orchestrator/src/routes/health.ts` `setupHealthRoutes` has been registered against the Fastify instance.
- `resolveOrchestratorVersion()` has been called once at registration time; the returned string is captured in the handler closure.

## Post-conditions (200 response)

The JSON response body includes all of:

| Field | Type | Presence | Notes |
|---|---|---|---|
| `status` | `'ok' \| 'degraded' \| 'error'` | Always | Unchanged. |
| `timestamp` | ISO 8601 string | Always | Unchanged. |
| `services` | `{ [name: string]: 'ok' \| 'error' }` | Always | Unchanged. |
| **`version`** | `string` (non-empty) | **Always** | **NEW.** See §Version-field guarantees below. |
| `codeServerReady` | `boolean` | When probe ran | Unchanged. |
| `controlPlaneReady` | `boolean` | When probe ran | Unchanged. |
| `displayName` | `string` | When `cluster.displayName` set | Unchanged. |
| `clusterId` | `string` | When `cluster.id` set | Unchanged. |
| `githubAuth` | `GitHubAuthSnapshot` | When configured | Unchanged. |

## Post-conditions (503 response)

Identical field shape to the 200 branch. The Fastify response schema for the 503 branch **must** also declare `version: { type: 'string' }` — omission causes `fast-json-stringify` to strip the field, silently reproducing the pre-fix bug on the health-degraded path.

## Version-field guarantees

For every response emitted by the fixed handler:

1. `body.version` is present.
2. `typeof body.version === 'string'`.
3. `body.version.length > 0`.
4. `body.version !== '0.0.0'`.
5. Either:
   - `body.version === '<value from ORCHESTRATOR_VERSION env var>'` (if the env var is set and its value ≠ `""` and ≠ `"0.0.0"`), OR
   - `body.version === '<value from packages/orchestrator/package.json .version>'` (if env var didn't resolve and the package.json read succeeded and its value ≠ `""` and ≠ `"0.0.0"`), OR
   - `body.version === 'unknown'` (sentinel — env var didn't resolve AND package.json didn't resolve).

**Format**: no format contract enforced (Q4 → C). Any non-empty string satisfying (4) is acceptable. The recommended value convention (non-binding) is the `sha-<short>` identifier the image is tagged with — gives operators a 1:1 correlation between dashboard string and pullable image tag.

**Sentinel string**: locked at exactly `"unknown"` (Q2 → A). Both the handler and the FR-007 test assert this literal — no shared constant.

## Failure modes

| Scenario | Behavior |
|---|---|
| `ORCHESTRATOR_VERSION` unset, `package.json` unreadable | `version === 'unknown'` |
| `ORCHESTRATOR_VERSION` unset, `package.json` malformed JSON | `version === 'unknown'` |
| `ORCHESTRATOR_VERSION` unset, `package.json` `version` field missing | `version === 'unknown'` |
| `ORCHESTRATOR_VERSION === ''`, `package.json` `.version === '0.1.0'` | `version === '0.1.0'` |
| `ORCHESTRATOR_VERSION === '0.0.0'`, `package.json` `.version === '0.1.0'` | `version === '0.1.0'` (Q1 → A) |
| `ORCHESTRATOR_VERSION === 'sha-abc1234'`, `package.json` `.version === '0.1.0'` | `version === 'sha-abc1234'` |
| Concurrent requests during startup | Deterministic — the resolver runs once at registration; the closed-over value is stable for the process lifetime. |

## Schema-strip regression

Fastify's `fast-json-stringify` compiles the JSON response schema to a fast serializer that drops any field not declared in `response.<statusCode>.properties`. This is the bug behind the pre-fix behavior: the handler could have set `version` and the field would still not appear on the wire because it wasn't declared. **Both** the Zod schema and the Fastify JSON schema must be updated in the same change to prevent the regression.

Tests must exercise the actual JSON response body (not the handler return value), to catch a schema-strip regression:

```ts
const response = await server.inject({ method: 'GET', url: '/health' });
const body = JSON.parse(response.body);
expect(body.version).toBeDefined();          // catches schema-strip
expect(body.version).not.toBe('0.0.0');      // catches Q1 guard failure
expect(typeof body.version).toBe('string');  // catches serialization type error
```

## Downstream consumers

- `packages/cluster-relay/src/metadata.ts:56-57` — reads `data['version']`, coerces via `String(...)`, falls back to `"0.0.0"` only when the value is nullish. Post-fix, the fallback is unreachable on the happy path. Unmodified in this PR (FR-006).
- Cloud dashboard (`generacy-cloud` — separate repo) — reads the Firestore `orchestratorVersion` field and renders as-is. No schema change; no dashboard change required.

## Backwards compatibility

- Clusters running pre-fix images continue to report `"0.0.0"` (via cluster-relay's fallback) until the image is upgraded. No cloud-side backfill (spec §Out of Scope).
- Clusters running the fixed image but without `ORCHESTRATOR_VERSION` wired at Docker build time will report the orchestrator's `package.json` `.version` (currently `"0.1.0"`). This is a valid transitional state; the follow-up cluster-base / cluster-microservices PRs wire the env var to `sha-<short>`.

## Test-fixture excerpt (illustrative)

**Given** `ORCHESTRATOR_VERSION=sha-abc1234`:
```json
{
  "status": "ok",
  "timestamp": "2026-07-10T18:42:00.000Z",
  "services": { "server": "ok" },
  "version": "sha-abc1234",
  "codeServerReady": false,
  "controlPlaneReady": false
}
```

**Given** env var unset, resolver mocked to return `"unknown"`:
```json
{
  "status": "ok",
  "timestamp": "2026-07-10T18:42:00.000Z",
  "services": { "server": "ok" },
  "version": "unknown",
  "codeServerReady": false,
  "controlPlaneReady": false
}
```
