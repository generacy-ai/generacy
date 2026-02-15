# Research: HumancyApiDecisionHandler Technical Decisions

**Branch**: `183-humancy-decision-handler` | **Date**: 2026-02-15

## SSE Implementation

### Problem

The handler needs to listen for real-time events from the orchestrator's SSE endpoint (`GET /events?channels=queue`). The endpoint requires authentication via `Authorization: Bearer` header.

### Options Evaluated

1. **Native `EventSource` API**: Built into modern Node.js (v18+). Simple API: `new EventSource(url)`. **Problem**: Does not support custom headers. Cannot pass `Authorization` header. Workaround of passing token as query parameter would require orchestrator changes and is less secure.

2. **`eventsource` npm package**: Polyfill that supports custom headers. **Problem**: Adds an external dependency for a single use case.

3. **`fetch()` with streaming body**: Use native `fetch()` to make the SSE request, then read the response body as a `ReadableStream` via `getReader()`. Parse the SSE text protocol manually (`event:`, `data:`, `id:` lines). **Advantage**: No dependencies, full header control, consistent with the project's `OrchestratorClient` pattern using native `fetch()`.

### Decision

**Option 3: `fetch()` with streaming body**. This is consistent with the existing codebase (all HTTP communication uses native `fetch()`), requires no new dependencies, and gives full control over headers and connection lifecycle.

### SSE Parsing Implementation Notes

SSE text protocol format:
```
event: queue:item:removed
id: 1706123456789_conn_abc123_42
data: {"action":"removed","item":{"id":"..."},"queueSize":0}

```

Parsing rules:
- Lines starting with `event:` set the event type
- Lines starting with `data:` append to the data buffer (join with newline if multiple)
- Lines starting with `id:` set the last event ID (used for reconnection)
- Empty line = dispatch event
- Lines starting with `:` are comments (heartbeats)

The handler will implement a simple state-machine SSE parser on the streaming chunks.

## Response Fetching Strategy

### Problem

When a decision is responded to via `POST /queue/:id/respond`, the `InMemoryQueueStore.respondToDecision()` method:
1. Creates a `DecisionResponse` object
2. Stores it in `this.responses` map
3. Deletes the item from `this.queue` map
4. Returns the response

The `queue:item:removed` SSE event (created by `createQueueEvent('removed', ...)`) only includes the `DecisionQueueItem` — not the `DecisionResponse` with the reviewer's comment, response value, `respondedBy`, etc.

### Options

**A) Two-step: SSE notification + REST fetch**
- Listen for `queue:item:removed`
- Then `GET /queue/:id` to fetch response
- **Problem**: Item is deleted from queue on respond, so GET returns 404
- Would need a new `GET /queue/:id/response` endpoint that reads from the responses map

**B) Include response in SSE event data**
- Extend `QueueEventData` to include an optional `response: DecisionResponse` field
- When emitting the `queue:item:removed` event after `respondToDecision()`, include the response
- **Advantage**: Single source of truth, no race condition, no extra HTTP call
- **Disadvantage**: Slight schema change to SSE event types

**C) Add `decision:resolved` event**
- Create a new SSE event type `decision:resolved` with full response data
- Listen for this instead of `queue:item:removed`
- **Advantage**: Clean separation of concerns
- **Disadvantage**: New event type, more orchestrator changes

### Decision

**Option B: Include response in SSE event data**. This is the minimal change — one optional field added to `QueueEventData`. It avoids the race condition in Option A and is less invasive than Option C. The handler checks `data.response` on the matched event and falls back to extracting what it can from `data.item` if `response` is absent (backward compatibility).

## Clarification Decisions Detail

### Q1: POST /queue — Include in Feature

The `POST /queue` endpoint is a ~30-line route handler. It's blocked by nothing, blocks everything else, and is tightly coupled to the handler's payload format. Creating a separate issue adds overhead with no benefit. The orchestrator's `InMemoryQueueStore.addDecision()` already exists — we just need to expose it via HTTP.

### Q2: Handler Injection via Registry

The `getActionHandlerByType('humancy.request_review')` function returns the singleton `HumancyReviewAction` instance from the global registry. Casting to `HumancyReviewAction` and calling `setHumanHandler()` is the simplest approach. Alternative approaches (modifying `registerBuiltinActions()` signature, creating the action separately) would require more changes to existing code.

### Q3: SSE Event Matching — Revised

Originally planned as "listen for `queue:item:removed`, then GET response". Revised to "include response in SSE event data" after discovering the race condition (item deleted before GET). See "Response Fetching Strategy" above.

### Q4: WorkflowId Format — Relax Validation

`HumancyReviewAction` generates `wf_{sanitized_name}_{uuid_prefix}` (line 176 of `humancy-review.ts`). The orchestrator's `DecisionQueueItemSchema` requires `z.string().uuid()`. Relaxing to `z.string().min(1)` is the simplest fix. The orchestrator uses `workflowId` only for filtering/correlation — it doesn't need to be a UUID. Also need to update `QueueQuerySchema.workflowId` and the route schema.

### Q5: Authentication — Layered Approach

The handler supports three auth scenarios:
1. `HUMANCY_AUTH_TOKEN` set → use it (dedicated token with `queue:write` scope)
2. `ORCHESTRATOR_TOKEN` set → use it (worker's existing token)
3. Neither set → no auth header (development mode with auth disabled)

This matches the existing `OrchestratorClient` pattern (line 44: `this.authToken = options.authToken ?? process.env['ORCHESTRATOR_TOKEN']`).

### Q6: Fallback Scope — Network + 5xx

Error classification:
- **Network errors** (connection refused, DNS failure, fetch abort): Transient → fallback to simulation
- **5xx errors** (500, 502, 503, 504): Server issues → fallback to simulation
- **4xx errors** (400, 401, 403, 404, 422): Client/config issues → throw error (no fallback)

This ensures misconfiguration is caught early while transient issues don't block workflows.

### Q7: Per-Decision SSE — Simplicity

Decisions happen once per workflow step, typically minutes apart. A persistent SSE connection would require:
- Filtering events client-side (different `workflowId` per decision)
- Managing connection lifecycle across multiple `requestDecision()` calls
- Handling the case where the connection dies between decisions

Per-decision connections are simpler: connect → wait → disconnect. The connection setup overhead (~100ms) is negligible compared to human review time.

### Q8: First Option = Approved

`HumancyReviewAction` always creates options as:
```typescript
options: [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject', requiresComment: true },
]
```

The convention `approved = (response === options[0].id)` correctly maps `'approve'` → `approved: true` and `'reject'` → `approved: false`. If custom options are added later, the convention still works — the first option is the "positive" action.

For boolean responses: `true` → `approved: true`, `false` → `approved: false`. Simple and unambiguous.

### Q9: Trust Caller's Timeout

The `requestDecision()` method receives timeout from `HumancyReviewAction` (default 24h). The handler should not second-guess this value. If 24h is too long for SSE reliability, the handler's reconnection logic handles connection drops. Adding a handler-level cap would create confusing behavior where the caller expects 24h but gets cut off earlier.

### Q10: ExpiresAt with Buffer

Setting `expiresAt = now + timeout + 5 minutes` ensures:
- The orchestrator auto-expires the decision, cleaning up the queue
- Reviewers see the decision as expired if they arrive too late
- The 5-minute buffer accounts for clock drift between worker and orchestrator
- The handler's client-side timeout fires first (at `now + timeout`), so the handler always times out before the server expires the decision
