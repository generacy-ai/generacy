# Feature Specification: Orchestrator Job Lifecycle Events via Relay WebSocket

Emit job lifecycle events (`job:created`, `job:phase_changed`, `job:completed`, `job:failed`) from the orchestrator's workflow engine through the relay WebSocket so the cloud dashboard can display real-time workflow status.

**Branch**: `398-description-orchestrator-s` | **Date**: 2026-03-20 | **Status**: Draft

## Summary

The orchestrator processes workflows but never notifies the cloud API about job state changes. The cloud API already handles these events (generacy-cloud#228) and bridges them to SSE/Firestore for the dashboard, but the orchestrator never sends them. This feature adds outbound event emission at each workflow lifecycle point so the dashboard shows live workflow activity.

## Description

The orchestrator's workflow engine processes issues and runs workflows, but never emits job lifecycle events (`job:created`, `job:phase_changed`, `job:completed`, `job:failed`) through the relay WebSocket to the cloud API.

The cloud API has been updated to handle these events (generacy-cloud#228) — it bridges them to SSE channels and writes to Firestore for the dashboard. But the orchestrator side never sends them, so the dashboard always shows 0 active workflows and an empty activity feed.

## Root Cause

The `RelayBridge` in the orchestrator handles incoming relay messages (request/response proxying) but has no outbound event emission for job lifecycle changes. The workflow engine (`WorkflowService` / `WorkflowRunner`) processes jobs without notifying the relay.

## Expected Behavior

When the orchestrator workflow engine changes job state, it should send an `event` message through the relay WebSocket:

```json
{
  "type": "event",
  "event": "job:created",
  "data": {
    "jobId": "uuid",
    "workflowName": "speckit-feature",
    "owner": "christrudelpw",
    "repo": "todo-list-example1",
    "issueNumber": 1,
    "status": "active",
    "currentStep": "specify"
  },
  "timestamp": "2026-03-20T12:00:00Z"
}
```

Events to emit:
- `job:created` — when a workflow is dequeued and starts processing
- `job:phase_changed` — when the workflow transitions between phases (specify → clarify → plan → etc.)
- `job:completed` — when the workflow finishes successfully
- `job:failed` — when the workflow fails with an error

## Tasks

- Add an `emitEvent(event: string, data: Record<string, unknown>)` method to the `RelayBridge` or `ClusterRelayClient`
- Hook into the workflow engine's state transitions to emit events at each lifecycle point
- Include relevant metadata: jobId, workflowName, owner, repo, issueNumber, status, currentStep, error (for failures)
- Ensure events are only emitted when the relay is connected (no-op when disconnected)

## Context

- Cloud API event handler: generacy-cloud#228 (merged, deployed)
- Cloud API Firestore write on job events: `MessageHandler.handleEvent()` in `services/relay/message-handler.ts`
- Dashboard metadata fix: generacy-cloud#226 (merged, deployed)
- Worker count fix: generacy-cloud#227 (merged, deployed)

## Acceptance Criteria

- Dashboard shows active workflows when issues are being processed
- Workflow History tab shows completed/failed workflows
- Activity feed shows real-time job lifecycle events
- Worker count reflects actual connected workers

## User Stories

### US1: Dashboard Operator Monitors Active Workflows

**As a** dashboard operator,
**I want** to see active workflows and their current phase in real time,
**So that** I can monitor orchestrator activity and identify stalled or failing jobs.

**Acceptance Criteria**:
- [ ] Dashboard shows active workflow count > 0 when issues are being processed
- [ ] Each active workflow displays its current phase (specify, clarify, plan, etc.)
- [ ] Workflow transitions appear in the activity feed within seconds

### US2: Dashboard Operator Reviews Workflow History

**As a** dashboard operator,
**I want** to see completed and failed workflows in the history tab,
**So that** I can audit past work and investigate failures.

**Acceptance Criteria**:
- [ ] Completed workflows appear in history with final status
- [ ] Failed workflows include error information
- [ ] History updates without requiring page refresh

### US3: Graceful Degradation on Relay Disconnect

**As a** system operator,
**I want** event emission to no-op when the relay is disconnected,
**So that** workflow processing is not disrupted by relay connectivity issues.

**Acceptance Criteria**:
- [ ] Workflows continue processing normally when relay is disconnected
- [ ] No errors thrown due to missing relay connection
- [ ] Events resume automatically when relay reconnects

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `emitEvent(event, data)` method to `RelayBridge` or `ClusterRelayClient` that sends `{ type: "event", event, data, timestamp }` over WebSocket | P1 | Must match cloud API's expected message format |
| FR-002 | Emit `job:created` when a workflow is dequeued and starts processing | P1 | Include jobId, workflowName, owner, repo, issueNumber, status, currentStep |
| FR-003 | Emit `job:phase_changed` when workflow transitions between phases | P1 | Include updated currentStep and status |
| FR-004 | Emit `job:completed` when workflow finishes successfully | P1 | Include final status |
| FR-005 | Emit `job:failed` when workflow fails with an error | P1 | Include error message/details |
| FR-006 | Guard event emission on relay connection state (no-op when disconnected) | P1 | Avoid errors or queuing when relay is down |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Active workflow visibility | 100% of running workflows shown on dashboard | Process a test issue, verify dashboard reflects it |
| SC-002 | Phase transition accuracy | All phase changes reflected in activity feed | Run full speckit workflow, verify all phases appear |
| SC-003 | Completion/failure recording | All terminal states recorded in history | Verify completed and failed workflows appear in history tab |
| SC-004 | Event latency | < 2 seconds from state change to dashboard update | Measure time between orchestrator log and SSE receipt |

## Assumptions

- The cloud API event handler (generacy-cloud#228) is deployed and functioning correctly
- The relay WebSocket connection between orchestrator and cloud API is already established for request/response proxying
- The `WorkflowService` / `WorkflowRunner` has identifiable state transition points that can be hooked into
- Job metadata (owner, repo, issueNumber, workflowName) is available at each lifecycle point

## Out of Scope

- Retry/queuing of missed events during relay disconnect (events are fire-and-forget)
- Backfilling historical job data for workflows that ran before this feature
- Changes to the cloud API event handler (already deployed)
- Dashboard UI changes (already implemented, waiting for events)

---

*Generated by speckit*
