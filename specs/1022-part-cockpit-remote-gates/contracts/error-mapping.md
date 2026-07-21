# Contract: HTTP → `ErrorClass` mapping

**Applies to**: both `cockpit_gate_open` and `cockpit_gate_ack`.

This is the canonical table for how the two gate tools translate an
orchestrator HTTP outcome into the `ToolResult` envelope's `class` field
(`packages/generacy/src/cli/commands/cockpit/mcp/errors.ts:15-27`).

Derived from spec clarifications **Q1 → A** (cloud-unavailability collapse to
`transport`) and **Q4 → B** (granular 4xx mapping).

---

## Canonical table

| Outcome                                                  | HTTP status | `ErrorClass`    | Rationale                              |
|----------------------------------------------------------|-------------|-----------------|----------------------------------------|
| 2xx success                                              | 200–299     | — (ok)          | Response body forwarded verbatim.      |
| Bad Request                                              | 400         | `invalid-args`  | Caller sent a malformed record.        |
| Unauthorized                                             | 401         | `internal`      | Auth is not a caller-visible concern.  |
| Forbidden                                                | 403         | `internal`      | Role/permission errors are internal.   |
| Not Found (gate id unknown on ack)                       | 404         | `unknown-gate`  | Existing `ErrorClass` union member.    |
| Method Not Allowed                                       | 405         | `internal`      | Route bug — not a caller-visible fix.  |
| Conflict (idempotent-conflict variant on open/ack)       | 409         | `invalid-args`  | Caller can retry with adjusted record. |
| Any other 4xx (410, 422, 429, ...)                       | 410–499     | `internal`      | Unexpected — surface message for debug.|
| Internal Server Error / Bad Gateway / Service Unavailable| 500–599     | `transport`     | Cloud path unavailable per Q1 → A.     |
| Network error (ECONNREFUSED, ENOTFOUND, EPIPE, ...)      | —           | `transport`     | Cloud path unavailable per Q1 → A.     |
| DNS resolution failure                                   | —           | `transport`     | Cloud path unavailable per Q1 → A.     |
| Request timeout (AbortController fires after default 5s) | —           | `transport`     | Cloud path unavailable per Q1 → A.     |
| Cluster not cloud-activated (any signal)                 | —           | `transport`     | Q1 → A: collapse both modes.           |
| 2xx response with non-JSON body                          | 200–299     | `internal`      | Orchestrator contract violation.       |
| 2xx response missing required envelope fields (open)     | 200–299     | `internal`      | Orchestrator contract violation.       |

---

## Ordering / dispatch rules

Client-side classification order in `gates/client.ts`:

1. If `fetch` throws (abort, network, DNS) → `transport`.
2. Else, on `Response`:
   1. If `res.ok` (2xx):
      - Parse body as JSON. Non-JSON → `internal`.
      - For `cockpit_gate_open`: assert `{ gateId: string, status: string }`. Missing → `internal`.
      - Return `ToolOkResult<T>`.
   2. Else, switch on `res.status`:
      - `400` → `invalid-args`
      - `404` → `unknown-gate`
      - `409` → `invalid-args`
      - Other 4xx (`>= 400 && < 500`) → `internal`
      - 5xx (`>= 500 && < 600`) → `transport`

---

## `detail` field extraction

For error responses with a body, `detail` is the first non-empty line of the
response body (matches the existing `firstLineOr` helper in `errors.ts:195`).

For network / abort errors, `detail` is `err.message` (or `String(err)` if the
thrown value is not an `Error`), first-line-trimmed.

For the timeout case specifically, `detail` is
`"orchestrator request timed out after <timeoutMs>ms"` (deterministic string
so callers/tests can match on it if needed).

---

## Why `transport` collapses both cloud-unavailability modes (Q1 → A)

The `/cockpit:auto` skill's fallback logic is:

```text
if (result.status === 'error' && result.class === 'transport') {
  askUserQuestion(fallbackFor(gateRecord));
} else if (result.status === 'error') {
  propagate(result);   // gate-refusal, invalid-args, etc.
} else {
  storeGateId(result.data.gateId);
}
```

A two-way distinction between "orchestrator unreachable" and "cluster not
cloud-activated" would produce identical downstream behavior — both trigger
the `AskUserQuestion` fallback. Introducing a `cloud-inactive` class would
create surface with no dispatch branch behind it (dead code).

---

## Why 404 uses the existing `unknown-gate` class

`unknown-gate` already exists in the `ErrorClass` union
(`errors.ts:18`, added by an earlier feature). Semantically it is exactly
"caller referenced a gate id we don't know about" — matches 404-on-ack. Reusing
it avoids expanding the union while preserving the semantic distinction from
`invalid-args` (which means "the shape of your request was wrong").

---

## Not covered by this table

| Case                       | Handling                                                     |
|----------------------------|--------------------------------------------------------------|
| Local Zod parse failure    | `invalid-args`, detail from Zod issues. Handled at handler top. |
| Cluster-role refusal       | Handled at `mcp/index.ts:40`; tool never invoked.            |
| Downstream retry logic     | Owned by `/cockpit:auto`, not this MCP tool boundary.        |
