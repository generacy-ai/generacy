# Contract: `cockpit_gate_status`

**Kind**: MCP tool (thin HTTP client + bounded retry)
**Package**: `@generacy-ai/generacy` (`packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.ts`)
**Related**: [`cockpit_gate_list.md`](./cockpit_gate_list.md), [`gate-query.md`](./gate-query.md), [`generation-derivation.md`](./generation-derivation.md)

---

## Purpose

Ask the cloud: **is a gate with `(issueRef, gateType, generation)` currently open, already answered, or absent?** Read-only. Used by the `--gates=ui` startup sweep (agency-side, tracked in generacy-ai/agency#450) to skip re-drafting gates that are already open in the operator inbox.

The tool does not open, ack, retain, or otherwise mutate any gate (FR-012 / SC-005 — observer independence enforced by static import-scan test).

---

## Input

MCP schema (`CockpitGateStatusInputSchema` in `mcp/schemas.ts`, re-exported from `mcp/gates/query-schemas.ts`):

```ts
z.object({
  issueRef: z.string().min(1),                   // owner/repo#N
  gateType: GateTypeSchema,                      // 8-value enum
  generation: z.union([z.string().min(1), z.number()]),
}).strict()
```

**Example**:

```json
{
  "issueRef": "generacy-ai/generacy#1038",
  "gateType": "clarification",
  "generation": "abc123def456"
}
```

`generation` for `clarification` gates is the 12-hex output of `computeClarificationAnswerSetHash` (see `generation-derivation.md`). For `implementation-review` it is the PR head SHA (truncated at caller discretion). See the derivation contract for each gate type.

---

## Output — success

`ToolOkResult<CockpitGateStatusData>`:

```json
{
  "status": "ok",
  "data": { "gateId": "12ab34cd56ef7890abcdef01", "status": "open" }
}
```

Or:

```json
{ "status": "ok", "data": { "gateId": "12ab34cd56ef7890abcdef01", "status": "answered" } }
{ "status": "ok", "data": { "gateId": null, "status": "absent" } }
```

**Contract**:
- `status: 'open'` → cloud gate exists and is currently accepting operator answers.
- `status: 'answered'` → cloud gate has moved past `open` (cloud statuses `answered`, `delivered`, or `applied` — see `gate-query.md` mapping). The sweep should skip re-opening.
- `status: 'absent'` → **no matching gate** OR terminal-negative (`superseded`, `failed`, `expired`). The sweep is free to re-draft.
- `gateId: null` if and only if `status === 'absent'` (nullability is a load-bearing signal — FR-013).

---

## Output — error

`ToolErrorResult`:

```json
{ "status": "error", "class": "query-unreachable", "detail": "<last-attempt error>" }
```

### Error classes

| Class                | Trigger                                                                | Recovery                                                                                     |
|----------------------|------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| `invalid-args`       | Input Zod parse failed; orchestrator returned 400 (bad query string).  | Caller-side fix.                                                                             |
| `query-unreachable`  | Bounded retry exhausted (3 attempts, ~5s). Network / DNS / 5xx / cluster not activated. | Wait for connectivity; sweep aborts this scope's `--gates=ui` run. **MUST NOT be treated as `absent`** (FR-014 / SC-007). |
| `internal`           | 2xx with non-JSON body; 2xx missing envelope fields; unexpected 4xx.   | File a bug — indicates orchestrator/route mismatch.                                          |

**Divergence from `cockpit_gate_open`**: 5xx and network errors here map to `query-unreachable`, NOT `transport`. Distinct dispatch downstream (write-path uses `transport` to trigger `AskUserQuestion` fallback; read-path uses `query-unreachable` to abort the sweep).

---

## Retry policy

- **3 attempts total** (1 initial + 2 retries).
- Delays: `0ms → 1500ms → 3500ms` (total wall-clock budget ≤5000ms per Q3 → D).
- Retry triggers: `transport`-class error from the underlying HTTP client, HTTP 502/503/504, network errors (ECONNREFUSED, ENOTFOUND, EPIPE, AbortError from timeout).
- Retry does NOT trigger: 4xx (caller bug), 2xx-with-malformed-body (orchestrator bug), successful 2xx (obvious).
- Retry helper: `packages/generacy/src/cli/commands/cockpit/mcp/gates/retry.ts` (`QUERY_RETRY_SCHEDULE`, `withRetry`).

---

## Transport

HTTP `GET` to `${orchestratorUrl}/cockpit/gates?issueRef=<...>&gateType=<...>&generation=<...>`.

- `orchestratorUrl` resolved via `BuildMcpServerDeps.orchestratorUrl ?? process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100'` (same as #1022).
- Per-attempt timeout: 5000ms (via `AbortController`), overridable via `BuildMcpServerDeps.orchestratorTimeoutMs` (test-only).

Orchestrator route dispatches to cloud via HTTPS + cluster API key — see `gate-query.md`.

---

## Observer independence (FR-012 / SC-005)

`tools/cockpit_gate_status.ts` MUST NOT import:

- `mcp/gates/client.ts` (write-path HTTP client)
- `mcp/tools/cockpit_gate_open.ts`
- `mcp/tools/cockpit_gate_ack.ts`
- `packages/orchestrator/src/routes/retained-cockpit-events.ts`
- Anything else whose primary purpose is gate mutation or retention.

Enforced by `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts` (static import-scan; extended from #1015's pattern).

---

## Not covered by this tool

| Case                                                     | Handling                                            |
|----------------------------------------------------------|-----------------------------------------------------|
| Reserving a gate to prevent race with another opener     | Not a query concern; would violate FR-012.          |
| Fetching the full gate record (title/body/options)       | Use `cockpit_gate_open` (which is the writer).      |
| Sweep-side skip logic (which gateIds to compute)         | Owned by agency (generacy-ai/agency#450).           |
| Cloud-side Firestore reader                              | Owned by generacy-cloud (companion PR).             |
