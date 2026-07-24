# MCP tool contract: `cockpit_gate_status`

**Issue**: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
**Sibling of**: `cockpit_gate_open`, `cockpit_gate_ack`, `cockpit_gate_list`
**Data model**: [data-model.md §2](../data-model.md)

Cheap, body-free lookup that answers *"is a specific natural gate `(issueRef, gateType, generation)` currently open or already answered?"* against the cloud (Firestore) source of truth. Called by the `--gates=ui` startup sweep BEFORE the drafting subagent runs so already-pending gates are skipped without incurring an LLM round-trip.

---

## Purpose

Serves US1 (skip already-open gates without drafting) and US2 (restart-safe gate identity) as the *secondary* sweep primitive. `cockpit_gate_list` (see [contracts/cockpit_gate_list.md](./cockpit_gate_list.md)) is the primary primitive; this tool is used when the caller has a specific `generation` in hand and wants a targeted lookup (e.g. operator debugging a specific `gateId`, or the live path double-checking an ack).

---

## Registration (`mcp/server.ts`)

```typescript
server.registerTool(
  'cockpit_gate_status',
  {
    description:
      "Read-only lookup for a single natural gate. Returns {gateId, status:'open'|'answered'|'absent'} without requiring drafted title/body/options. Fails loud with class:'query-unreachable' on sustained cloud-query outage — NEVER returns 'absent' on transport failure.",
    inputSchema: CockpitGateStatusInputSchema,
  },
  async (args) => toCallToolResult(await cockpitGateStatus(args, deps)),
);
```

---

## Input — success

```json
{
  "issueRef": "generacy-ai/generacy#1038",
  "gateType": "clarification",
  "generation": "a3f9e2b1c4d5e6f7a8b9c0d1"
}
```

**Fields**:

| Field | Type | Required | Notes |
|---|---|---|---|
| `issueRef` | string | yes | `owner/repo#N`. Same form used at `cockpit_gate_open` time. |
| `gateType` | enum | yes | One of the 8 `GateType`s. See `data-model.md §1`. |
| `generation` | string \| number | yes | gateType-specific discriminator. For `clarification`, the sha256[:24] of the canonical question list. For `implementation-review`, the PR head SHA. |

**Strict schema** — extra fields on the input surface as `class: 'invalid-args'` (typos like `gate_type` don't silently coerce to something else).

---

## Output — success

```json
{
  "status": "ok",
  "data": {
    "gateId": "1a2b3c4d5e6f7a8b9c0d1e2f",
    "status": "open"
  }
}
```

**Fields**:

| Field | Type | Notes |
|---|---|---|
| `data.gateId` | string (24 hex) | Cluster-derived via `deriveGateId(deriveGateKey(...))` — NOT stamped by cloud. Must match the on-file gate id byte-for-byte (INV-1). |
| `data.status` | enum | `open`, `answered`, or `absent`. See `data-model.md §1` for cloud-enum → this-enum mapping. |

**`absent` semantics**: EITHER no gate exists with the given identity OR the gate exists but is in a terminal-negative state (`superseded`, `failed`, `expired`) — the sweep is free to re-draft in both cases (Q2→C).

---

## Output — error

Same envelope as every other cockpit MCP tool:

```json
{
  "status": "error",
  "class": "<one of ErrorClass>",
  "detail": "<human-readable>"
}
```

### Error class table

| `class` | When | Retryable by caller? |
|---|---|---|
| `invalid-args` | Missing `issueRef` / `gateType` / `generation`; unknown enum value; extra field. | No — caller bug. |
| `query-unreachable` | Bounded retry (~3 attempts / ~5s) exhausted without a `status: 'ok'` response from cloud. Includes: relay disconnected the whole window; per-attempt timeouts; cloud responder returning `status: 'error'` on every attempt. | Yes — sweep is expected to abort the current cycle and retry on the next auto-loop tick when the relay is likely to be up. |
| `internal` | Response payload from cloud fails Zod validation (e.g. missing `gateId`, wrong `status` enum). Considered a bug on the cloud responder side. | No — persistent shape failure indicates a version mismatch that operator intervention won't fix. |
| `transport` | Reserved for surprises the retry loop couldn't classify (e.g. `AbortError` from an unrelated abort). Typically not surfaced — the retry loop should collapse transport failures to `query-unreachable` terminally. | Yes — caller may retry. |

**Never returned**: `unknown-gate`, `wrong-kind`, `gate-refusal`, `claim-conflict`, `not-worker`, `contended`, `not-an-epic`, `invalid-cursor`, `scope-not-found`. If they appear, that's an internal bug — file a bug.

---

## Retry semantics (owned by `query-client.ts`)

Per FR-011 / R3:

- **Attempts**: 3.
- **Backoff**: 500ms → 1500ms → 3000ms with ±10% jitter.
- **Per-attempt timeout**: 5000ms (from `resolveGateOptions.timeoutMs`).
- **Total budget**: ~5s wall time from tool invocation to `query-unreachable` in the worst case.
- **Success criterion for a single attempt**: HTTP 200 from orchestrator AND the parsed response passes `GateStatusResponseSchema`.
- **Retryable failures**: HTTP 5xx from orchestrator (which itself surfaces relay-timeout / cloud-error); network errors; `AbortError` on timeout; response validation failure — treated as retryable within the loop, terminal after exhaustion.
- **Non-retryable failures**: HTTP 4xx from orchestrator — surfaces immediately as the corresponding `class` (rare; would indicate the orchestrator route rejected the request shape).

---

## Design invariants relevant here

- **INV-1** — `gateId` in the response equals the cluster-derived id. If the cloud returns a different id, that's a shape violation → `internal`.
- **INV-2** — Never returns `absent` on transport failure. Enforced in `query-client.ts` (the ONLY path that produces a `data` payload).
- **INV-6** — Query rides the same relay as `gate-open` / answers. No direct HTTPS.
- **INV-7** — No `title` / `body` / `options` in the input.

---

## Test coverage (unit)

Test file: `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit_gate_status.test.ts`

- Happy path — cloud returns `open` → tool returns `{ status: 'ok', data: { gateId, status: 'open' }}`.
- Happy path — cloud returns `absent` → same shape with `status: 'absent'`.
- `answered` mapping — cloud returns `applied` → tool returns `status: 'answered'`.
- `absent` mapping for terminal-negative — cloud returns `superseded` → tool returns `status: 'absent'`.
- Invalid input — missing `issueRef` → `class: 'invalid-args'`.
- Invalid input — extra field `foo: 'bar'` → `class: 'invalid-args'` (strict schema).
- Retry success — attempts 1+2 fail with 503, attempt 3 succeeds → tool returns `{status: 'ok', ...}`.
- Retry exhaustion — all 3 attempts fail with 503 → `class: 'query-unreachable'`.
- Never-`absent` guarantee — all 3 attempts network-error → `class: 'query-unreachable'` (NOT `data: { status: 'absent' }`).
- Response validation — cloud returns malformed payload (`{gateId: 'short'}`) → `class: 'internal'`.

---

## Non-goals

- No CLI twin `generacy cockpit gate-status` (R8).
- No caching. Every call round-trips.
- No pagination (single-row response).
- No auth beyond what the relay already brokers.
