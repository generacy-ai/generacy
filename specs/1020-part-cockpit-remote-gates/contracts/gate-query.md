# Contract: Orchestrator `GET /cockpit/gates` + cloud-side query

**Kind**: Fastify route + cluster→cloud HTTPS proxy
**Package**: `@generacy-ai/orchestrator`
**Files**:
- `packages/orchestrator/src/routes/cockpit-gates.ts` (extended — `POST` handlers unchanged)
- `packages/orchestrator/src/services/cloud-gate-query-client.ts` (NEW)
**Related**: [`cockpit_gate_status.md`](./cockpit_gate_status.md), [`cockpit_gate_list.md`](./cockpit_gate_list.md)

---

## Purpose

Serve the two MCP query tools by proxying to the cloud's Firestore-of-record
gate store. Applies:

1. **Query-shape dispatch**: presence of `generation` → status query; absence → list query.
2. **Seven-to-three cloud-status collapse** (Q2 → C).
3. **Non-terminal filter** for list queries (Q5 → A).

Cloud is the source of truth; the orchestrator is a stateless proxy (FR-004).

---

## Route signature

```text
GET /cockpit/gates
  ?issueRef=<owner/repo#N>        (required)
  &gateType=<one-of-8>            (optional; required if `generation` present)
  &generation=<discriminator>     (optional; presence switches to status mode)
```

### Query-string validation

```ts
export const GateQueryStringSchema = z
  .object({
    issueRef: z.string().min(1),
    gateType: GateTypeSchema.optional(),
    generation: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (v) => v.generation === undefined || v.gateType !== undefined,
    { message: 'gateType is required when generation is present' },
  );
```

Failures → HTTP 400 with `{ error: 'invalid-query', code: 'VALIDATION', details: [...] }` (matches the existing `POST /cockpit/gates` 400 shape from #1021).

---

## Cloud-status → MCP-facing collapse (Q2 → C, load-bearing)

Applied by the orchestrator route, **not** by the cloud or the MCP tool. The
cluster→cloud wire carries the seven-status vocabulary verbatim (useful for
future observability); the MCP surface stays stable.

| Cloud status | MCP-facing status | Notes                                                         |
|--------------|-------------------|---------------------------------------------------------------|
| `open`       | `open`            | Currently accepting operator answers.                         |
| `answered`   | `answered`        | Cloud recorded an answer; not yet delivered to cluster.       |
| `delivered`  | `answered`        | Answer sent down but not yet applied on cluster. Sweep MUST skip. |
| `applied`    | `answered`        | Applied on cluster (label written).                           |
| `superseded` | `absent`          | Terminal-negative. Sweep is free to re-draft.                 |
| `failed`     | `absent`          | Terminal-negative.                                            |
| `expired`    | `absent`          | Terminal-negative.                                            |
| (no match)   | `absent`          | No gate row in cloud Firestore.                               |

**Load-bearing note**: reporting `delivered` as `open` would cause the sweep to
re-draft an in-flight-answered gate (bad UX + duplicate risk). Reporting it as
`answered` correctly signals "skip this one".

---

## List query filter (Q5 → A)

For list queries (`generation` absent), the orchestrator route:

1. Requests non-terminal gates from cloud for `(projectId, issueRef, gateType?)`.
   - `projectId` is derived from `cluster.json` on the orchestrator side; cloud selects across all clusters in that project (serial-cluster takeover safe).
2. Cloud returns raw entries with the seven-status vocabulary.
3. Orchestrator drops entries whose cloud status is terminal (`applied | superseded | failed | expired`).
4. Orchestrator collapses `delivered → answered`, leaves `open` and `answered`, applies the response shape below.

---

## Response envelopes (HTTP 200)

### Status query

```json
{ "gateId": "12ab34cd56ef7890abcdef01", "status": "open" }
```

```json
{ "gateId": null, "status": "absent" }
```

### List query

```json
{
  "gates": [
    {
      "gateId": "12ab34cd56ef7890abcdef01",
      "gateType": "clarification",
      "generation": "abc123def456",
      "status": "open"
    }
  ],
  "truncated": false
}
```

`truncated` is optional. Absent = "list is complete". Set to `true` only if
the cloud upstream paginates and the orchestrator does not fetch further pages
(future work; not enabled in the initial cut).

---

## Non-2xx status codes

| Status | Cause                                                     | MCP-tool mapping   |
|--------|-----------------------------------------------------------|--------------------|
| 400    | Query-string validation failed.                           | `invalid-args`     |
| 502    | Cloud upstream unreachable (network / DNS / cloud 5xx).   | `query-unreachable` (after retry exhaustion in the MCP tool) |
| 500    | Route bug / cluster API key missing / unexpected 4xx from cloud. | `internal`         |

---

## Cluster → cloud HTTPS

**Client**: `packages/orchestrator/src/services/cloud-gate-query-client.ts` (new). Mirrors `packages/control-plane/src/services/cloud-pull-client.ts` in shape.

**Endpoint**:

```text
GET  ${GENERACY_API_URL}/api/clusters/${clusterId}/cockpit/gates
       ?issueRef=<...>&gateType=<...>&generation=<...>
```

**Auth**: `Authorization: Bearer <cluster-api-key>` (read from
`/var/lib/generacy/cluster-api-key`, mtime-cached — same pattern as
`packages/control-plane/src/services/cluster-api-key.ts`).

**Timeout**: 5000ms per request (via `AbortController`). No client-side retry
(retry lives in the MCP tool).

**`clusterId`**: read from `cluster.json` at boot; injected as a constructor
dep on the client.

---

## Cloud contract dependency

The cloud must implement the mirror endpoint:

```text
GET /api/clusters/:clusterId/cockpit/gates
    Authorization: Bearer <cluster-api-key>

Query:
  issueRef  — required
  gateType  — optional (required if generation present)
  generation — optional (status mode)

Response 200 (status mode):
  { gateId: string | null, status: "open" | "answered" | "delivered" | "applied"
                                    | "superseded" | "failed" | "expired" | null }
  (orchestrator applies the three-state collapse; cloud sends raw)

Response 200 (list mode):
  { gates: [ { gateId, gateType, generation, status } ], truncated?: boolean }
  (orchestrator filters terminal; cloud MAY pre-filter or send all)
```

Tracked in a companion generacy-cloud PR under epic 850. This spec's
`gate-query.schema.json` is the JSON Schema mirror the cloud consumer reads.

---

## Observability

- **Log fields on every call**: `issueRef`, `gateType`, `generation` (present/absent), `mode` (`status`|`list`), `cloudDurationMs`, `resultCount` (list mode), `mappedStatus` (status mode). No PII.
- **Metrics**: `cockpit_gate_query_duration_ms{mode}`, `cockpit_gate_query_errors_total{class}`.
- **Traces**: propagate the MCP call's request-id via `x-request-id` on the cluster→cloud HTTPS call.

---

## Idempotency & side effects

- **Idempotent**: identical requests always return identical (up-to-cloud-state) responses.
- **No side effects**: no writes, no cache updates, no gate mutations. Observer independence (FR-012).

---

## Non-goals

| Case                         | Handling                                                     |
|------------------------------|--------------------------------------------------------------|
| Local cache in orchestrator  | Explicitly not in scope (spec Assumption 2 + FR-004).        |
| Retries in the cloud client  | MCP tool owns retry (per plan D-2).                          |
| Backfill of legacy gen=1     | Handled by Q4 → B's list-based skip; no cloud migration.     |
| Fetching full gate records   | Not exposed — those flow via `cockpit_gate_open` write path. |
