# Quickstart: Cockpit gates — read-only query + stable generation

Feature: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
Branch: `1038-issue-1038`

Aimed at two audiences:

1. **Implementers** working the tasks in `tasks.md` (once `/speckit:tasks` runs).
2. **Skill authors** wiring the agency-side sweep (generacy-ai/agency#450 —
   consumer of this repo's new MCP tools).

---

## What's new

Three additive changes:

1. Two new MCP tools on the cockpit MCP server:
   - `cockpit_gate_status({ issueRef, gateType, generation })`
   - `cockpit_gate_list({ issueRef, gateType? })`
2. One new orchestrator route: `GET /cockpit/gates`
3. One new pure helper in `@generacy-ai/cockpit`:
   `computeClarificationAnswerSetHash({ questions })`

Nothing existing changed signature. The write path (`cockpit_gate_open` /
`cockpit_gate_ack` / `POST /cockpit/gates` / `deriveGateKey` / `deriveGateId`)
is untouched.

---

## Installation (implementer)

Nothing to install. All new code lives inside three existing packages:

- `@generacy-ai/cockpit`
- `@generacy-ai/generacy`
- `@generacy-ai/orchestrator`

No new npm deps. Node built-ins (`fetch`, `node:https`, `node:crypto`) cover
transport + crypto.

### Build + test

```bash
pnpm install
pnpm --filter @generacy-ai/cockpit build test
pnpm --filter @generacy-ai/generacy build test
pnpm --filter @generacy-ai/orchestrator build test
```

### Changeset (CLAUDE.md gate)

Add before opening the PR:

```bash
pnpm changeset
# select:
#   @generacy-ai/cockpit          minor  (new public export: computeClarificationAnswerSetHash)
#   @generacy-ai/generacy         minor  (two new MCP tools + new ErrorClass member)
#   @generacy-ai/orchestrator     patch  (internal route + client, no public API change)
# Body: "Add read-only cockpit gate query (status/list) + durable clarification-gate
#        generation hash. Unblocks agency-side sweep (generacy-ai/agency#450)."
```

---

## Usage — MCP tools

### `cockpit_gate_status`

Ask: "Is this specific `(issueRef, gateType, generation)` gate open, answered,
or absent?"

```jsonc
// Input
{
  "issueRef": "generacy-ai/generacy#1038",
  "gateType": "clarification",
  "generation": "abc123def456"    // 12-hex hash from computeClarificationAnswerSetHash
}

// Success
{ "status": "ok",
  "data": { "gateId": "12ab34cd56ef7890abcdef01", "status": "open" } }

// Absent (no gate here — sweep may proceed to draft)
{ "status": "ok",
  "data": { "gateId": null, "status": "absent" } }

// Error (transport failure after 3 retries — DO NOT treat as absent)
{ "status": "error", "class": "query-unreachable",
  "detail": "orchestrator request timed out after 5000ms" }
```

### `cockpit_gate_list`

Ask: "Which non-terminal gates exist for this issue?"

```jsonc
// Input
{ "issueRef": "generacy-ai/generacy#1038", "gateType": "clarification" }
// or omit gateType to fetch all types:
{ "issueRef": "generacy-ai/generacy#1038" }

// Success — non-empty
{ "status": "ok",
  "data": {
    "gates": [
      { "gateId": "12ab...", "gateType": "clarification",
        "generation": "abc123def456", "status": "open" }
    ]
  } }

// Success — empty (no non-terminal gates)
{ "status": "ok", "data": { "gates": [] } }
```

### Sweep skip pattern (primary — Q4 → B)

```jsonc
// Skill pseudocode
const { data, ...err } = await callTool("cockpit_gate_list",
  { issueRef, gateType: "clarification" });
if (err.status === "error" && err.class === "query-unreachable") {
  abort("--gates=ui aborted — cloud gate store unreachable");
}
if (data.gates.length > 0) {
  skip("gate already open in cloud"); return;
}
draftAndOpenGate(...);
```

---

## Usage — `computeClarificationAnswerSetHash`

Both the agency sweep and any live-path code that opens a `clarification`
gate MUST go through this helper (SC-002 requires byte-identical output on
both sides).

```ts
import {
  computeClarificationAnswerSetHash,
  deriveClarificationGeneration,
  deriveGateKey,
  deriveGateId,
} from "@generacy-ai/cockpit";

// From the current unanswered clarification batch on the issue:
const questions = [
  { questionNumber: 1, questionText: "Which auth method?" },
  { questionNumber: 2, questionText: "Which DB?" },
];

const batchId    = computeClarificationAnswerSetHash({ questions });
const generation = deriveClarificationGeneration({ batchId });
const gateKey    = deriveGateKey("generacy-ai/generacy#1038", "clarification", generation);
const gateId     = deriveGateId(gateKey);

// gateId is now the deterministic identity for THIS unanswered batch of
// questions on THIS issue. Same questions → same gateId, regardless of
// whether the sweep or the live path derived it.
```

**Canonicalization** (locked by SC-002):

1. Sort ascending by `questionNumber`.
2. Project to `{ questionNumber, questionText }` only.
3. `JSON.stringify` → `sha256` → first 12 hex.

Callers MUST NOT include `answerText` or any other field — the helper's
projection strips them, but relying on the strip is fragile if a future
API change adds fields to the projected shape. Pass in exactly the two
canonical fields.

---

## Error classes cheat sheet

| Class                | When                                                 | What to do                                    |
|----------------------|------------------------------------------------------|-----------------------------------------------|
| (ok, `absent`)       | No matching gate. Legit "empty" answer.              | Sweep proceeds to draft + open.               |
| `invalid-args`       | Bad `issueRef` / `gateType`. Caller bug.             | Fix caller. Do not retry.                     |
| `query-unreachable`  | Cloud unreachable after ~5s bounded retry.           | Abort scope's `--gates=ui`. Retry after connectivity restored. |
| `internal`           | Route bug, bad JSON, unexpected 4xx.                 | File a bug. Do not retry.                     |

**Do NOT collapse `query-unreachable` to `absent`** — that re-introduces the
exact duplicate-drafting bug this feature exists to fix (FR-014 / SC-007).

---

## Running the two tools locally

```bash
# In one terminal — start the orchestrator (mock cloud if needed):
pnpm --filter @generacy-ai/orchestrator dev

# In another terminal — start the cockpit MCP over stdio:
pnpm --filter @generacy-ai/generacy exec generacy cockpit mcp

# From an MCP client (e.g. Claude Code):
#   Tool: cockpit_gate_status
#   Args: { "issueRef": "generacy-ai/generacy#1038",
#           "gateType": "clarification",
#           "generation": "abc123def456" }
```

Set `ORCHESTRATOR_URL` env var to override the default `http://127.0.0.1:3100`.

---

## Troubleshooting

### "cockpit_gate_status always returns absent"

Check the orchestrator's `/health` — if `cloudReady` is false, the query
client is failing to reach the cloud. The tool should be returning
`query-unreachable`, not `absent`. If you're seeing `absent`, look for a
bypass in the retry helper — the bug is in the retry-schedule wiring.

### "computeClarificationAnswerSetHash gives different results for the same questions"

Almost always a projection issue. If your caller passes richer objects
(e.g. with `answerText`, `askedAt`), those DO get stripped by the
projection at step 2 — but if the caller mutates the array *after* passing
it in, or passes a subclass with getters that mutate on read, the hash
observation may vary. Deep-freeze the input before passing:

```ts
const frozen = Object.freeze(questions.map(q => ({
  questionNumber: q.questionNumber, questionText: q.questionText,
})));
computeClarificationAnswerSetHash({ questions: frozen });
```

### "cockpit_gate_list returns terminal gates"

That's a spec violation — the orchestrator route is supposed to filter
terminal cloud statuses. Check `contracts/gate-query.md` § "List query
filter" and `packages/orchestrator/src/routes/cockpit-gates.ts` GET
handler. Any `status: 'applied' | 'superseded' | 'failed' | 'expired'`
in a list-mode response is a bug.

### "cockpit_gate_status returned status:'open' but the cloud shows delivered"

That's another spec violation — the collapse table in
`contracts/gate-query.md` says `delivered → answered`. Check the mapping
function in the orchestrator route.

---

## Follow-ups

- **generacy-ai/agency#450** — Wire the sweep to call
  `cockpit_gate_list`/`cockpit_gate_status` and remove the hardcoded
  `generation=1`. Consumer of this feature.
- **generacy-cloud companion PR** (epic 850) — Implement
  `GET /api/clusters/:id/cockpit/gates`. Wire contract in
  `contracts/gate-query.schema.json`; mirror lives at
  `specs/1020-part-cockpit-remote-gates/contracts/gate-query.schema.json`.
- **Optional**: pagination for `cockpit_gate_list`
  (`truncated: true` + `nextCursor`) if any project exceeds ~256 open
  gates. Not needed for the initial cut.
