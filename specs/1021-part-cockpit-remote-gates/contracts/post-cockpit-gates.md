# Contract: `POST /cockpit/gates`

Orchestrator-side wire the in-cluster cockpit MCP calls when a gate opens.

## Request

- **Method / path**: `POST /cockpit/gates`
- **Auth**: `Authorization: Bearer <COCKPIT_INTERNAL_API_KEY>` — resolved by `authMiddleware` against `apiKeyStore`. Missing/invalid key → `401 { error, code: 'UNAUTHORIZED' }` (produced by the middleware, not this handler).
- **Content-Type**: `application/json` (Fastify parses; wrong content-type → `415`).
- **Body**: `GateOpen` (see `data-model.md §1.1`).

Minimum required fields the orchestrator enforces:

```jsonc
{
  "kind": "gate-open",              // exact literal
  "gateId": "string",               // non-empty
  "generation": 0,                  // int >= 0
  "scope": { ... },                 // structurally present
  "openedAt": "2026-07-21T…Z"       // ISO8601
  // Additional epic-defined fields (payload, etc.) accepted as passthrough.
}
```

## Responses

| Status | Body | When |
|---|---|---|
| `202 Accepted` | `{ "accepted": true, "retained": false }` | Client connected — event sent on the relay. |
| `202 Accepted` | `{ "accepted": true, "retained": true, "retainQueue": { "count": N, "bytes": M } }` | Client disconnected — event enqueued. |
| `400 Bad Request` | `{ "error": "Invalid gate-open payload", "code": "VALIDATION", "details": [zod-issues…] }` | Schema validation failed. |
| `401 Unauthorized` | `{ "error": "…", "code": "UNAUTHORIZED" }` | Produced by `authMiddleware`. |
| `503 Service Unavailable` | `{ "error": "Retain queue is full and cannot enqueue", "code": "RETAIN_OVERFLOW" }` | Never in practice — drop-oldest prevents this. Reserved for future non-drop-oldest modes. |

## Behavior

1. `GateOpenSchema.parse(request.body)` → either the parsed payload or throws `ZodError`.
2. On `ZodError`: log `warn { route: '/cockpit/gates', code: 'VALIDATION' }`, respond `400`.
3. Look up relay client via `getRelayClient()`:
   - If non-null AND `client.isConnected`: `client.send({ type: 'event', event: 'cluster.cockpit', data, timestamp })`. Respond `202 { accepted: true, retained: false }`.
   - Otherwise: `retainer.enqueue({ event: 'cluster.cockpit', data, timestamp, approxBytes })`. If enqueue reports `droppedCount > 0`, log `warn`. Respond `202 { accepted: true, retained: true, retainQueue: retainer.size() }`.
4. **Never** writes to disk — the answers file is answer-only.
5. **Never** blocks longer than the underlying `client.send()` — no awaits on I/O.

## Idempotency

**Not idempotent by design.** The MCP is responsible for not calling this twice for the same gate opening. If it does, the cloud upserts by `gateId` — no orchestrator-side dedup.

## Wire example (retained path)

Request:

```http
POST /cockpit/gates HTTP/1.1
Authorization: Bearer sk_cockpit_deadbeef…
Content-Type: application/json

{"kind":"gate-open","gateId":"g_01H…","generation":0,"scope":{"owner":"generacy-ai","repo":"generacy","issueNumber":1021},"openedAt":"2026-07-21T15:04:05.123Z","payload":{"question":"proceed?"}}
```

Response (relay disconnected):

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"accepted":true,"retained":true,"retainQueue":{"count":1,"bytes":186}}
```
