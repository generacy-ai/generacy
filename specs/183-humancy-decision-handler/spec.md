# Feature Specification: Concrete HumanDecisionHandler for Humancy API

**Branch**: `183-humancy-decision-handler` | **Date**: 2026-02-15 | **Status**: Draft | **Parent Epic**: #182

## Summary

Implement a concrete `HumancyApiDecisionHandler` class that fulfills the existing `HumanDecisionHandler` interface in the workflow engine. This handler creates decision requests via the Humancy orchestrator's queue API, subscribes to SSE events for real-time resolution notifications, and maps responses back to the workflow engine's `ReviewDecisionResponse` format. When wired into the worker, this replaces the current simulation mode (auto-approve after 100ms) with real human-in-the-loop review.

## User Stories

### US1: Workflow Engine Requests Human Review via Humancy API

**As a** workflow engine executing a `humancy.request_review` step,
**I want** to create a decision in the Humancy queue and wait for a human response,
**So that** workflows can pause for real human review instead of auto-approving in simulation mode.

**Acceptance Criteria**:
- [ ] A `POST /queue` request is made to the orchestrator API when `requestDecision()` is called
- [ ] The `ReviewDecisionRequest` fields are correctly mapped to `DecisionQueueItem` fields (see FR-003)
- [ ] The handler waits for a `decision:resolved` SSE event matching the created decision ID
- [ ] The Humancy `DecisionResponse` is correctly mapped back to `ReviewDecisionResponse`
- [ ] The decision appears in the orchestrator's queue and is visible to human reviewers

### US2: Timeout and Error Handling

**As a** workflow engine,
**I want** the handler to respect the configured timeout and handle network failures gracefully,
**So that** workflows don't hang indefinitely and can recover from transient issues.

**Acceptance Criteria**:
- [ ] When the timeout expires before a response, a `CorrelationTimeoutError` is thrown
- [ ] Network errors during decision creation produce clear error messages
- [ ] SSE connection drops trigger automatic reconnection using `Last-Event-ID`
- [ ] The SSE connection is properly cleaned up on timeout, cancellation, or response receipt

### US3: Worker Configuration and Wiring

**As a** platform operator starting a worker,
**I want** the worker to automatically configure the Humancy handler when environment variables are set,
**So that** human review works without code changes, controlled purely by deployment config.

**Acceptance Criteria**:
- [ ] When `HUMANCY_API_URL` is set, the worker creates a `HumancyApiDecisionHandler` and injects it
- [ ] When `HUMANCY_API_URL` is not set, the worker falls back to simulation mode (existing behavior)
- [ ] `HUMANCY_AGENT_ID` is used for decision attribution
- [ ] The handler is injected via `HumancyReviewAction.setHumanHandler()` before workflow execution

### US4: Graceful Degradation

**As a** workflow engine,
**I want** the handler to fall back to simulation mode when the Humancy API is unreachable,
**So that** development and testing workflows aren't blocked by API unavailability.

**Acceptance Criteria**:
- [ ] If the initial POST to create a decision fails with a connection error, the handler falls back to simulated approval
- [ ] A warning is logged when falling back to simulation mode
- [ ] The fallback behavior is configurable (fail vs. simulate) via handler config

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `HumancyApiDecisionHandler` class implementing `HumanDecisionHandler` interface | P1 | New file: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts` |
| FR-002 | POST decision to orchestrator queue API (`POST /queue`) with mapped payload | P1 | Uses native `fetch()`, consistent with `OrchestratorClient` pattern |
| FR-003 | Map `ReviewDecisionRequest` to `DecisionQueueItem` create payload (see Type Mapping) | P1 | Critical for correct interop |
| FR-004 | Subscribe to orchestrator SSE endpoint (`GET /events`) filtered by decision ID | P1 | Listen for `decision:resolved` event matching the created decision's ID |
| FR-005 | Map `DecisionResponse` back to `ReviewDecisionResponse` on resolution | P1 | Map `response` field to `approved`/`decision`, `comment` to `input` |
| FR-006 | Enforce configurable timeout, throwing `CorrelationTimeoutError` on expiry | P1 | Use `AbortController` + `setTimeout` pattern |
| FR-007 | Clean up SSE connection on timeout, cancellation, success, or error | P1 | Prevent resource leaks |
| FR-008 | Handle SSE reconnection with `Last-Event-ID` header on connection drops | P2 | Leverage existing SSE event ID format: `{timestamp}_{connectionId}_{sequence}` |
| FR-009 | Wire handler into worker startup in `JobHandler` when env vars are present | P1 | Modify `job-handler.ts` or `worker.ts` to inject handler |
| FR-010 | Support `HUMANCY_API_URL` and `HUMANCY_AGENT_ID` environment variables | P1 | Optional `HUMANCY_AUTH_TOKEN` for authenticated environments |
| FR-011 | Fall back to simulation mode when Humancy API is unreachable | P2 | Configurable via `fallbackToSimulation` option (default: true) |
| FR-012 | Log decision lifecycle events (created, waiting, resolved, timeout, error) | P2 | Use `context.logger` pattern from existing actions |
| FR-013 | Export handler and config types from workflow-engine package | P1 | Update `packages/workflow-engine/src/actions/index.ts` exports |

## Technical Design

### Type Mapping

| Workflow Engine (`ReviewDecisionRequest`) | Orchestrator API (`DecisionQueueItem`) | Notes |
|---|---|---|
| `type: 'review'` | `type: 'review'` | Direct mapping |
| `title` | `prompt` | Orchestrator uses `prompt` field |
| `description` | `context.description` | Stored in context record |
| `options[].id` | `options[].id` | Direct mapping |
| `options[].label` | `options[].label` | Direct mapping |
| `options[].requiresComment` | `options[].description` | Map to description hint |
| `artifact` | `context.artifact` | Stored in context record |
| `workflowId` | `workflowId` | Direct mapping |
| `stepId` | `stepId` | Direct mapping |
| `urgency: 'low'` | `priority: 'when_available'` | Urgency-to-priority mapping |
| `urgency: 'normal'` | `priority: 'when_available'` | Normal maps to when_available |
| `urgency: 'blocking_soon'` | `priority: 'blocking_soon'` | Direct mapping |
| `urgency: 'blocking_now'` | `priority: 'blocking_now'` | Direct mapping |

### Response Mapping

| Orchestrator API (`DecisionResponse`) | Workflow Engine (`ReviewDecisionResponse`) | Notes |
|---|---|---|
| `response: true` | `approved: true` | Boolean response = approval |
| `response: 'approve'` | `approved: true, decision: 'approve'` | String response = option ID |
| `response: 'reject'` | `approved: false, decision: 'reject'` | Rejection case |
| `comment` | `input` | Reviewer's comment |
| `respondedBy` | `respondedBy` | Direct mapping |
| `respondedAt` | `respondedAt` | Direct mapping |

### Handler Configuration

```typescript
interface HumancyApiHandlerConfig {
  /** Base URL for the orchestrator API (e.g., http://localhost:3200) */
  apiUrl: string;
  /** Agent ID for decision attribution */
  agentId: string;
  /** Optional project ID for scoping decisions */
  projectId?: string;
  /** Optional auth token for API requests */
  authToken?: string;
  /** Whether to fall back to simulation on API failure (default: true) */
  fallbackToSimulation?: boolean;
  /** SSE reconnection delay in ms (default: 1000) */
  sseReconnectDelay?: number;
  /** Maximum SSE reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
}
```

### SSE Event Flow

1. Handler creates decision via `POST /queue` → receives `DecisionQueueItem` with `id`
2. Handler connects to `GET /events?channels=queue&workflowId={wfId}`
3. Handler listens for `queue:item:removed` event where `data.item.id` matches decision ID
4. On match → extract response from event data, map to `ReviewDecisionResponse`
5. On timeout → abort SSE connection, throw `CorrelationTimeoutError`
6. On SSE disconnect → reconnect with `Last-Event-ID` header (up to `maxReconnectAttempts`)

### Alternative: Polling Fallback

If SSE proves unreliable for long-running decisions, implement a polling fallback:
- Poll `GET /queue/:id` at increasing intervals (1s, 2s, 4s, ..., max 30s)
- Decision no longer in queue + response exists = resolved
- This is a P3 enhancement if SSE works reliably

### Files to Create

| File | Purpose |
|------|---------|
| `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts` | `HumancyApiDecisionHandler` class |
| `packages/workflow-engine/src/actions/builtin/humancy-api-handler.test.ts` | Unit tests |

### Files to Modify

| File | Change |
|------|--------|
| `packages/workflow-engine/src/actions/index.ts` | Export `HumancyApiDecisionHandler` and config type |
| `packages/generacy/src/orchestrator/job-handler.ts` | Create and inject handler when env vars present |
| `packages/generacy/src/cli/commands/worker.ts` | Pass Humancy config through to `JobHandler` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Decision creation succeeds | 100% when API is available | Integration test: POST returns valid DecisionQueueItem |
| SC-002 | SSE resolution detected | < 2s latency after human responds | Integration test: measure time from respond to handler return |
| SC-003 | Timeout enforcement | Within 1s of configured timeout | Unit test: verify CorrelationTimeoutError timing |
| SC-004 | Type mapping correctness | All fields mapped correctly | Unit tests for every urgency/priority combination |
| SC-005 | Graceful fallback | Simulation mode works when API down | Unit test: simulate connection refused → auto-approve |
| SC-006 | Resource cleanup | No SSE connection leaks | Unit test: verify connection closed after resolve/timeout/cancel |
| SC-007 | Worker wiring | Handler active when env vars set | Integration test: start worker with env vars, verify handler injected |

## Assumptions

- The orchestrator service (`packages/orchestrator`) is running and accessible at the configured URL when the handler is used in non-simulation mode
- The orchestrator's SSE events endpoint (`GET /events`) supports channel filtering via `?channels=queue` query parameter
- The `decision:resolved` workflow event or `queue:item:removed` SSE event is emitted when a decision is responded to via `POST /queue/:id/respond`
- The existing `DecisionQueueItem` schema accepts externally-generated `workflowId` and `stepId` values (not just orchestrator-managed workflow UUIDs)
- The orchestrator provides a `POST /queue` endpoint for creating decisions (or the existing `addDecision` method on the in-memory store needs a corresponding HTTP route)
- Native `fetch()` and `EventSource` (or manual SSE parsing via fetch streaming) are available in the Node.js runtime

## Out of Scope

- **Humancy UI changes**: The reviewer-facing UI for responding to decisions is not part of this feature
- **Decision escalation**: Automatic escalation when a decision times out (referenced in `HumanHandler` but deferred)
- **Multi-decision batching**: Creating multiple decisions in a single workflow step
- **Decision persistence**: The handler is stateless; if the worker restarts mid-wait, the decision is lost (checkpoint resume is a separate feature)
- **Authentication flow**: Obtaining auth tokens (OAuth, etc.) — assumes token is provided via environment variable
- **Orchestrator queue POST endpoint**: If `POST /queue` doesn't exist yet, creating that route is tracked as a prerequisite/dependency (see Dependencies)
- **Polling fallback implementation**: Alternative to SSE for unreliable connections (P3, only if SSE proves insufficient)
- **Retry logic for decision creation**: Automatic retry of failed POST requests (can be added later)

## Dependencies

- **Orchestrator `POST /queue` route**: The orchestrator currently has `GET /queue`, `GET /queue/:id`, and `POST /queue/:id/respond`, but may not have a `POST /queue` endpoint for _creating_ decisions from agent-side. If missing, this must be added as a prerequisite.
- **SSE event emission on respond**: The orchestrator must emit a `queue:item:removed` or `decision:resolved` SSE event when `POST /queue/:id/respond` is called. Verify this is wired in the event system.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Missing `POST /queue` endpoint | Medium | High - Blocks core functionality | Check orchestrator routes; create if needed as part of this feature or prerequisite |
| SSE connection instability for long waits (hours) | Medium | Medium - Decision may be missed | Implement reconnection with `Last-Event-ID`; consider polling fallback |
| Event ID mismatch between SSE event and decision ID | Low | High - Handler never resolves | Verify event data structure in integration tests |
| Worker restart during pending decision | Medium | Low - Decision orphaned in queue | Document as known limitation; checkpoint resume is out of scope |

---

*Generated by speckit*
