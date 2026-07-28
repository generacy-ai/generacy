# Contract: MCP tool input — `runId` on `cockpit_gate_open` / `cockpit_gate_ack`

**Feature**: #1053
**Component**: `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` (definition), `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` (re-exports).
**Consumers**: MCP-tool clients — primarily `/cockpit:auto` in `agency/packages/claude-plugin-cockpit`, secondarily ad-hoc LLM tool-use paths.

## Additions

### `GateOpenInputSchema` — new field

```ts
runId: z.string().min(1).optional()
```

### `GateAckInputSchema` — new field

```ts
runId: z.string().min(1).optional()
```

## Validation rules

- **Type**: `string`. Passing any non-string (`number`, `null`, object) is rejected with `class: 'invalid-args'` at the MCP boundary.
- **Non-empty**: `z.string().min(1)`. Empty string `""` is rejected with `class: 'invalid-args'`. Callers that want fallback behaviour MUST omit the field entirely, not pass empty string.
- **Optional**: `z.string().min(1).optional()`. Field MAY be absent. When absent, the tool's fallback logic runs — see below.
- **No default**: no `.default(...)`. Zod does not pre-fill the value; the tool observes `s.runId === undefined` directly to drive its fallback branch and its log line's `runIdSource` field.
- **`.strict()` schemas**: Both `GateOpenInputSchema` and `GateAckInputSchema` retain `.strict()` — unknown fields other than `runId` continue to reject as `invalid-args`.

## Tool-side semantics

### `cockpit_gate_open`

- When `s.runId !== undefined`: pass `s.runId` as the 4th argument to `deriveGateKey`. Log `runIdSource: 'explicit'`.
- When `s.runId === undefined`: mint `effectiveRunId = INSTANCE_NONCE` (module-level `crypto.randomBytes(8).toString('hex')` from `event-bus.ts:72`). Pass `effectiveRunId` as the 4th argument to `deriveGateKey`. Log `runIdSource: 'fallback-instance-nonce'`.
- Cache `askedAt` per DERIVED `gateId` in a module-level `Map` (see `data-model.md` E-4). On repeat calls for the same `gateId`, return the cached `askedAt` from the map even if the caller passes a different value. First-call semantics: if `s.askedAt` is provided, cache it; otherwise cache `new Date().toISOString()`.
- The wire record `gateKey` field contains the full string including `:${runId}` suffix. The wire record `runId` field does NOT exist (there is no such field on `GateOpenWireSchema` — see FR-010 / Q3-A).

### `cockpit_gate_ack`

- When `s.runId !== undefined`: accept the field, ignore its value. The ack path targets an existing `gateId` (already computed elsewhere); no derivation happens here.
- When `s.runId === undefined`: unchanged from pre-fix behaviour.
- The wire record `GateOutcomeWireSchema` is unchanged — no `runId` field on the ack wire either.

## Backwards compatibility

### Auto-loop callers (auto-run id explicit)

- Post-fix behaviour: fresh `runId` per run → fresh `gateId` per run → US1 satisfied.
- Within a run: same `runId` → same `gateId` → US2 satisfied.

### Non-auto callers (no `runId` passed)

- Post-fix behaviour: fallback `INSTANCE_NONCE` → `gateId` differs from pre-fix `gateId` for the same `(issueRef, gateType, generation)`. This is a **behaviour change**: a caller that previously got `075855bf...` for `christrudelpw/snappoll#1:phase-queue:P2` now gets a different id.
- Within an MCP-server process: same `INSTANCE_NONCE` → same `gateId` → within-process idempotency preserved.
- Across MCP-server restarts: fresh `INSTANCE_NONCE` → fresh `gateId` → NOT idempotent across process restarts for non-auto callers. This is acceptable because non-auto callers do not have a stable "run" identity — each MCP-server invocation IS a distinct run from the tool's perspective.

### Callers that pass unknown fields

- `.strict()` still rejects unknown fields other than `runId`. Callers must not have been passing `runId` before (it did not exist) — no risk of pre-existing collision.

## Log-line contract

`cockpit_gate_open` emits exactly one `info`-level log line per call, containing:

```json
{
  "event": "cockpit_gate_open.runid-source",
  "runIdSource": "explicit" | "fallback-instance-nonce",
  "gateId": "<24-hex>",
  "gateType": "<enum value>",
  "issueRef": "<owner/repo#N>"
}
```

- `runId` itself is NOT logged (embeds cluster/repo/issue/timestamp — noisy in aggregate).
- `gateId` IS logged (opaque 24-hex; useful for correlation with orchestrator and cloud logs).
- Log level `info` (not `debug`) — this is the source-of-truth signal for triage of "why did this gate open twice" incidents.

## Error surface

- All existing error classes on `ToolResult<GateOpenData>` / `ToolResult<GateAckData>` still apply.
- No new error class in this PR.
- `terminal-collision` error class arrives in the FR-004/005/007 follow-up PR — see `contracts/terminal-collision-error.md`.

## MCP `inputSchema.shape` reflection

The MCP transport reads `.shape` on the input schema (see gen#1032/#1033 for context). Because `GateOpenInputSchema` is a flat `z.object(...).strict()`, `.shape.runId` reflects as `z.string().min(1).optional()` in the tool's advertised schema — MCP clients discover the field via introspection. Same for `GateAckInputSchema.shape.runId`.
