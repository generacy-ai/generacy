---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": minor
"@generacy-ai/orchestrator": patch
---

Cockpit gates — read-only status query + stable sweep generation derivation (#1038).

Adds three additive pieces that jointly kill the sweep-duplicate bug in
`/cockpit:auto --gates=ui`:

1. **`@generacy-ai/cockpit`** (minor) — new pure helper
   `computeClarificationAnswerSetHash({ questions })`: canonical 12-hex hash of
   the sorted-by-`questionNumber` list of `{ questionNumber, questionText }`.
   Same round of asks → same `generation` → same `gateId`, regardless of
   whether the agency-side sweep or the live in-repo path derived it (SC-002).
   `deriveClarificationGeneration({ batchId })` signature unchanged; the new
   helper is additive.

2. **`@generacy-ai/generacy`** (minor) — two new read-only MCP tools on the
   cockpit MCP server:
   - `cockpit_gate_status({ issueRef, gateType, generation })` →
     `{ gateId, status: 'open' | 'answered' | 'absent' }`
   - `cockpit_gate_list({ issueRef, gateType? })` →
     `{ gates: [{ gateId, gateType, generation, status }], truncated? }`
   Both are thin HTTP clients over `GET /cockpit/gates`. Adds one new
   `ErrorClass` union member (`query-unreachable`), distinct from `transport`
   so the sweep's downstream dispatch can differ (abort vs. AskUserQuestion
   fallback). Retry policy: 3 attempts, 0/1500/3500 ms (≤5s total).

3. **`@generacy-ai/orchestrator`** (patch) — new `GET /cockpit/gates` route +
   `CloudGateQueryClient` (mirrors `packages/control-plane/src/services/cloud-pull-client.ts`).
   The route dispatches to the cloud via HTTPS + cluster API key, applies the
   seven-to-three cloud-status collapse, and the non-terminal filter for
   list-mode responses. Existing `POST /cockpit/gates` handlers untouched.

Unblocks the agency-side sweep (generacy-ai/agency#450) and the cloud-side
Firestore query endpoint (generacy-ai/generacy-cloud epic 850).
