---
"@generacy-ai/generacy": minor
"@generacy-ai/cockpit": minor
"@generacy-ai/cluster-relay": patch
---

Add read-only gate-status query surface for the Cockpit Remote Gates epic (#1038) and stabilise the clarification-batch `generation` derivation so sweep-side and live-side `gateId`s coalesce.

New public surface:
- `@generacy-ai/generacy` — two new MCP tools registered on the cockpit MCP server: `cockpit_gate_status` (single-gate lookup) and `cockpit_gate_list` (per-issue non-terminal list, project-wide). New orchestrator route `GET /cockpit/gates` with `mode=single|list` semantics; new `GateStatusQueryService` correlation-id dispatcher. No CLI twin.
- `@generacy-ai/cockpit` — new canonical hash for the clarification `generation` derivation. New public `ClarificationBatchQuestion` type. `deriveClarificationGeneration` now hashes the sorted list of `{questionNumber, questionText}` for question identity in the current unanswered batch.
- `@generacy-ai/cluster-relay` — additive envelope pair `gate_query_request` / `gate_query_response` on the `RelayMessage` discriminated union.

## Breaking changes

`@generacy-ai/cockpit` — `deriveClarificationGeneration` input shape changed:

Before:

```ts
deriveClarificationGeneration({ batchId: 'batch-abc123' });
```

After:

```ts
deriveClarificationGeneration({
  questions: [
    { questionNumber: 1, questionText: 'Which transport should we use?' },
    { questionNumber: 2, questionText: 'What is the retry budget?' },
  ],
});
```

The helper canonicalizes questions by sorting ascending on `questionNumber`, emitting each entry with a fixed key order (`questionNumber` then `questionText`), `JSON.stringify`, sha256, truncated to 24 hex chars. Sweep-side and live-side callers hash identical bytes for the same open batch across restart/takeover (SC-002 / INV-1). Callers that were producing a batch id string must switch to enumerating the batch's questions from durable GitHub state.
