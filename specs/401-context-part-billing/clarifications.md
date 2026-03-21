# Clarifications: Show 'waiting for slot' indicator on queued workflows

## Batch 1 — 2026-03-21

### Q1: Status Model — Backend-Driven vs Frontend-Computed
**Context**: The spec's condition is `org.activeExecutions >= tierLimit`. The frontend already has access to `currentConcurrentAgents` and `maxConcurrentAgents` via the org usage API (`GET /orgs/{orgId}/usage`). Two fundamentally different approaches exist: (A) the backend sets a flag/status on each queued workflow when the org is at capacity, or (B) the frontend fetches org capacity separately and computes whether each `pending` workflow is slot-blocked. This decision drives the entire data flow and determines which layers need changes.
**Question**: Should the backend explicitly mark workflows as slot-waiting (e.g., setting `waitingFor: "execution_slot"` or a new status), or should the frontend determine slot-waiting state by comparing `currentConcurrentAgents >= maxConcurrentAgents` locally?
**Options**:
- A: Backend-driven — backend sets a flag or status field on queued workflows when org is at capacity
- B: Frontend-computed — frontend fetches org capacity and determines slot-waiting state locally
- C: Hybrid — backend provides a `slotBlocked: boolean` field on queue items, frontend uses it for display

**Answer**: B — Frontend-computed. The frontend already has access to `currentConcurrentAgents` and `maxConcurrentAgents` via the org usage API. When `active >= max`, all `pending` workflows are slot-waiting. No need for the backend to mark individual workflows — it's a global org-level state, not a per-workflow attribute. This avoids backend changes and keeps the logic simple: if the org is at capacity and a workflow is pending, it's waiting for a slot.

### Q2: Real-Time Capacity Updates
**Context**: FR-004 requires the indicator to "update in real-time as execution slots open/close." The current SSE infrastructure handles per-workflow and per-queue events on dedicated channels (`workflows`, `queue`), but org-level capacity data (`currentConcurrentAgents`) is only available via REST (`GET /orgs/{orgId}/usage`). If the frontend must react when a running workflow completes and a slot opens (causing all slot-waiting workflows to update), it needs a mechanism to learn about capacity changes in near real-time.
**Question**: How should the frontend receive real-time updates when org capacity changes? Should it poll the usage endpoint, should a new SSE event type be added for capacity changes, or should the backend push updated workflow statuses when capacity changes?
**Options**:
- A: Poll the org usage endpoint at an interval (e.g., every 10–30 seconds)
- B: Add a new SSE event (e.g., `org:capacity_changed`) on an existing or new channel
- C: Backend pushes updated queue item statuses when capacity changes (workflows transition status automatically)

**Answer**: A — Poll the org usage endpoint every 15 seconds. The dashboard already polls at this interval for other data. Adding a new SSE event type (B) is overengineered for this — capacity changes are infrequent (only when a workflow starts or finishes). Polling at 15s gives near-real-time updates without new infrastructure. The existing SSE `job:completed`/`job:created` events (from generacy#398) will also cause the workflow list to refresh, which naturally triggers a capacity re-check.

### Q3: Reuse Existing `waiting` Status vs. Enhance `pending`
**Context**: The frontend already has a `waiting` status type with a `waitingFor` string field, used for human-input gates (e.g., clarification). Slot-blocked workflows currently have `pending` status (displayed as "queued"). Two approaches exist: reuse `waiting` with `waitingFor: "execution_slot"`, or keep workflows as `pending` and add separate visual logic. Reusing `waiting` is simpler but conflates two different concepts (human-input blocking vs. capacity blocking), which could confuse users or complicate filtering.
**Question**: Should slot-blocked workflows use the existing `waiting` status with `waitingFor: "execution_slot"`, or remain as `pending` with the slot-waiting indicator layered on via separate UI logic?
**Options**:
- A: Reuse `waiting` status — set `waitingFor: "execution_slot"` on slot-blocked workflows
- B: Keep `pending` status — frontend adds visual indicator based on org capacity comparison
- C: Introduce a new status value (e.g., `slot_waiting`) to the `QueueStatus` type

**Answer**: B — Keep `pending` status, frontend adds visual indicator based on org capacity. Don't reuse `waiting` — that status is for human-input gates (clarification questions) and has different semantics (user action required vs. system capacity constraint). Don't add a new status value either — slot-waiting is a transient display concern, not a workflow state. The frontend simply checks: is this workflow `pending` AND is the org at capacity? If yes, show the slot-waiting indicator.

### Q4: Target UI Views
**Context**: The spec references "workflow list and queue views" generically. In the VS Code extension, workflows appear in the queue tree view (`QueueTreeItem`), the workflow detail panel (`detail-panel.ts`), and potentially the cloud web dashboard. The scope of UI changes depends on which views need the indicator — modifying only the queue tree view is significantly less work than also updating detail panels and cloud dashboard components.
**Question**: Which specific views need the "waiting for execution slot" indicator? Only the queue tree view, or also the detail panel, cloud dashboard, or other surfaces?
**Options**:
- A: Queue tree view only (the primary workflow list in VS Code extension)
- B: Queue tree view + detail panel (both VS Code extension views)
- C: All views including cloud web dashboard
- D: Queue tree view + detail panel + tooltip enhancements

**Answer**: C — All views including cloud web dashboard. The slot-waiting indicator is important context wherever a user sees queued workflows. Showing it only in VS Code but not in the web dashboard would be inconsistent. The implementation is the same logic in all views — check org capacity, annotate pending workflows. The web dashboard (Generacy frontend) and VS Code extension should both show it.

### Q5: Slot Capacity Context Display
**Context**: The org dashboard already shows `currentConcurrentAgents / maxConcurrentAgents`. When a user sees "Queued — waiting for execution slot," they may want to know the capacity situation (e.g., "3/3 slots in use") to understand the bottleneck. The spec doesn't specify whether to surface aggregate capacity info alongside the per-workflow indicator, which affects whether the queue view needs to fetch and display org-level data.
**Question**: Should the queue view display aggregate slot capacity information (e.g., "3/3 execution slots in use") as context alongside individual workflow indicators, or is the per-workflow "waiting for execution slot" label sufficient?
**Options**:
- A: Per-workflow label only — "Queued — waiting for execution slot" with no aggregate info
- B: Add a capacity summary header/section to the queue view (e.g., "Execution Slots: 3/3")
- C: Show capacity info in the workflow tooltip/detail but not in the list view

**Answer**: C — Show capacity info in the workflow tooltip/detail but not in the list view. The per-workflow label "Queued — waiting for execution slot" is sufficient in the list view. Adding a capacity header to the queue view clutters it. But when the user clicks/hovers on a slot-waiting workflow, show "3/3 execution slots in use" in the detail/tooltip so they understand the bottleneck without navigating to the dashboard.
