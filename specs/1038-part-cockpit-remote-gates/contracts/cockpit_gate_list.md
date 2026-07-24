# MCP tool contract: `cockpit_gate_list`

**Issue**: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
**Sibling of**: `cockpit_gate_open`, `cockpit_gate_ack`, `cockpit_gate_status`
**Data model**: [data-model.md §3](../data-model.md)

Read-only enumeration of **all non-terminal gates** for a given `issueRef`. This is the **PRIMARY sweep primitive** (Q4→B / R4 / INV-5) — the sweep queries by `(issueRef, gateType)` prefix and skips drafting when any matching gate is currently `open`, regardless of `generation` match. This is what kills the pre-existing `generation=1` cutover duplicate without a cloud-side migration.

Also serves US3 — operator debugging via `/mcp` in Claude Code to see everything the auto-loop is waiting on for a given issue without inspecting Firestore directly.

---

## Registration (`mcp/server.ts`)

```typescript
server.registerTool(
  'cockpit_gate_list',
  {
    description:
      "Read-only list of all non-terminal (open|answered|delivered) gates for one issueRef, project-wide (predecessor-cluster takeover-safe). Returns [] on none — never throws. Primary sweep primitive: caller filters by gateType client-side and skips drafting when any match is currently 'open'.",
    inputSchema: CockpitGateListInputSchema,
  },
  async (args) => toCallToolResult(await cockpitGateList(args, deps)),
);
```

---

## Input — success

```json
{
  "issueRef": "generacy-ai/generacy#1038"
}
```

Or with an optional narrowing filter:

```json
{
  "issueRef": "generacy-ai/generacy#1038",
  "gateType": "clarification"
}
```

**Fields**:

| Field | Type | Required | Notes |
|---|---|---|---|
| `issueRef` | string | yes | `owner/repo#N`. |
| `gateType` | enum | no | Optional narrowing. In v1 the cluster performs this filter *client-side* on the response (the cloud responder returns all gate types). Present in the input to keep the shape stable if the cloud responder later grows a server-side predicate for payload-size optimization. |

**Strict schema** — extra fields surface as `class: 'invalid-args'`.

---

## Output — success

```json
{
  "status": "ok",
  "data": {
    "gates": [
      { "gateId": "1a2b3c4d5e6f7a8b9c0d1e2f", "gateType": "clarification", "status": "open" },
      { "gateId": "3f4e5d6c7b8a9012345abcde", "gateType": "implementation-review", "status": "answered" }
    ]
  }
}
```

**Fields**:

| Field | Type | Notes |
|---|---|---|
| `data.gates` | array | Possibly empty. Terminal-negative statuses (`superseded | failed | expired`) and `applied` (fully-terminal) are EXCLUDED. |
| `data.gates[].gateId` | string (24 hex) | Cloud-supplied. NOT re-derived — this endpoint does not know the `generation` values that produced each id. |
| `data.gates[].gateType` | enum | One of the 8 `GateType`s. |
| `data.gates[].status` | enum | `'open'` or `'answered'` (cloud `delivered` is collapsed into `answered` here, matching §1's mapping — the caller doesn't need to distinguish for the sweep's skip decision). |

**Empty-list semantics**: `data.gates = []` when no non-terminal gates exist for the issue. This is a success response — NOT an error, NOT an empty-throw (US3 acceptance criterion).

---

## Output — error

```json
{
  "status": "error",
  "class": "<one of ErrorClass>",
  "detail": "<human-readable>"
}
```

### Error class table

| `class` | When | Retryable? |
|---|---|---|
| `invalid-args` | Missing `issueRef`; unknown `gateType` enum value; extra field. | No. |
| `query-unreachable` | Bounded retry (~3 attempts / ~5s) exhausted without a valid response. | Yes — sweep aborts current cycle, retries next auto-loop tick. |
| `internal` | Response payload fails Zod validation (e.g. an item with `status: 'foo'`). | No — cloud responder version mismatch. |
| `transport` | Reserved (retry-loop escape hatch). | Yes. |

**Critical**: on `query-unreachable`, the tool NEVER returns `data.gates = []`. An empty list would tell the sweep "no gates exist" → sweep drafts everything → duplicate rows. The distinct error class is what forces the sweep to abort (INV-2, prevents the failure mode this feature is *fixing*).

---

## Retry semantics

Identical to `cockpit_gate_status` (see [cockpit_gate_status.md § Retry semantics](./cockpit_gate_status.md#retry-semantics-owned-by-query-clientts)). Both tools share the same `query-client.ts` retry loop; the constants and the fail-loud behaviour are pinned there.

---

## Scope semantics (INV-4 / Q5→A)

- **Non-terminal only**: `applied`, `superseded`, `failed`, `expired` are dropped server-side. Frees the sweep from filtering out history.
- **Project-wide**: gates opened by ANY cluster in the project are returned. A serial-cluster takeover MUST see the predecessor cluster's still-open gates — otherwise the takeover would re-draft everything. Cluster-scoped filtering would silently regress this.
- **`applied` treatment**: cloud may treat `applied` as terminal-fine (delivered + accepted). It is EXCLUDED from `cockpit_gate_list` (falls into the "history" bucket alongside terminal-negative), even though `cockpit_gate_status` for a specific `gateId` maps it to `answered`. Rationale: the sweep doesn't need to see applied gates (the gate is over); the single-lookup tool surfaces `answered` in case the caller was checking status of a specific ack decision.

---

## Sweep skip-drafting algorithm (informational)

The agency-side sweep (`generacy-ai/agency`, out of scope here) is expected to use this tool as follows:

```typescript
// pseudo-code — actual implementation lands in agency PR
for (const issueRef of scopeIssues) {
  const list = await mcp.call('cockpit_gate_list', { issueRef });
  if (list.status === 'error') {
    // 'query-unreachable' → abort this sweep cycle; auto-loop retries next tick.
    // 'invalid-args' / 'internal' → red-loud; not the sweep's problem.
    return abortSweepCycle(list);
  }
  const openByType = new Map(
    list.data.gates
      .filter((g) => g.status === 'open')
      .map((g) => [g.gateType, g.gateId]),
  );
  for (const gateType of naturalGatesToConsider(issueRef)) {
    if (openByType.has(gateType)) {
      logger.debug({ issueRef, gateType, gateId: openByType.get(gateType) },
                   'skip drafting — gate already open');
      continue;
    }
    // Only NOW does the drafting subagent run.
    await runDraftingSubagentAndOpen(issueRef, gateType);
  }
}
```

Note that the sweep matches only on `(issueRef, gateType)` prefix — the `generation` value is intentionally ignored for the skip decision (INV-5, cutover safety).

---

## Design invariants relevant here

- **INV-2** — Never returns `data.gates = []` on transport failure. Enforced in `query-client.ts`.
- **INV-4** — Non-terminal + project-wide.
- **INV-5** — Sweep-side algorithm filters by `(issueRef, gateType)` prefix; generation is not the sweep's skip key.
- **INV-6** — Same relay transport as gate-open and answers.
- **INV-7** — No `title` / `body` / `options` in input.

---

## Test coverage (unit)

Test file: `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit_gate_list.test.ts`

- Happy path — cloud returns 3 non-terminal gates → tool returns them all in order.
- Empty list — cloud returns `{gates: []}` → tool returns `{status: 'ok', data: {gates: []}}` (NO throw).
- Optional `gateType` filter — cloud returns 3 gates of mixed type → tool client-side filters to only the requested type.
- `answered` mapping — cloud row with `status: 'delivered'` → tool returns `status: 'answered'`.
- Invalid input — missing `issueRef` → `class: 'invalid-args'`.
- Invalid input — unknown `gateType` value → `class: 'invalid-args'`.
- Retry success — attempt 3 succeeds → tool returns the list.
- Retry exhaustion — all 3 attempts fail → `class: 'query-unreachable'`.
- Never-empty-list guarantee — all 3 attempts network-error → `class: 'query-unreachable'` (NOT `data: {gates: []}`).
- Response validation — cloud returns malformed item → `class: 'internal'`.

---

## Non-goals

- No CLI twin `generacy cockpit gate-list` (R8).
- No pagination (long-lived pathological issues are follow-up work).
- No terminal-status inclusion. If operators want a full-history view, that's a separate cloud-app feature.
- No caching.
