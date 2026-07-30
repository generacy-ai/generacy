# Contract: `POST /cockpit/gates/:id/ack`

Orchestrator-side wire the in-cluster cockpit MCP calls when a gate is acknowledged (operator answered, timed out, or otherwise resolved).

## Request

- **Method / path**: `POST /cockpit/gates/:id/ack`
- **Auth**: `Authorization: Bearer <COCKPIT_INTERNAL_API_KEY>`.
- **Content-Type**: `application/json`.
- **Path param**: `:id` — the gateId. Non-empty; leading/trailing whitespace not permitted (Fastify default routing).
- **Body**: `GateAck` (see `data-model.md §1.2`).

Minimum required body fields:

```jsonc
{
  "kind": "gate-ack",               // exact literal
  "gateId": "string",               // OPTIONAL in body; MUST equal path :id when present
  "generation": 0,                  // int >= 0
  "outcome": "string",              // non-empty
  "ackedAt": "2026-07-21T…Z"        // ISO8601
  // "answer": passthrough, optional.
}
```

## Path/body merge

Before validation:

```typescript
const merged = { ...request.body, gateId: request.params.id };
```

If `request.body.gateId` was already set and differs from `request.params.id`, the merge overwrites — but the pre-check in the handler catches this case first and returns `400`:

```typescript
if (typeof request.body === 'object' && request.body !== null &&
    'gateId' in request.body &&
    request.body.gateId !== request.params.id) {
  return reply.status(400).send({
    error: 'gateId in body does not match path parameter',
    code: 'VALIDATION',
    details: { pathGateId: request.params.id, bodyGateId: request.body.gateId },
  });
}
```

Then `GateAckSchema.parse(merged)`.

## Responses

| Status | Body | When |
|---|---|---|
| `202 Accepted` | `{ "accepted": true, "retained": false }` | Sent on the relay. |
| `202 Accepted` | `{ "accepted": true, "retained": true, "retainQueue": {…} }` | Enqueued. |
| `400 Bad Request` | `{ "error": "…", "code": "VALIDATION", "details": [zod-issues…] }` | Body invalid or path/body mismatch. |
| `401 Unauthorized` | `{ "error": "…", "code": "UNAUTHORIZED" }` | Middleware. |

## Behavior

Same as `POST /cockpit/gates` after the path/body merge. The relay event's `data` is the parsed `GateAck` — the cloud discriminates open vs. ack on `data.kind`.

## Ordering with `/cockpit/gates`

Order is preserved on the relay by the FIFO retainer's insertion order (see `data-model.md §2.1`). A sequence like `open(A) → open(B) → ack(A) → ack(B)` posted during an outage replays in exactly that order on reconnect.

The orchestrator does **not** enforce open/ack causality — an ack for a `gateId` that was never opened (or was opened on a different orchestrator) is forwarded verbatim. The cloud decides what to do with it.

## Wire example

```http
POST /cockpit/gates/g_01H…/ack HTTP/1.1
Authorization: Bearer sk_cockpit_deadbeef…
Content-Type: application/json

{"kind":"gate-ack","generation":0,"outcome":"answered","ackedAt":"2026-07-21T15:04:11.900Z","answer":{"choice":"proceed"}}
```

Response:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"accepted":true,"retained":false}
```
