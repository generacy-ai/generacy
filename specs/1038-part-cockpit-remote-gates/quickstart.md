# Quickstart: gate-status query + stable clarification generation

**Issue**: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
**Companion**: [plan.md](./plan.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/)

Operator + integrator walkthrough for the new gate-status query. Ships with the same MCP server surface as the existing cockpit tools — no separate install.

---

## Prerequisites

- The cluster has been activated (`generacy up` or bootstrap wizard completed) and is currently connected to `generacy.ai`.
- A version of `@generacy-ai/generacy` that includes #1038 is deployed (check `orchestratorVersion` via `POST /health` on the orchestrator; a matching `@generacy-ai/generacy` npm package is installed for the CLI/MCP client).
- The generacy-cloud sibling PR is deployed. Without it, every query returns `class: 'query-unreachable'` after the retry loop; check the `/mcp` tool list and confirm cloud is at or past the version referenced in `plan.md`. The relay-envelope contract lives in [contracts/gate-query-relay-envelope.md](./contracts/gate-query-relay-envelope.md); until cloud responds, use the mocked-orchestrator unit tests for local development.

---

## Verifying installation

From inside Claude Code with the cockpit MCP server loaded (this happens automatically when the `generacy-ai/agency`'s cockpit plugin is active in your project):

1. Run `/mcp` in Claude Code. Both `cockpit_gate_status` and `cockpit_gate_list` MUST appear in the tool list (SC-004).
2. If either is missing, the `@generacy-ai/generacy` version is stale — bump `generacy` in the package that pins it, or run `npx generacy@latest` for the local install.

---

## Available MCP tools (new in #1038)

### `cockpit_gate_status` — single-gate lookup

Ask "is a specific natural gate `(issueRef, gateType, generation)` currently open, answered, or absent?" without incurring the cost of the drafting subagent.

```json
{
  "issueRef": "generacy-ai/generacy#1038",
  "gateType": "clarification",
  "generation": "a3f9e2b1c4d5e6f7a8b9c0d1"
}
```

Success response:

```json
{
  "status": "ok",
  "data": { "gateId": "1a2b3c4d5e6f7a8b9c0d1e2f", "status": "open" }
}
```

Full contract: [contracts/cockpit_gate_status.md](./contracts/cockpit_gate_status.md).

### `cockpit_gate_list` — per-issue non-terminal enumeration

Ask "what non-terminal gates exist for this issue right now, across the whole project?" — used by the `--gates=ui` sweep as its primary skip-drafting primitive.

```json
{ "issueRef": "generacy-ai/generacy#1038" }
```

Or filter to one gate type:

```json
{ "issueRef": "generacy-ai/generacy#1038", "gateType": "clarification" }
```

Success response:

```json
{
  "status": "ok",
  "data": {
    "gates": [
      { "gateId": "1a2b3…", "gateType": "clarification", "status": "open" },
      { "gateId": "3f4e5…", "gateType": "implementation-review", "status": "answered" }
    ]
  }
}
```

Empty list is legal and returns `{ status: "ok", data: { gates: [] } }` — NOT an error.

Full contract: [contracts/cockpit_gate_list.md](./contracts/cockpit_gate_list.md).

### Orchestrator route `GET /cockpit/gates`

The two MCP tools go through the orchestrator's new GET route. It's directly reachable at:

```
http://127.0.0.1:3100/cockpit/gates?issueRef=<url-encoded>&mode=list
http://127.0.0.1:3100/cockpit/gates?issueRef=<url-encoded>&mode=single&gateType=<t>&generation=<g>
```

Use it for orchestrator-adjacent tooling (e.g. custom dashboards); most callers should go through the MCP tool for consistent retry semantics + error class handling. Full contract: [contracts/get-cockpit-gates.md](./contracts/get-cockpit-gates.md).

---

## `deriveClarificationGeneration` — the new canonical hash

`@generacy-ai/cockpit` now exposes a helper that both the sweep path (agency) and the live path (this repo) call with the same input to produce the same `generation` bytes. **Breaking change** from the previous `{batchId}` shape.

### Before

```typescript
import { deriveClarificationGeneration } from '@generacy-ai/cockpit';

const gen = deriveClarificationGeneration({ batchId: 'batch-3' });
```

### After

```typescript
import { deriveClarificationGeneration } from '@generacy-ai/cockpit';

const gen = deriveClarificationGeneration({
  questions: [
    { questionNumber: 1, questionText: 'Which transport should we use?' },
    { questionNumber: 2, questionText: 'What is the retry budget?' },
  ],
});
// → 24-char sha256 prefix, deterministic across sweep + live paths
```

**Canonical form**: entries are sorted by `questionNumber` ascending, then serialized with fixed key order (`questionNumber` first, `questionText` second) before hashing. Drafted answers are DELIBERATELY excluded — multiple sweeps of the same open batch produce the same generation.

See [data-model.md §4](./data-model.md) for the full canonicalization rules.

### Migrating existing callers

If you passed `{batchId: '<something>'}`, you need to reconstruct the question list from the batch (parse the `<!-- generacy-stage:clarification -->` comment, or draw from whatever backing state carries the questions). If you were passing a synthetic id that had no relationship to question identity, you were probably drifting from the live path anyway — the new API forces alignment.

---

## Usage examples

### Example 1 — sweep-side skip-drafting (in agency, informational)

```typescript
// Pseudo-code — actual implementation ships in generacy-ai/agency
for (const issueRef of scopeIssues) {
  const list = await mcp.callTool('cockpit_gate_list', { issueRef });
  if (list.status === 'error') {
    if (list.class === 'query-unreachable') {
      // Cloud transiently down — abort this sweep cycle; auto-loop retries next tick.
      return abortSweepCycle();
    }
    // 'invalid-args' / 'internal' → red-loud; not the sweep's problem.
    throw new Error(`unexpected gate_list error: ${list.class}: ${list.detail}`);
  }
  const openByType = new Map(
    list.data.gates
      .filter((g) => g.status === 'open')
      .map((g) => [g.gateType, g.gateId]),
  );
  for (const gateType of naturalGatesForIssue(issueRef)) {
    if (openByType.has(gateType)) continue;  // skip drafting; save a subagent spawn
    await draftAndOpen(issueRef, gateType);
  }
}
```

Note: match is on `(issueRef, gateType)` prefix only — `generation` is intentionally ignored. This is what makes pre-existing `generation=1` gates suppress drafting during cutover.

### Example 2 — operator debugging a stuck scope from Claude Code

Type in Claude Code:

> Call cockpit_gate_list for issueRef "generacy-ai/generacy#1038" and show me what's open.

Claude invokes the MCP tool; the response arrives inline. Faster than opening the operator inbox web view for a single-issue debug.

### Example 3 — targeted status check after answering a specific gate

If you just answered a specific gate and want to confirm the ack propagated:

```json
{
  "issueRef": "generacy-ai/generacy#1038",
  "gateType": "clarification",
  "generation": "a3f9e2b1c4d5e6f7a8b9c0d1"
}
```

Expected `status`: `answered` (cloud has received the answer). If still `open`, the answer hasn't propagated yet — wait a tick and retry.

---

## Troubleshooting

### `class: 'query-unreachable'` on every call

**Symptom**: every `cockpit_gate_status` / `cockpit_gate_list` invocation returns `{ status: 'error', class: 'query-unreachable', detail: '…' }`.

**Diagnosis**:

1. Check relay connectivity — the orchestrator log will show `relay disconnected` / `relay handshake failed` if the underlying WebSocket is down.
2. Check cloud responder version — the generacy-cloud sibling that ships the `gate_query_request` handler MUST be deployed. If cloud is at an older version, the request will be received but no response will ever arrive → orchestrator times out → 503 → tool retries → all fail → `query-unreachable`.
3. Check orchestrator log for `code: QUERY_UNREACHABLE` entries — the `lastError` field carries the underlying reason (`timeout after 5000ms` / `firestore query timeout` / etc.).
4. Try the direct HTTP endpoint (bypasses MCP): `curl 'http://127.0.0.1:3100/cockpit/gates?issueRef=owner%2Frepo%231&mode=list'`. If this also hangs / 503s, the fault is orchestrator-side; if it returns 200, the fault is in the MCP client's retry loop or your tool call shape.

**Resolution**: fixing the transport layer (relay, cloud responder deploy). No config knob turns this off — fail-loud is intentional.

### `class: 'invalid-args'` on a call that used to work

**Diagnosis**: input shape drift. The strict Zod schema catches typos (`gate_type` vs `gateType`, extra fields, missing required fields). Check `detail` for the specific Zod issue path.

**Resolution**: match the schemas in [data-model.md §2](./data-model.md) or §3.

### `class: 'internal'` with `detail: 'orchestrator returned malformed …'`

**Diagnosis**: cloud responder shape drift. The cluster's Zod validation of the response is failing — cloud is returning a field of the wrong type or missing a required field.

**Resolution**: file a cross-repo bug against `generacy-ai/generacy-cloud`. The cluster-side is doing what the contract says; the cloud responder needs to align.

### `deriveClarificationGeneration` throws / returns unexpected hash

**Diagnosis**: with the new API, unexpected hashes come from question-list construction, not from the helper itself. Common causes:

- Duplicate `questionNumber` entries in the input array (helper does not enforce uniqueness).
- Whitespace differences in `questionText` between the sweep path and the live path (helper preserves whitespace verbatim; if one path trims and the other doesn't, hashes diverge).
- Different `questionText` for the same `questionNumber` between the two paths (e.g., one path uses the drafted-question wording, the other uses the raw operator-entered wording).

**Resolution**: make the sweep + live paths construct the array from the *same source of truth* (the durable `<!-- generacy-stage:clarification -->` batch comment on the issue). The parity fixture in `gates-generation.test.ts` commits a byte-identity reference — if that test passes and your call still drifts, the caller-side construction is not canonical.

### Sweep is still producing duplicate rows post-deploy

**Diagnosis**:

1. Confirm the sweep is calling `cockpit_gate_list` first (check the agency-side change is deployed — this is the paired PR).
2. Confirm the sweep is matching by `(issueRef, gateType)` prefix, NOT full `gateId`. The prefix match is what handles the cutover case; a full-`gateId` match will still see `generation=1` gates as absent.
3. Confirm cloud is not returning stale results — the query is uncached, so this should not happen; if it does, the responder needs invalidation review.

---

## Rollback

- **Rolling back the cluster** (revert `@generacy-ai/generacy` to a pre-#1038 version): the two MCP tools disappear from `/mcp`. The GET route returns 404. The sweep (still on the agency-side new version) will get `query-unreachable` (its call is unrecognized by the orchestrator) and abort each cycle — safer than the old duplicate-drafting behaviour.
- **Rolling back cloud** (revert the generacy-cloud sibling): every query returns `query-unreachable` — same as "cloud never got upgraded." Sweep aborts cleanly. No data corruption.
- **`deriveClarificationGeneration` shape change**: if agency-side callers didn't get updated in the same release, they will fail to compile / fail at runtime (missing `batchId` field). CI catches this in the paired PR; safe to hard-cut.

There is no cluster-side state that persists across the deploy — nothing to migrate on rollback.

---

## Next steps

- If you're the operator running `--gates=ui`: nothing to do — the sweep uses the new tools automatically as soon as both PRs (this repo + agency) are deployed.
- If you're extending the query surface: file a new issue and add to the same `mode` union rather than inventing a third relay envelope. Keeping request/response types small keeps the parser + validator hot path readable.
- If you're wiring a new caller: use the MCP tool, not the raw HTTP route — the tool's `class: 'query-unreachable'` mapping is the caller-visible contract; the HTTP 503 is the internal signal.
