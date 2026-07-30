# Contract: `cockpit_gate_list`

**Kind**: MCP tool (thin HTTP client + bounded retry)
**Package**: `@generacy-ai/generacy` (`packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts`)
**Related**: [`cockpit_gate_status.md`](./cockpit_gate_status.md), [`gate-query.md`](./gate-query.md)

---

## Purpose

Ask the cloud: **for issue `X`, which gates are currently non-terminal?** Read-only. Primary sweep primitive per Q4 → B: the sweep uses this to skip drafting whenever any gate for `(issueRef, gateType)` is currently non-terminal, regardless of generation match. This is what kills the gen=1 cutover duplicate without permanent legacy-ID overhead or a cloud migration.

Non-terminal means cloud-status `open | answered | delivered`. Terminal statuses (`applied | superseded | failed | expired`) are excluded as history — a dead gate is not a live gate.

Project-wide scope: gates opened by *any* cluster in the project appear (per Q5 → A). Serial-cluster takeover sees the predecessor's gates.

---

## Input

MCP schema (`CockpitGateListInputSchema` in `mcp/schemas.ts`, re-exported from `mcp/gates/query-schemas.ts`):

```ts
z.object({
  issueRef: z.string().min(1),          // owner/repo#N
  gateType: GateTypeSchema.optional(),  // absent = all gate types
}).strict()
```

**Example**:

```json
{ "issueRef": "generacy-ai/generacy#1038", "gateType": "clarification" }
```

Or omit `gateType` to fetch all non-terminal gates on the issue.

---

## Output — success

`ToolOkResult<CockpitGateListData>`:

```json
{
  "status": "ok",
  "data": {
    "gates": [
      { "gateId": "12ab34cd56ef7890abcdef01", "gateType": "clarification",
        "generation": "abc123def456", "status": "open" },
      { "gateId": "34cd56ef7890abcdef011234", "gateType": "implementation-review",
        "generation": "def0f0e0d0c0", "status": "answered" }
    ]
  }
}
```

Optional `truncated: true` appears only if the cloud upstream paginated and this
call did not fetch subsequent pages (not in scope for the initial cut — flag
reserved for future pagination). Absence of the flag means "the list is
complete", not "false".

**Contract**:
- `gates[].status` is always `open` or `answered` (three-state per Q2 → C; terminal statuses excluded).
- `gates[].generation` is always emitted as a string. Numeric batchIds from cloud are coerced.
- Empty array = "no non-terminal gates for this issueRef (and optional gateType)" — this is a normal, expected success case, not an error.
- Order: implementation MAY sort by `gateType` then `generation` for stable output; the spec does not require a specific order (callers filter by their own criteria).

---

## Output — error

Same error classes as `cockpit_gate_status`:

| Class                | Trigger                                    |
|----------------------|--------------------------------------------|
| `invalid-args`       | Zod parse failed; orchestrator 400.        |
| `query-unreachable`  | Retry exhausted (5xx / network / timeout). |
| `internal`           | Bad JSON / envelope / unexpected 4xx.      |

Retry policy identical to `cockpit_gate_status` (see that contract).

---

## Sweep usage pattern (Q4 → B primary primitive)

The agency-side sweep uses this tool as the primary per-issue check:

```pseudo
for each (issueRef, gateType) in candidate list:
  result = cockpit_gate_list({ issueRef, gateType })
  if result.class === 'query-unreachable':
    abort scope's --gates=ui run                       # FR-014 / SC-007
  if result.gates.length > 0:
    skip drafting for this (issueRef, gateType)         # Q4 → B / SC-001
    continue
  # else: no non-terminal gates → proceed to draft + open as today
```

`cockpit_gate_status` remains available as a secondary primitive for callers
that already have a `generation` in hand (e.g. verifying a specific `gateId`
still matches before ack).

---

## Transport

HTTP `GET` to `${orchestratorUrl}/cockpit/gates?issueRef=<...>&gateType=<...>` (no `generation` param). Same base URL, timeout, and orchestrator route as `cockpit_gate_status`.

---

## Observer independence (FR-012 / SC-005)

`tools/cockpit_gate_list.ts` MUST NOT import any of the gate-mutation modules
listed in `cockpit_gate_status.md`. Enforced by the same static import-scan
test.

---

## Not covered by this tool

| Case                                                     | Handling                                       |
|----------------------------------------------------------|------------------------------------------------|
| Fetching full gate records (title/body/options)          | Use `cockpit_gate_open` (writer).              |
| Filtering by cluster (e.g., "only gates from THIS cluster") | Not supported — project-wide scope is fixed by Q5 → A. Callers filter client-side if truly needed. |
| Pagination                                               | Deferred. `truncated: true` flag reserved.     |
| Historical (terminal) gates                              | Excluded — Q5 → A.                             |
