# Contract: `POST /cockpit/answers`

Relay-proxied inbound. The cloud pushes a `GateAnswer` through the relay's `api_request` channel; the cluster-relay dispatcher's `orchestratorUrl` fallback forwards it to the orchestrator on `127.0.0.1`.

## Request

- **Method / path**: `POST /cockpit/answers`
- **Auth**: `Authorization: Bearer <COCKPIT_INTERNAL_API_KEY>`. The relay injects headers received from the cloud; the cloud uses the same key the MCP uses (bootstrapped alongside `COCKPIT_INTERNAL_API_KEY` in the cluster). If the relay-proxied request lacks the header, `authMiddleware` returns `401`.
- **Content-Type**: `application/json`.
- **Body**: `GateAnswer` (see `data-model.md §1.3`).

Minimum required fields:

```jsonc
{
  "kind": "gate-answer",
  "deliveryId": "string",           // non-empty; dedup key
  "gateId": "string",
  "generation": 0,
  "answeredAt": "2026-07-21T…Z",
  "answer": "…"                     // passthrough
}
```

## Responses

| Status | Body | When |
|---|---|---|
| `200 OK` | `{ "accepted": true, "deduped": false }` | Appended a new line. |
| `200 OK` | `{ "accepted": true, "deduped": true }` | `deliveryId` already known — no write. |
| `400 Bad Request` | `{ "error": "Invalid gate-answer payload", "code": "VALIDATION", "details": [...] }` | Schema failed. **Nothing written.** |
| `401 Unauthorized` | `{ "error": "…", "code": "UNAUTHORIZED" }` | Middleware. |
| `503 Service Unavailable` | `{ "error": "answers-file writer not available", "code": "ANSWERS_FILE_UNAVAILABLE" }` | `writer.init()` failed at startup (e.g., `EACCES` on parent dir creation). |

## Behavior

1. `GateAnswerSchema.parse(request.body)` → payload or `ZodError`.
2. On `ZodError`: log `warn { route: '/cockpit/answers', code: 'VALIDATION', issues }`, respond `400`. **File untouched.**
3. `if (writer.hasDelivered(payload.deliveryId))`: respond `200 { accepted: true, deduped: true }`. **File untouched.** This is a fast path — the authoritative dedup check happens inside `append()` (step 4).
4. `await writer.append(payload)` → `{ deduped: boolean }`:
   - Take the writer's append mutex.
   - **Re-check `dedup.has(payload.deliveryId)` inside the mutex.** If already delivered (a concurrent request wrote the same `deliveryId` while this one was waiting on the mutex), release the mutex and return `{ deduped: true }` without writing. This closes the TOCTOU window between the route-level `hasDelivered()` fast path and the actual write.
   - Otherwise serialize as `JSON.stringify(payload) + '\n'`.
   - Single `fs.write(fd, buffer)` — no partial-line writes.
   - After the write, `dedup.add(payload.deliveryId)`.
   - Check size against rotation threshold; if exceeded, rotate under the same mutex (see `data-model.md §3.1`).
   - Release the mutex. Return `{ deduped: false }`.
5. Respond `200 { accepted: true, deduped }` using the value `append()` returned.

## Rotation triggered inline

Rotation runs **inside** the append critical section. The response comes back after rotation completes. A rotation is O(N) file renames (default N=3) — expected p99 well under 10ms on tmpfs / typical NVMe. If a caller experiences latency spikes correlated with rotation, this is the reason.

## Not idempotent by upstream retry

The cloud is expected to retry on `POST /cockpit/answers` if the relay drops the response mid-flight. The `deliveryId` dedup guarantees that a retry within the same run (or across a restart where the dupe is in the current file) is a no-op that responds `200 { deduped: true }`.

## Wire example

```http
POST /cockpit/answers HTTP/1.1
Authorization: Bearer sk_cockpit_deadbeef…
Content-Type: application/json

{"kind":"gate-answer","deliveryId":"dlv_01H…","gateId":"g_01H…","generation":0,"answeredAt":"2026-07-21T15:04:11.100Z","answer":{"choice":"proceed"}}
```

Response (fresh delivery):

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"accepted":true,"deduped":false}
```

Response (redelivery of the same `deliveryId`):

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"accepted":true,"deduped":true}
```
