# HTTP route contract: `GET /cockpit/gates`

**Issue**: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
**Sibling of**: `POST /cockpit/gates`, `POST /cockpit/gates/:id/ack`
**File**: `packages/orchestrator/src/routes/cockpit-gates.ts`
**Data model**: [data-model.md §2, §3, §5](../data-model.md)

Orchestrator HTTP route that backs both `cockpit_gate_status` and `cockpit_gate_list`. Delegates to `GateStatusQueryService`, which fan-outs to cloud (Firestore) over the existing relay as a `gate_query_request` envelope, then correlates the `gate_query_response` back to the pending request.

---

## Purpose

Bridges the MCP-side HTTP client (`gates/query-client.ts`) to the relay-side envelope pair (`gate_query_request` / `gate_query_response`). Keeps the correlation-id + retry logic on the cluster side so cross-repo failures (cloud responder down, cloud responder shape drift) surface here consistently.

---

## Request shape

### Query parameters

| Param | Required | Type | Notes |
|---|---|---|---|
| `issueRef` | yes | string | `owner/repo#N`. URL-encoded (`generacy-ai%2Fgeneracy%231038`). |
| `mode` | yes | `single` \| `list` | Selects the query mode; matches the envelope's `mode` field. |
| `gateType` | conditional | enum | REQUIRED when `mode=single`; OPTIONAL when `mode=list` (client-side filter). |
| `generation` | conditional | string | REQUIRED when `mode=single`. The gateType-specific discriminator, string-coerced (`123` and `"123"` treated identically). |

**Examples**:

```
GET /cockpit/gates?issueRef=generacy-ai%2Fgeneracy%231038&mode=single&gateType=clarification&generation=a3f9e2b1c4d5e6f7a8b9c0d1

GET /cockpit/gates?issueRef=generacy-ai%2Fgeneracy%231038&mode=list

GET /cockpit/gates?issueRef=generacy-ai%2Fgeneracy%231038&mode=list&gateType=clarification
```

### Body

None — pure `GET` request. Body is IGNORED if sent (Fastify default).

### Headers

Standard Fastify accept — no route-specific headers beyond the ones the relay adds server-side (actor identity, injected by the relay dispatcher when the request comes from cloud; not applicable when the request comes from the local MCP client, which is the only caller in v1).

---

## Response shape

### 200 — success (`mode=single`)

```json
{
  "gateId": "1a2b3c4d5e6f7a8b9c0d1e2f",
  "status": "open"
}
```

### 200 — success (`mode=list`)

```json
{
  "gates": [
    { "gateId": "1a2b3c4d5e6f7a8b9c0d1e2f", "gateType": "clarification", "status": "open" },
    { "gateId": "3f4e5d6c7b8a9012345abcde", "gateType": "implementation-review", "status": "answered" }
  ]
}
```

**`gates` may be empty** — returns 200 with `{gates: []}` when the issue has no non-terminal gates. Never 404 for "no results."

### 400 — invalid arguments

```json
{
  "error": "Missing required query parameter",
  "code": "VALIDATION",
  "details": { "missing": ["issueRef"] }
}
```

Or:

```json
{
  "error": "mode=single requires gateType and generation",
  "code": "VALIDATION",
  "details": { "mode": "single", "missing": ["gateType", "generation"] }
}
```

### 503 — sustained query-unreachable

```json
{
  "error": "Cloud gate-status query unreachable after 3 attempts",
  "code": "QUERY_UNREACHABLE",
  "details": { "attempts": 3, "lastError": "correlation-id timeout after 5000ms" }
}
```

**Semantically distinct from 500** — 503 tells the query-client's retry loop that the failure is retryable-at-caller (next auto-loop tick). Once the retry loop exhausts *its own* budget, the MCP tool maps this to `class: 'query-unreachable'` for the sweep.

### 500 — response shape violation from cloud responder

```json
{
  "error": "Cloud response failed validation",
  "code": "MALFORMED_RESPONSE",
  "details": { "issues": [ /* Zod issue list */ ] }
}
```

Non-retryable at the query-client level — surfaces as `class: 'internal'` for the MCP caller.

---

## Handler logic (sketch)

```typescript
// packages/orchestrator/src/routes/cockpit-gates.ts (new handler)

server.get('/cockpit/gates', async (request, reply) => {
  const q = request.query as Record<string, string | undefined>;

  // 1. Validate + branch.
  const issueRef = q.issueRef;
  const mode = q.mode;
  if (!issueRef || (mode !== 'single' && mode !== 'list')) {
    return reply.status(400).send({
      error: 'Invalid query parameters',
      code: 'VALIDATION',
      details: { required: ['issueRef', 'mode'] },
    });
  }
  if (mode === 'single' && (!q.gateType || !q.generation)) {
    return reply.status(400).send({
      error: 'mode=single requires gateType and generation',
      code: 'VALIDATION',
      details: { mode, missing: [
        ...(!q.gateType ? ['gateType'] : []),
        ...(!q.generation ? ['generation'] : []),
      ]},
    });
  }

  // 2. Delegate to service.
  const service = options.getQueryService();  // GateStatusQueryService
  try {
    if (mode === 'single') {
      const { gateId, status } = await service.querySingle({
        issueRef, gateType: q.gateType!, generation: q.generation!,
      });
      return reply.status(200).send({ gateId, status });
    } else {
      const { gates } = await service.queryList({
        issueRef,
        gateTypeFilter: q.gateType,  // may be undefined
      });
      return reply.status(200).send({ gates });
    }
  } catch (err) {
    if (err instanceof QueryUnreachableError) {
      return reply.status(503).send({
        error: err.message,
        code: 'QUERY_UNREACHABLE',
        details: { attempts: err.attempts, lastError: err.lastReason },
      });
    }
    if (err instanceof MalformedCloudResponseError) {
      return reply.status(500).send({
        error: err.message,
        code: 'MALFORMED_RESPONSE',
        details: { issues: err.issues },
      });
    }
    throw err;  // 500 fallthrough by Fastify default
  }
});
```

The handler is INTENTIONALLY thin — all correlation, retry-on-relay-side, timeout, and shape-validation live inside `GateStatusQueryService`.

---

## Service contract: `GateStatusQueryService`

**File**: `packages/orchestrator/src/services/gate-status-query.ts` (new).

**Public methods**:

```typescript
export interface QuerySingleInput {
  issueRef: string;
  gateType: string;   // narrowed to GateType internally
  generation: string;
}
export interface QuerySingleResult {
  gateId: string;
  status: 'open' | 'answered' | 'absent';
}

export interface QueryListInput {
  issueRef: string;
  gateTypeFilter?: string;  // client-side filter passthrough
}
export interface QueryListResult {
  gates: Array<{ gateId: string; gateType: string; status: 'open' | 'answered' }>;
}

export class GateStatusQueryService {
  constructor(deps: {
    getRelayClient: () => ClusterRelayClient | null;
    logger: Logger;
    /** Test-only override; defaults to node crypto.randomUUID. */
    generateCorrelationId?: () => string;
    /** Test-only override; defaults to 5000ms per attempt. */
    perAttemptTimeoutMs?: number;
  });

  querySingle(input: QuerySingleInput): Promise<QuerySingleResult>;
  queryList(input: QueryListInput): Promise<QueryListResult>;

  /** Route inbound gate_query_response to the pending promise. */
  onRelayMessage(msg: RelayMessage): void;
}
```

**Retry semantics** (orchestrator side — orthogonal to the query-client's retry):

The orchestrator's per-request handling is **single-attempt with per-attempt timeout**. The query-client (MCP-side) owns the outer retry loop. Rationale: putting retry on both sides doubles the wall time; the outer loop is authoritative because the sweep needs to observe partial-failure counts for its own scheduling.

- **Per-attempt timeout**: 5000ms (default). If the correlation id has no matching response in that window, reject with `QueryUnreachableError`.
- **Relay disconnected** at request time: reject immediately with `QueryUnreachableError` — do not queue (the query is stale-sensitive; retention would surface stale answers).
- **Cloud responded with `status: 'error'`**: reject with `QueryUnreachableError` carrying `lastReason = payload.error`.
- **Response validation failure**: reject with `MalformedCloudResponseError` (non-retryable at query-client).

**Correlation-id lifecycle**: on every `querySingle`/`queryList` call, generate a UUID, store `{ resolve, reject, timer }` in an internal `Map`, send the envelope. On matching inbound response, resolve; on timer expiry, reject. On process shutdown, reject all with a shutdown error. Orphaned entries are impossible by construction (both timeout and inbound handler `delete` the entry).

---

## Wiring in `server.ts`

- Instantiate `GateStatusQueryService` after the relay bridge is initialized.
- Register `service.onRelayMessage.bind(service)` with the relay bridge's inbound-message dispatcher (same seam that today handles `api_request` / `event` receipt).
- Pass `() => service` to the route setup options as `getQueryService`.

Sketch (informational — actual seam location is a task-phase detail):

```typescript
// packages/orchestrator/src/server.ts (existing initializeRelayBridge or sibling)
const gateStatusQuery = new GateStatusQueryService({
  getRelayClient: () => relayClientRef.current,
  logger: server.log,
});
relayBridge.onInboundMessage((msg) => {
  if (msg.type === 'gate_query_response') {
    gateStatusQuery.onRelayMessage(msg);
  }
});
setupCockpitGatesRoute(server, {
  retainer, getRelayClient, logger,
  getQueryService: () => gateStatusQuery,
});
```

---

## Test coverage

Test file: `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` (extended)

**Route-level**:
- `GET /cockpit/gates` missing `issueRef` → 400 with `code: VALIDATION`.
- `GET /cockpit/gates?mode=single&issueRef=…` missing `gateType` → 400.
- `GET /cockpit/gates?mode=list&issueRef=…` happy → 200 with `gates` array.
- `GET /cockpit/gates?mode=single&…` happy → 200 with `{gateId, status}`.
- `GET /cockpit/gates` when service throws `QueryUnreachableError` → 503 with `code: QUERY_UNREACHABLE`.
- `GET /cockpit/gates` when service throws `MalformedCloudResponseError` → 500 with `code: MALFORMED_RESPONSE`.

**Service-level** (`packages/orchestrator/src/services/__tests__/gate-status-query.test.ts`):
- Single-mode round-trip: `querySingle` sends the envelope with the right shape, receives correlated response, resolves.
- List-mode round-trip.
- Correlation-id mismatch: response arrives with unknown correlation id → dropped silently, original promise remains pending.
- Timeout: no response within `perAttemptTimeoutMs` → rejects with `QueryUnreachableError`.
- Relay disconnected: `getRelayClient()` returns null → immediate reject with `QueryUnreachableError`.
- Cloud error: response with `status: 'error', error: 'firestore down'` → rejects with `QueryUnreachableError` carrying `lastReason: 'firestore down'`.
- Malformed response: response missing `payload` → rejects with `MalformedCloudResponseError`.
- Concurrent requests: 3 in flight simultaneously with 3 distinct correlation ids all resolve on their own responses.

---

## Design invariants relevant here

- **INV-2** — Never returns success with an empty/absent placeholder on transport failure; 503 or 500 propagates.
- **INV-6** — Single transport: all cloud round-trips go through the relay client passed via `getRelayClient()`.
- **Idempotency of the route** — GET is safely repeatable; no side effects. The orchestrator does not memoize responses in v1.
