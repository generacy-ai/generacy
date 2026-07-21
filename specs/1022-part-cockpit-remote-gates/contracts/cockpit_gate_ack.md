# Contract: `cockpit_gate_ack`

**Kind**: MCP tool (thin HTTP client)
**Package**: `@generacy-ai/generacy` (`packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.ts`)
**Related**: [`cockpit_gate_open.md`](./cockpit_gate_open.md), [`error-mapping.md`](./error-mapping.md)

---

## Purpose

Report the operator's decision for a previously-opened gate to the orchestrator
so it can propagate the outcome (label mutation, comment posting, phase
resume) back into the driving `/cockpit:auto` session's ledger.

Thin HTTP client — POSTs to `POST /cockpit/gates/:id/ack` and returns the
response verbatim.

---

## Wire contract source

The `outcome` enum, `detail` bounds, and orchestrator response body shape are
owned by the epic (see `cockpit_gate_open.md`'s "Wire contract source"
section).

---

## Input

MCP schema (`CockpitGateAckInputSchema` in `mcp/schemas.ts`):

```ts
z.object({
  gateId: z.string().min(1),
  outcome: z.string().min(1),
  detail: z.string().optional(),
}).strict()
```

**Interpretation**:

| Field    | Type              | Notes                                                |
|----------|-------------------|------------------------------------------------------|
| `gateId` | non-empty string  | Value returned by a prior `cockpit_gate_open` call.  |
| `outcome`| non-empty string  | Enum owned by epic; unknown values → orchestrator 400 → `invalid-args`. |
| `detail` | optional string   | Free-text elaboration; length bounds owned by orchestrator. |

`.strict()` means unknown keys are rejected at the tool boundary with
`class: 'invalid-args'` — this catches `gate_id` / `gateID` typos and forces
the caller to fix the key locally rather than confuse the orchestrator.

**Example**:

```json
{
  "gateId": "gate_01HK7Z...",
  "outcome": "approved",
  "detail": "batch 1 answers look correct"
}
```

---

## Output — success

`ToolOkResult<CockpitGateAckData>`:

```json
{
  "status": "ok",
  "data": <opaque orchestrator response body>
}
```

The response body shape is **not asserted** at this boundary. Whatever JSON
the orchestrator returns on 2xx is placed inside `data` unmodified. Callers
that need specific fields should coordinate on the epic contract.

Non-JSON 2xx response → `class: 'internal'`, detail `"orchestrator returned non-JSON ack response"`.

---

## Output — error

Same mapping as `cockpit_gate_open` — see [`error-mapping.md`](./error-mapping.md).

Notable case:

| Condition                                    | `class`         |
|----------------------------------------------|-----------------|
| HTTP 404 on `/cockpit/gates/:id/ack`         | `unknown-gate`  |

**Interpretation**: gate id was never issued, was already acked and garbage-
collected, or was invalidated by a superseding `generation`. The skill should
log and move on — this is not a transport failure.

---

## Idempotency

**Owned by orchestrator.** Replaying the same `{ gateId, outcome, detail }`
tuple is safe iff the orchestrator's ack route is idempotent. This tool
performs no local dedupe.

---

## Configuration

Same as `cockpit_gate_open` — see that contract's "Configuration" section.
Both tools share the `BuildMcpServerDeps` options bag.

---

## Worker refusal

**Inherited** from `mcp/index.ts:40` — same as every other cockpit MCP tool.

---

## Test surface (parity-gate-ack.test.ts)

| Case                                     | Expectation                                                   |
|------------------------------------------|---------------------------------------------------------------|
| Happy path 200 with JSON body            | `status: 'ok'`, `data` matches orchestrator body              |
| 2xx with non-JSON body                   | `class: 'internal'`                                            |
| Missing `gateId`                         | `class: 'invalid-args'`                                        |
| Missing `outcome`                        | `class: 'invalid-args'`                                        |
| Empty `gateId`                           | `class: 'invalid-args'`                                        |
| Extra key (e.g. `gate_id`)               | `class: 'invalid-args'` (strict-mode rejection)                |
| HTTP 400                                 | `class: 'invalid-args'`                                        |
| HTTP 404                                 | `class: 'unknown-gate'`                                        |
| HTTP 409                                 | `class: 'invalid-args'`                                        |
| HTTP 500                                 | `class: 'transport'`                                           |
| Network error                            | `class: 'transport'`                                           |
| Timeout                                  | `class: 'transport'`                                           |
| `detail` present + happy path            | `detail` field arrives in POST body verbatim (fetchImpl spy)   |
