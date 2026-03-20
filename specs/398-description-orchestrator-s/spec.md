# Feature Specification: Orchestrator Job Lifecycle Events via Relay WebSocket

The orchestrator's workflow engine processes issues and runs workflows, but never emits job lifecycle events through the relay WebSocket to the cloud API.

**Branch**: `398-description-orchestrator-s` | **Date**: 2026-03-20 | **Status**: Draft

## Summary

Add job lifecycle event emission to the orchestrator's workflow engine so the dashboard can display active workflows, workflow history, and real-time activity. The cloud API already handles these events (generacy-cloud#228) — the orchestrator just needs to send them.

## Description

The orchestrator's workflow engine processes issues and runs workflows, but never emits job lifecycle events (`job:created`, `job:phase_changed`, `job:completed`, `job:failed`, `job:paused`) through the relay WebSocket to the cloud API.

The cloud API has been updated to handle these events (generacy-cloud#228) — it bridges them to SSE channels and writes to Firestore for the dashboard. But the orchestrator side never sends them, so the dashboard always shows 0 active workflows and an empty activity feed.

## Root Cause

The `RelayBridge` in the orchestrator handles incoming relay messages (request/response proxying) but has no outbound event emission for job lifecycle changes. The workflow engine (`WorkflowService` / `WorkflowRunner`) processes jobs without notifying the relay.

## Expected Behavior

When the orchestrator workflow engine changes job state, it should send an `event` message through the relay WebSocket. The message must conform to the cloud API's `EventMessage` type:

```json
{
  "type": "event",
  "event": "job:created",
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
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

### Message Format

Events must arrive at the cloud API's `MessageHandler.handleEvent()` as `{ type: 'event', event: string, data: Record<string, unknown>, timestamp: string }`. Use whatever relay message structure maps to this shape — if the existing `RelayEvent` structure gets parsed into this by the relay server, use that; otherwise use the flat format directly.

### Job ID

Generate a new UUID for each job when it is dequeued (at `job:created` time). Store the UUID in the workflow context so all subsequent events reference the same ID. Include the composite `owner/repo#issueNumber` in the `data` payload as metadata, not as the jobId.

### Events to Emit

- `job:created` — when a workflow is dequeued and starts processing (generate UUID here)
- `job:phase_changed` — fired at phase **START** (`currentStep` = phase about to begin, e.g., "clarify")
- `job:paused` — when a workflow hits a gate (e.g., waiting for clarification answers); when the gate resolves, emit `job:phase_changed` for the next phase
- `job:completed` — when the workflow finishes successfully
- `job:failed` — when the workflow fails with an error (include error details in `data`)

### Phase Change Timing

`job:phase_changed` fires at the START of each phase — `currentStep` is the phase about to begin. The hook point is at the top of the phase loop iteration, before the phase executor runs.

## Tasks

- Add an `emitEvent(event: string, data: Record<string, unknown>)` method to the `RelayBridge` or `ClusterRelayClient`
- Generate a UUID for each job at dequeue time and store in workflow context
- Hook into the workflow engine's state transitions to emit events at each lifecycle point:
  - `job:created` at job dequeue
  - `job:phase_changed` at phase START (top of phase loop)
  - `job:paused` at gate entry
  - `job:completed` at successful workflow completion
  - `job:failed` at workflow failure
- Include relevant metadata: jobId (UUID), workflowName, owner, repo, issueNumber, status, currentStep, error (for failures)
- Ensure events are only emitted when the relay is connected (no-op when disconnected)

## Context

- Cloud API event handler: generacy-cloud#228 (merged, deployed)
- Cloud API Firestore write on job events: `MessageHandler.handleEvent()` in `services/relay/message-handler.ts`
- Cloud API `EventMessage` type: `{ type: 'event', event: string, data: Record<string, unknown>, timestamp: string }`
- Dashboard metadata fix: generacy-cloud#226 (merged, deployed)
- Worker count fix: generacy-cloud#227 (merged, deployed)

## Acceptance Criteria

- Dashboard shows active workflows when issues are being processed
- Workflow History tab shows completed/failed workflows
- Activity feed shows real-time job lifecycle events
- Dashboard correctly shows "paused" state when workflows are waiting at gates

## User Stories

### US1: Dashboard Workflow Visibility

**As a** project admin,
**I want** to see active, paused, and completed workflows on the dashboard,
**So that** I can monitor processing status and identify stuck or failed workflows.

**Acceptance Criteria**:
- [ ] Active workflows appear in real-time when issues start processing
- [ ] Paused workflows show as paused (not falsely active) when waiting at gates
- [ ] Completed/failed workflows appear in the History tab
- [ ] Activity feed updates in real-time with lifecycle events

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `emitEvent()` method on RelayBridge/ClusterRelayClient | P1 | No-op when relay disconnected |
| FR-002 | UUID generation per job at dequeue time | P1 | Stored in workflow context |
| FR-003 | Emit `job:created` at job dequeue | P1 | |
| FR-004 | Emit `job:phase_changed` at phase start | P1 | `currentStep` = phase about to begin |
| FR-005 | Emit `job:paused` at gate entry | P1 | Resume emits `job:phase_changed` |
| FR-006 | Emit `job:completed` at successful completion | P1 | |
| FR-007 | Emit `job:failed` at workflow failure | P1 | Include error in data |
| FR-008 | Event payload includes jobId, workflowName, owner, repo, issueNumber, status, currentStep | P1 | |

## Assumptions

- The cloud API's `handleEvent()` already handles any `job:*` prefixed event (no cloud-side changes needed for `job:paused`)
- The relay server correctly forwards `event` type messages from orchestrator to cloud API
- UUID v4 generation is available in the orchestrator runtime

## Out of Scope

- Worker count reporting (handled by relay connection metadata, generacy-cloud#227)
- Cloud API changes (already deployed via generacy-cloud#228)
- SSE channel setup (already exists)

---

*Generated by speckit*
