# Contract: `cockpit_gate_open`

**Kind**: MCP tool (thin HTTP client)
**Package**: `@generacy-ai/generacy` (`packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts`)
**Related**: [`cockpit_gate_ack.md`](./cockpit_gate_ack.md), [`error-mapping.md`](./error-mapping.md)

---

## Purpose

Open a **remote gate** on the orchestrator so it can be surfaced in the
generacy.ai operator inbox and answered without blocking the driving
`/cockpit:auto` session.

This tool is a **thin HTTP client** — no local business logic. It POSTs the
caller's `gateRecord` to the orchestrator's `POST /cockpit/gates` route and
returns the orchestrator's response.

---

## Wire contract source

The **`GateRecord` shape, `gateId` generation rules, `status` enum, and NDJSON
answer-line format** are all owned by the epic:

> Full design and **wire contracts** (gate record, answer NDJSON line, outcome
> ack, gateId/generation rules):
> [`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md).
> Implement against the contracts as written; propose contract changes on the
> epic before diverging. (— spec § Summary)

This tool **does not redefine those contracts**. The local Zod schema uses
`.passthrough()` so unknown fields on the record are forwarded verbatim.

---

## Input

MCP schema (`CockpitGateOpenInputSchema` in `mcp/schemas.ts`):

```ts
z.record(z.unknown()).and(z.object({}).passthrough())
```

**Interpretation**: any JSON object. The tool does not enforce any specific
field on the record beyond "is a JSON object"; the orchestrator rejects
malformed records with HTTP 400.

**Example**:

```json
{
  "kind": "clarification-review",
  "scope": "generacy-ai/generacy#1022",
  "phase": "clarify",
  "generation": 1,
  "prompt": "Approve batch 1 answers?"
}
```

*(Exact field names and enum values live in the epic doc — see above.)*

---

## Output — success

`ToolOkResult<CockpitGateOpenData>`:

```json
{
  "status": "ok",
  "data": {
    "gateId": "<opaque-string>",
    "status": "open"
  }
}
```

Additional fields returned by the orchestrator (e.g. `coalescedWith`,
`inboxUrl`) are forwarded verbatim inside `data` via passthrough.

---

## Output — error

`ToolErrorResult` with one of the following `class` values:

| Condition                              | `class`         | `detail` source                                     |
|----------------------------------------|-----------------|-----------------------------------------------------|
| Input not a JSON object                | `invalid-args`  | Zod issues joined with `; `                          |
| Network error / DNS / ECONNREFUSED     | `transport`     | Underlying `fetch` error message (first line)        |
| Request timeout (default 5s)           | `transport`     | `"orchestrator request timed out after 5000ms"`      |
| HTTP 5xx from orchestrator             | `transport`     | Orchestrator's response body first line              |
| HTTP 400 from orchestrator             | `invalid-args`  | Orchestrator's response body first line              |
| HTTP 404 from orchestrator             | `unknown-gate`  | Orchestrator's response body first line              |
| HTTP 409 from orchestrator             | `invalid-args`  | Orchestrator's response body first line              |
| Any other 4xx                          | `internal`      | Orchestrator's response body first line              |
| 2xx response missing required fields   | `internal`      | `"orchestrator returned malformed gate-open response"` |
| Cluster not cloud-activated (any signal from orchestrator) | `transport` | Whatever the orchestrator returns; `transport` per Q1 → A |

**See** [`error-mapping.md`](./error-mapping.md) for the canonical mapping table
shared with `cockpit_gate_ack`.

---

## Idempotency

**Not idempotent.** Every call to `cockpit_gate_open` issues a new gate; the
orchestrator returns a fresh `gateId`. Callers wishing to coalesce duplicates
must let the orchestrator's contract handle it (see the epic's
`generation` / `coalesceKey` semantics).

---

## Configuration

Base URL and timeout resolve at handler-invocation time via
`resolveGateOptions(deps, env)`:

| Field           | Precedence                                                         | Default              |
|-----------------|--------------------------------------------------------------------|----------------------|
| `baseUrl`       | `deps.orchestratorUrl` → `process.env.ORCHESTRATOR_URL` → default  | `http://127.0.0.1:3100` |
| `timeoutMs`     | `deps.orchestratorTimeoutMs` → default                             | `5000`               |
| `fetchImpl`     | `deps.fetchImpl` → global                                          | `fetch`              |

Injected at `buildMcpServer(deps)` time via the extended `BuildMcpServerDeps`
interface.

---

## Worker refusal

**Inherited.** The MCP server-side entrypoint (`mcp/index.ts:40`) refuses to
start on containers where `GENERACY_CLUSTER_ROLE=worker`. The tool itself
performs no additional role check.

---

## Test surface (parity-gate-open.test.ts)

| Case                                   | Expectation                                                   |
|----------------------------------------|---------------------------------------------------------------|
| Happy path 200                         | `status: 'ok'`, `data.gateId` and `data.status` populated     |
| Passthrough field forwarded            | `data.inboxUrl` (or any extra key) present in result          |
| Input not an object                    | `status: 'error'`, `class: 'invalid-args'`                    |
| HTTP 400                               | `class: 'invalid-args'`                                        |
| HTTP 404                               | `class: 'unknown-gate'`                                        |
| HTTP 409                               | `class: 'invalid-args'`                                        |
| HTTP 401                               | `class: 'internal'`                                            |
| HTTP 500                               | `class: 'transport'`                                           |
| Network error (`fetchImpl` throws)     | `class: 'transport'`                                           |
| Timeout (AbortController fires)        | `class: 'transport'`, detail mentions timeout                  |
| 2xx with missing `gateId`              | `class: 'internal'`                                            |
