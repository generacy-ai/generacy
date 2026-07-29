# Contract: MCP query schemas — widened for `runId`

**Issue**: [#1067](https://github.com/generacy-ai/generacy/issues/1067)
**File**: `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts`

## `CockpitGateStatusInputSchema`

**Accepted shape** (JSON):

```json
{
  "issueRef":   "owner/repo#42",
  "gateType":   "implementation-review",
  "generation": "abc123",
  "runId":      "auto-cluster-1067-1722243247891"
}
```

**Field spec**:

| Field       | Type                                        | Required | Notes                                                     |
|-------------|---------------------------------------------|----------|-----------------------------------------------------------|
| `issueRef`  | `string`, min length 1                      | yes      | Owner/repo#N or bare number (caller-normalised).         |
| `gateType`  | `GateTypeSchema` (8-value enum)             | yes      | Same enum as the write path.                             |
| `generation`| `string` (min 1) OR `number`                | yes      | gateType-specific discriminator (batchId hash, headSha…). |
| `runId`     | `string`, min length 1                      | no       | **NEW** — optional per-run discriminator. Omit for byte-compat with pre-#1067 callers. |

**Invariants**:
- Schema is `.strict()` — unknown fields fail with `invalid-args`.
- Schema is a flat `z.object({...}).strict()` — MUST NOT use `z.intersection` / `z.and` (would produce empty MCP `inputSchema.properties`; SC-006).
- `runId` value is opaque to the schema (any non-empty string) — validation of its semantic shape (e.g. `auto-*` prefix) is caller-owned.

**Byte-compat guarantee** (SC-002):
- With `runId` omitted, `.safeParse` returns exactly the pre-#1067 `data` shape (no `runId` property present).

## `CockpitGateListInputSchema`

**Accepted shape** (JSON):

```json
{
  "issueRef":  "owner/repo#42",
  "gateType":  "implementation-review",
  "runId":     "auto-cluster-1067-1722243247891"
}
```

**Field spec**:

| Field       | Type                              | Required | Notes                                                     |
|-------------|-----------------------------------|----------|-----------------------------------------------------------|
| `issueRef`  | `string`, min length 1            | yes      | Same as status.                                          |
| `gateType`  | `GateTypeSchema.optional()`       | no       | Absent = all types.                                      |
| `runId`     | `string`, min length 1            | no       | **NEW** — **ACCEPTED BUT NOT FORWARDED**. See below.     |

**Handler behaviour** (this is the load-bearing part of the contract):

The tool handler at `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts`:
1. Parses the input with the widened schema (accepts `runId` if present).
2. Does NOT include `runId` in the object passed to `client.listGates(...)`.
3. Does NOT emit the `runIdSource` log line (Q3=C).

**Why**: the deployed cloud contract at `generacy-cloud@192fca7c` (`services/api/src/routes/clusters/cockpit-gates.ts`) declares:

```ts
.refine((q) => q.runId === undefined || q.generation !== undefined, {
  message: 'runId requires generation'
})
```

List mode has no `generation` by construction. Forwarding `runId` on list produces a 400 RFC-7807 that breaks the sweep's primary dedup primitive (`auto.md:283`).

**Follow-up**: an operator use case "show me this run's gates" is real. File as a separate `generacy-ai/generacy-cloud` issue for a filter mode on the list route. Not in scope here.

## Error surfaces

Both tools return `{ status: 'error', class: 'invalid-args', detail }` when `.safeParse` fails. `detail` is a semicolon-joined list of Zod issue messages (unchanged behaviour).

## Test surface

- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-status.test.ts` — extended with widened-shape acceptance for status.
- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts` — extended with widened-shape acceptance for list.
- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-tuple-identity.test.ts` — new; asserts three-tool derivation identity.
- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit-gate-status-runid.test.ts` — new; asserts log-line shape.

## Non-goals

- `cockpit_gate_open` schema — untouched (already carries `runId` per #1053).
- `cockpit_gate_ack` schema — untouched (already carries `runId` per #1053).
- Error class names — unchanged.
- Retry policy — unchanged.
