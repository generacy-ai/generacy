# Clarification Questions

## Status: Pending

## Questions

### Q1: Missing POST /queue Endpoint — Scope Boundary
**Context**: The spec lists `POST /queue` (for creating decisions from the agent/worker side) as a dependency. The orchestrator currently has `GET /queue`, `GET /queue/:id`, `POST /queue/:id/respond`, and `GET /queue/stats`, but no `POST /queue`. The `InMemoryQueueStore.addDecision()` method exists but is marked "for testing" and has no corresponding HTTP route. This is a blocking prerequisite for the entire feature.
**Question**: Should creating the `POST /queue` endpoint in the orchestrator be included in *this* feature's scope, or should it be tracked as a separate prerequisite issue that must be completed first?
**Options**:
- A) Include in this feature: Add the `POST /queue` route to the orchestrator as part of this implementation, since it's small and tightly coupled to the handler.
- B) Separate prerequisite issue: Track it as a separate task/issue. This feature depends on it and should not start until it's done.
- C) Both — stub the endpoint in this feature with a TODO for full implementation in a dedicated orchestrator issue.
**Answer**:

### Q2: Handler Injection Pattern — Global Registry Problem
**Context**: `registerBuiltinActions()` creates `new HumancyReviewAction()` *without* a handler and registers it in a global module-level registry. The `JobHandler` calls `registerBuiltinActions()` but has no reference to the `HumancyReviewAction` instance to call `setHumanHandler()` on it. The spec says to use `HumancyReviewAction.setHumanHandler()` but doesn't address how to retrieve the already-registered instance from the global `actionRegistry`.
**Question**: How should the `JobHandler` obtain the registered `HumancyReviewAction` instance to inject the `HumancyApiDecisionHandler` into it?
**Options**:
- A) Use `getActionHandlerByType('humancy.request_review')` to retrieve the instance from the registry, cast it to `HumancyReviewAction`, and call `setHumanHandler()`.
- B) Modify `registerBuiltinActions()` to accept an optional config/handler map, so the handler can be passed during registration.
- C) Skip `registerBuiltinActions()` for this action — create the `HumancyReviewAction` with the handler in the constructor and register it separately in the `JobHandler`.
**Answer**:

### Q3: SSE Event Matching — `queue:item:removed` vs `decision:resolved`
**Context**: The spec mentions two different SSE event names: `decision:resolved` (in US1 acceptance criteria and FR-004) and `queue:item:removed` (in the SSE Event Flow section and the actual codebase). The codebase only defines `queue:item:added`, `queue:item:removed`, and `queue:updated` — there is no `decision:resolved` event type. Additionally, the `queue:item:removed` event contains `data.items` (array) and `data.item` (first item) but does *not* contain the `DecisionResponse` with the reviewer's comment/response — it only contains the original `DecisionQueueItem`.
**Question**: Which SSE event should the handler listen for, and how should it obtain the full decision response (including reviewer comment and response)?
**Options**:
- A) Listen for `queue:item:removed`, then immediately `GET /queue/:id` to fetch the response separately (two-step: SSE notification + REST fetch).
- B) Modify the orchestrator to include the `DecisionResponse` in the `queue:item:removed` event data.
- C) Add a new `decision:resolved` event type to the orchestrator that includes the full `DecisionResponse`.
**Answer**:

### Q4: WorkflowId Format Mismatch
**Context**: The orchestrator's `DecisionQueueItem` schema validates `workflowId` as `z.string().uuid()`, but the `HumancyReviewAction` generates workflow IDs in the format `wf_{sanitized_name}_{uuid_prefix}` (e.g., `wf_my_workflow_a1b2c3d4`), which is not a valid UUID. This means a `POST /queue` request from the handler would fail Zod validation on the orchestrator side.
**Question**: How should the workflowId mismatch be resolved?
**Options**:
- A) Change the handler to generate a proper UUID for `workflowId` when posting to the orchestrator, storing a mapping if needed.
- B) Relax the orchestrator's `workflowId` validation from `z.string().uuid()` to `z.string()` to accept any string format.
- C) Change `HumancyReviewAction` to use proper UUIDs as workflow IDs (breaking change to checkpoint format).
**Answer**:

### Q5: Authentication for Worker-to-Orchestrator Requests
**Context**: The orchestrator's queue routes use `requireRead('queue')` and `requireWrite('queue')` middleware, which requires either an API key or JWT with appropriate scopes (e.g., `queue:write`). The spec mentions an optional `HUMANCY_AUTH_TOKEN` env var but doesn't specify how this token is obtained or what type it is (API key vs JWT). The `OrchestratorClient` already supports `Bearer` token auth.
**Question**: What authentication mechanism should the `HumancyApiDecisionHandler` use when calling the orchestrator's queue API?
**Options**:
- A) Reuse the existing `OrchestratorClient`'s auth token (already configured in the worker) — no separate auth needed.
- B) Use a dedicated `HUMANCY_AUTH_TOKEN` API key with `queue:write` scope, separate from the worker's general auth.
- C) Support both: prefer `HUMANCY_AUTH_TOKEN` if set, fall back to the `OrchestratorClient`'s existing token.
**Answer**:

### Q6: Fallback Scope — Which Errors Trigger Simulation Fallback?
**Context**: US4 says to fall back to simulation mode when the "Humancy API is unreachable" (connection error). FR-011 says "when Humancy API is unreachable". But it's unclear whether only network-level errors (connection refused, DNS failure) should trigger fallback, or also HTTP errors (401 Unauthorized, 500 Internal Server Error, 422 Validation Error). For example, a 401 likely means misconfiguration (should fail loudly), while a 503 might mean temporary unavailability (could fallback).
**Question**: Which error conditions should trigger the simulation fallback?
**Options**:
- A) Only network-level errors (connection refused, DNS failure, timeout on connect) — any HTTP response (even 5xx) should be treated as a real error.
- B) Network errors plus server errors (5xx) — but not client errors (4xx), which indicate misconfiguration and should fail loudly.
- C) All errors when `fallbackToSimulation` is true — any failure to create the decision results in simulated approval, regardless of cause.
**Answer**:

### Q7: SSE Connection Lifecycle — Connect Once or Per-Decision?
**Context**: The spec describes connecting to SSE per-decision (create decision → connect to SSE → wait → disconnect). But SSE connections are relatively expensive to establish, and if a worker handles multiple sequential decisions, it might be more efficient to maintain a persistent SSE connection. Additionally, the spec mentions `GET /events?channels=queue&workflowId={wfId}`, but the workflowId changes per decision, meaning a persistent connection would need broader filtering.
**Question**: Should the handler create a new SSE connection per decision request, or maintain a persistent connection?
**Options**:
- A) Per-decision connection: Connect when `requestDecision()` is called, disconnect when resolved/timed-out. Simpler, no shared state.
- B) Persistent connection: Maintain one SSE connection per handler instance, filter events client-side by decision ID. More efficient for frequent decisions.
**Answer**:

### Q8: Response Mapping — Boolean `true`/`false` vs String Option IDs
**Context**: The spec's response mapping shows `response: true` → `approved: true` and `response: 'approve'`/`'reject'` → string option mapping. But the `DecisionResponse.response` type is `z.union([z.string(), z.boolean(), z.array(z.string())])`, which also allows an array of strings (for multi-select decisions). The `ReviewDecisionResponse` has no field for array responses. Also, the spec doesn't define how to determine `approved` when the response is an arbitrary string that is neither `'approve'` nor `'reject'` (e.g., what if options are `'revise'` and `'escalate'`?).
**Question**: How should non-standard response values be mapped to `ReviewDecisionResponse.approved`?
**Options**:
- A) Only the first option ID (by order in the original request) maps to `approved: true`; all other option IDs map to `approved: false`. The `decision` field always carries the raw option ID.
- B) Treat boolean responses as approval/rejection; string responses always set `approved: undefined` and only populate the `decision` field, letting the workflow logic interpret the meaning.
- C) Use a configurable approval-option mapping: the request specifies which option IDs count as "approved" (e.g., via a new field or convention like the first option = approve).
**Answer**:

### Q9: Timeout Value — Handler Timeout vs Step Timeout
**Context**: The `requestDecision()` method receives a `timeout` parameter from the `HumancyReviewAction`, which defaults to 24 hours (`DEFAULT_REVIEW_TIMEOUT`). The spec also mentions a configurable timeout in the handler config (`sseReconnectDelay`, `maxReconnectAttempts`) but doesn't mention whether the handler should enforce its own maximum timeout independent of the per-call timeout. For very long timeouts (24h), SSE connections may be unreliable.
**Question**: Should the handler enforce a maximum timeout cap regardless of the per-call timeout value, or trust the caller's timeout entirely?
**Options**:
- A) Trust the caller's timeout entirely — the handler simply uses whatever timeout is passed in `requestDecision()`.
- B) Enforce a handler-level `maxTimeout` config (e.g., default 1 hour) that caps the per-call timeout, with a warning log if the caller's timeout exceeds it.
**Answer**:

### Q10: ExpiresAt Field — Decision Expiration
**Context**: The `DecisionQueueItem` schema has an `expiresAt` field (`z.string().datetime().nullable().optional()`), and the `InMemoryQueueStore.respondToDecision()` checks expiration before allowing a response. The spec doesn't mention whether the handler should set `expiresAt` on the created decision based on the timeout parameter. If not set, a timed-out decision remains in the queue indefinitely, visible to reviewers who could respond after the handler has already thrown `CorrelationTimeoutError`.
**Question**: Should the handler set `expiresAt` on the created decision based on the timeout value?
**Options**:
- A) Yes — set `expiresAt` to `now + timeout` so the orchestrator auto-expires the decision and reviewers see it as expired.
- B) No — the handler manages timeout client-side only. The decision stays in the queue, and a stale response is silently ignored.
- C) Yes, but with a buffer — set `expiresAt` to `now + timeout + grace_period` (e.g., +5 minutes) to allow for clock drift and give reviewers slightly more time.
**Answer**:
