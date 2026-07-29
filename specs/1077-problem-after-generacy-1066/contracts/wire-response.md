# Contract: 202 response body — `frameId` echo (D6)

**Feature**: #1077
**Consumer**: `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts`
(via `GateOpenResponseSchema`) and `cockpit_gate_ack.ts` (via
`GateAckResponseSchema`).
**Producer**: `packages/orchestrator/src/routes/cockpit-gates.ts` — both POST
handlers.

## Response shape (both handlers)

On a successful mint (regardless of whether the frame emitted immediately or
was retained):

```json
{
  "accepted": true,
  "retained": <boolean>,
  "frameId": "frm_<24-hex>",
  "retainQueue": { "count": <int>, "bytes": <int> }   // only when retained=true
}
```

Existing 400 shape on validation failure is **unchanged** — no `frameId` on
error responses, mint is never attempted before the validation gate.

## Schema impact

- `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:215-217` —
  `GateOpenResponseSchema` already uses `.passthrough()`. **No schema change
  required**; the `frameId` field passes through and lands in
  `ToolOkResult.data.frameId` transparently. The tool at
  `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts:150-158`
  already spreads `envelope.data` into the caller-visible result; the new
  field appears automatically.
- `GateAckResponseSchema` is `z.record(z.unknown())`. Same story — passes
  through. Tool at
  `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.ts:56-63`
  returns `invokeGate`'s result verbatim; `frameId` surfaces to the caller.

## Guarantees

- **`frameId` is always present** on a 202 response — mint runs
  unconditionally before `tryEmitOrRetain`.
- **`frameId` value matches the value inside `data` on the outbound wire
  frame** — the route uses the same variable to build `emitData` and the
  response.
- **`retainQueue` remains conditional** on `retained === true` (unchanged).
- **No new fields** on the response beyond `frameId` — D2 rejects extending
  the ack shape into a delivery-channel surface.

## Non-guarantees (deliberate)

- The response does NOT tell the caller whether the frame was accepted or
  dropped by the cloud — that's what `cluster.cockpit.reply` is for, and D2
  says correlation is observability, not caller notification.
- The response does NOT include the timestamp used for the outbound relay
  frame (it can differ from the response timestamp; not needed by any caller).
- The response does NOT include the pending-map's expiry time — TTL is fixed
  at 30s and callers do not act on it.

## Test surface

- `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` — extend
  existing 202 assertions to check `body.frameId` matches
  `/^frm_[a-f0-9]{24}$/`.
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/__tests__/` (or
  equivalent) — a smoke test that `cockpit_gate_open()` surfaces the echoed
  `frameId` inside its `ToolOkResult.data`.
- `packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts`
  — assert the response's `frameId` equals the value observed on the outbound
  wire at the fake peer (pin the round-trip identity).
