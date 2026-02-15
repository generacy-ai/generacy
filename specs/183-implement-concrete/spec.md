# Feature Specification: Concrete HumanDecisionHandler for Humancy API

**Branch**: `183-implement-concrete` | **Date**: 2026-02-15 | **Status**: Draft
**Parent Epic**: #182

## Summary

The workflow engine defines a `HumanDecisionHandler` interface in `HumancyReviewAction` (`packages/workflow-engine/src/actions/builtin/humancy-review.ts`) that enables human-in-the-loop decision making during workflow execution. Currently, when no handler is configured, the action defaults to simulation mode (auto-approves after 100ms). This feature implements a concrete `HumancyApiDecisionHandler` that creates decisions via the orchestrator's decision queue API and waits for real human responses via a dual SSE + polling strategy.

## User Stories

### US1: Real Human Review in Workflows

**As a** workflow operator,
**I want** workflow review steps to create real decision requests in the orchestrator queue and wait for human responses,
**So that** humans can review artifacts, approve/reject actions, and provide input before workflows proceed.

**Acceptance Criteria**:
- [ ] When a workflow reaches a `humancy.request_review` step, a decision is created in the orchestrator queue via `POST /queue`
- [ ] The handler waits for a human response via SSE stream (`GET /queue/events`) with polling fallback
- [ ] The human's response (approve/reject/choose + optional comment) is mapped back to `ReviewDecisionResponse` and returned to the workflow engine
- [ ] The workflow resumes with the human's decision

### US2: Graceful Timeout Handling

**As a** workflow operator,
**I want** review requests to respect configurable timeouts,
**So that** workflows don't hang indefinitely waiting for human input.

**Acceptance Criteria**:
- [ ] The handler respects the `timeout` parameter passed by `HumancyReviewAction` (default: 24 hours)
- [ ] On timeout, a `CorrelationTimeoutError` is thrown (matching existing workflow engine error handling)
- [ ] The workflow engine's existing checkpoint/resume logic handles the timeout correctly

### US3: Resilient Connection Handling

**As a** workflow operator,
**I want** the decision handler to recover from network failures,
**So that** temporary connectivity issues don't cause workflows to fail.

**Acceptance Criteria**:
- [ ] SSE connection auto-reconnects with backoff on failure
- [ ] Polling provides a fallback when SSE is unavailable
- [ ] `Last-Event-ID` is used on SSE reconnection to avoid missing events
- [ ] Network errors during decision creation are propagated as actionable errors

### US4: Simulation Fallback

**As a** developer running workflows locally,
**I want** the system to fall back to simulation mode when no handler is configured,
**So that** I can test workflows without a running orchestrator.

**Acceptance Criteria**:
- [ ] When `ORCHESTRATOR_URL` is not set or handler instantiation fails, simulation mode is preserved
- [ ] No behavioral change for existing simulation-mode users
- [ ] Fallback is logged clearly so operators know which mode is active

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `HumancyApiDecisionHandler` class implementing `HumanDecisionHandler` interface | P1 | New file: `packages/generacy/src/orchestrator/humancy-api-handler.ts` |
| FR-002 | Create SSE client utility for connecting to orchestrator event streams | P1 | New file: `packages/generacy/src/orchestrator/sse-client.ts` |
| FR-003 | Map `ReviewDecisionRequest` to orchestrator `DecisionQueueItem` for `POST /queue` | P1 | See type mapping table below |
| FR-004 | Wait for `decision:resolved` event via dual SSE + polling strategy | P1 | SSE primary, polling fallback at configurable interval |
| FR-005 | Map orchestrator `DecisionResponse` back to `ReviewDecisionResponse` | P1 | See type mapping table below |
| FR-006 | Handle timeout by throwing `CorrelationTimeoutError` | P1 | Uses `AbortController` with timeout timer |
| FR-007 | Wire handler into worker startup via `setHumanHandler()` | P1 | In `packages/generacy/src/cli/commands/worker.ts` and `job-handler.ts` |
| FR-008 | SSE auto-reconnection with `Last-Event-ID` support | P2 | 5-second reconnect delay |
| FR-009 | Resource cleanup via `dispose()` method | P2 | Aborts active requests on shutdown |
| FR-010 | Export handler and SSE client from orchestrator package index | P2 | `packages/generacy/src/orchestrator/index.ts` |

## Technical Design

### Type Mapping: Request (Workflow Engine → Orchestrator)

| Workflow Engine Field | Orchestrator Field | Transformation |
|---|---|---|
| `type: 'review'` | `type: 'review'` | Direct pass-through |
| `title` | `prompt` | Rename |
| `urgency` (`low`/`normal`/`blocking_soon`/`blocking_now`) | `priority` (`when_available`/`blocking_soon`/`blocking_now`) | `low`/`normal` → `when_available`; others direct |
| `options[].id` | `options[].id` | Direct pass-through |
| `options[].label` | `options[].label` | Direct pass-through |
| `artifact` | `context` | Wrap in context object: `{ artifact }` |
| `workflowId` | `workflowId` | Direct pass-through |
| `stepId` | `stepId` | Direct pass-through |

### Type Mapping: Response (Orchestrator → Workflow Engine)

| Orchestrator Field | Workflow Engine Field | Transformation |
|---|---|---|
| `response` (string/boolean) | `approved` (boolean) / `decision` (string) | Boolean → `approved`; string → `decision` |
| `comment` | `input` | Rename |
| `respondedBy` | `respondedBy` | Direct pass-through |
| `respondedAt` | `respondedAt` | Direct pass-through |

### Handler Configuration

```typescript
interface HumancyApiConfig {
  apiUrl: string;           // From ORCHESTRATOR_URL env var
  agentId: string;          // From WORKER_ID env var
  authToken?: string;       // Optional bearer token
  pollIntervalMs?: number;  // Default: 30000 (30s)
}
```

### Resolution Strategy

The handler uses a dual strategy for waiting on decision resolution:

1. **SSE Stream** (primary): Connects to `GET /queue/events`, filters for `decision:resolved` events matching the created decision ID
2. **Polling** (fallback): Periodically polls `GET /queue/:id/response` at the configured interval
3. Both run concurrently via `Promise.race`; first to resolve wins
4. Both are cancelled via `AbortSignal` on timeout or resolution

### Wiring Path

1. Worker command reads `ORCHESTRATOR_URL` from environment (already available)
2. If URL is present, instantiate `HumancyApiDecisionHandler` with config
3. After `registerBuiltinActions()`, retrieve the `HumancyReviewAction` from the action registry
4. Call `action.setHumanHandler(handler)` to inject the concrete handler
5. Same wiring in `job-handler.ts` since it independently calls `registerBuiltinActions()`

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/generacy/src/orchestrator/sse-client.ts` | **Create** | SSE client utility using native `fetch()` + `TextDecoderStream` |
| `packages/generacy/src/orchestrator/humancy-api-handler.ts` | **Create** | `HumancyApiDecisionHandler` implementing `HumanDecisionHandler` |
| `packages/generacy/src/orchestrator/index.ts` | **Modify** | Export new handler and SSE client |
| `packages/generacy/src/cli/commands/worker.ts` | **Modify** | Instantiate and wire handler on startup |
| `packages/generacy/src/orchestrator/job-handler.ts` | **Modify** | Wire handler into per-job workflow executor setup |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Decision creation | 100% of review steps create queue items when handler is configured | Integration test: workflow with review step creates decision in queue |
| SC-002 | SSE resolution | Handler resolves within 2s of human response via SSE | Integration test: respond to decision, measure handler resolution time |
| SC-003 | Polling fallback | Handler resolves via polling when SSE is unavailable | Integration test: disable SSE, verify polling resolves |
| SC-004 | Timeout behavior | Handler throws `CorrelationTimeoutError` after configured timeout | Unit test: set short timeout, verify error type |
| SC-005 | Simulation fallback | Existing simulation behavior unchanged when no handler configured | Unit test: no handler → auto-approve in ~100ms |
| SC-006 | Type mapping correctness | All field mappings produce correct orchestrator/engine types | Unit tests for `mapRequestToDecision()` and `mapResponseToReview()` |

## Assumptions

- The orchestrator's decision queue API (`/queue`, `/queue/:id`, `/queue/events`) is stable and deployed
- The orchestrator SSE endpoint supports `Last-Event-ID` for reconnection replay
- The worker process has network access to the orchestrator URL
- `ORCHESTRATOR_URL` and `WORKER_ID` environment variables are already available in the worker context
- Native `fetch()` and `TextDecoderStream` are available (Node.js 22+)
- The existing `CorrelationTimeoutError` class is importable from the workflow engine (used by name comparison in `HumancyReviewAction`)
- The action registry provides a way to retrieve registered handlers by type (via `getActionHandler()` or similar)

## Out of Scope

- **Humancy Cloud UI** — The frontend decision queue UI is handled by a separate feature
- **Authentication/authorization** — Token management and auth flows are not part of this handler; `authToken` is passed in as config
- **Decision expiration/escalation** — Automatic escalation on approaching timeout is a future enhancement
- **Multi-handler support** — Only one handler can be active; no routing between multiple decision backends
- **Queue management API** — Creating, listing, or managing the queue itself (already exists in orchestrator)
- **SSE server-side implementation** — The orchestrator's SSE broadcasting is already implemented
- **Workflow checkpoint/resume** — Already handled by `HumancyReviewAction` and `WorkflowExecutor`; this feature only implements the transport layer
- **Retry on decision creation failure** — If the `POST /queue` call fails, the error propagates immediately; retry logic is handled by the workflow engine's `RetryManager`

---

*Generated by speckit*
