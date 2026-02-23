# Technical Research: Real-Time Job Progress View

**Feature**: 179-parent-epic-part-175
**Date**: 2026-02-23

## Existing Architecture Analysis

### Current SSE Infrastructure

The extension already has a robust SSE client (`api/sse.ts`, 538 lines) that:
- Connects to `GET /events?channels=workflows,queue,agents`
- Provides channel-based subscription routing via `subscribe(channel, handler)`
- Handles reconnection with exponential backoff (1s → 30s max)
- Supports `Last-Event-ID` replay on reconnection
- Uses Node.js `http`/`https` modules (not browser `EventSource`)

The orchestrator SSE server (`packages/orchestrator/src/sse/`) provides:
- Per-channel broadcasting with subscriber management
- Ring buffer event retention (1000 events, 60s TTL)
- Connection heartbeat (30s)
- Max 3 connections per client
- Last-Event-ID replay support

**Key Finding**: No new SSE connection infrastructure is needed. The existing shared connection on the `workflows` channel will carry the new `workflow:progress`, `workflow:phase:*`, and `workflow:step:*` events. The `JobDetailPanel` just filters events by `jobId`.

### Current Queue Tree View

`QueueTreeProvider` (`views/cloud/queue/provider.ts`, 763 lines):
- Subscribes to SSE `queue` channel (200ms debounce)
- Polls every 30s as fallback
- Supports 4 view modes: flat, byStatus, byRepository, byAssignee
- Uses `QueueTreeItem` with status icons, priority icons, time descriptions
- Visibility-aware: pauses polling when hidden

**Enhancement Needed**: Add `workflow:progress` subscription on the `workflows` SSE channel to update tree item descriptions with phase progress. Tree items will show "Phase 5/8 · implementation" alongside existing status/time info.

### Current Detail Panel (WorkItemDetailPanel)

`WorkItemDetailPanel` (`views/cloud/queue/detail-panel.ts`, 625 lines):
- Singleton preview/pin pattern with `showPreview()` / `pin()` methods
- Server-rendered HTML (full page generated in `generateHtml()`)
- SSE subscription on `queue` channel for real-time updates
- Message handling: `ready`, `refresh`, `pin`, `openAgent`
- CSP-safe with nonce-based scripts/styles

**Decision (Q4 Answer)**: `JobDetailPanel` replaces `WorkItemDetailPanel` entirely. The new panel includes both metadata (status, priority, timeline) AND phase/step progress, with progress being contextual — live for running jobs, static for completed/failed ones.

### Existing Status Bar

`ExecutionStatusBarProvider` (`providers/status-bar.ts`, 483 lines):
- Left-aligned, priority 100
- Tracks local execution: phases, steps, elapsed time
- Uses `$(sync~spin)` for running, `$(check)` for completed, etc.
- Hidden when idle, shows during execution

**Enhancement Needed**: Add a separate `CloudJobStatusBarItem` adjacent to the local execution status (left side, slightly lower priority ~99). Shows cloud job count. Clicking opens the queue tree view.

### Webview Communication Pattern

The orchestrator dashboard panel (`views/cloud/orchestrator/panel.ts`) demonstrates the canonical webview pattern:
1. Extension creates `WebviewPanel`, sets `html`
2. Webview posts `{ type: 'ready' }` on load
3. Extension sends data via `postMessage({ type: 'update', data: ... })`
4. SSE events forwarded as `{ type: 'sseEvent', event }` or transformed
5. Connection state forwarded as `{ type: 'connectionStatus', connected }`

**Pattern to follow**: Use `postMessage` for real-time updates rather than regenerating HTML. The webview will maintain its own DOM state, receiving incremental updates.

## Key Technical Decisions

### D1: Hybrid SSE Approach (Clarification Q1 Answer C)

Periodic full `workflow:progress` snapshots (~10s) combined with incremental `workflow:phase:*` / `workflow:step:*` events. This:
- Provides automatic state recovery after reconnection gaps
- Keeps the UI responsive between snapshots via incremental events
- Aligns with the existing webhook+polling hybrid reliability pattern

### D2: Shared SSE Connection (Clarification Q12 Answer A)

All `JobDetailPanel` instances filter the same `workflows` SSE subscription by `jobId`. No per-panel SSE connections needed. The existing `SSESubscriptionManager` singleton already supports multiple subscribers on the same channel.

### D3: Tiered Debounce (Clarification Q8 Answer C)

- **Phase-level events** (`workflow:phase:start`, `workflow:phase:complete`): sent immediately to webview — infrequent and high-signal
- **Step-level events** (`workflow:step:start`, `workflow:step:complete`): debounced at 200ms — prevents flickering during rapid step completions
- **Progress snapshots** (`workflow:progress`): sent immediately — replaces full state

### D4: Smart Expand/Collapse (Clarification Q7 Answer A)

Default webview state:
- Currently running phase: expanded
- Completed phases: collapsed
- Pending phases: collapsed
- Auto-expand a phase when it transitions to running

### D5: Tree Refresh Interval (Clarification Q3 Answer C)

Elapsed time in tree items refreshes every 5-10 seconds (not 1s). The detail webview is where second-level precision matters.

### D6: Skipped Phase Display (Clarification Q9 Answer B)

Include skipped items in count: "Phase 5/8 (2 skipped)". Grey dash icon with muted text in detail view.

### D7: Polling Fallback on SSE Disconnect (Clarification Q6 Answer A)

- Show "Reconnecting..." banner in webview during SSE disconnect
- Fall back to polling `GET /queue/:id/progress` every 5s
- For completed/failed jobs: fetch once, render statically, no SSE subscription
- The periodic snapshot approach from D1 restores complete state on reconnection

## Risk Analysis

### R1: Orchestrator Event Coverage

**Risk**: The orchestrator (#176) and worker event forwarding (#177) may not emit all the phase/step events this feature needs.

**Mitigation**: The existing `WorkflowEventType` in `orchestrator/src/types/sse.ts` already includes `step:started`, `step:completed`, `step:failed`. The new `workflow:phase:start`, `workflow:phase:complete`, and `workflow:progress` events need to be added. This is coordinated work with #177.

**Fallback**: If phase/step events are incomplete, the 10-second `workflow:progress` snapshot provides full state recovery. The UI will still work — just with slightly less granular real-time updates.

### R2: Webview Performance with Many Steps

**Risk**: Implementation phases can have 20+ tasks. Rendering and updating many step items could cause jank.

**Mitigation**: Use `requestAnimationFrame` for DOM updates in the webview. Batch step events via 200ms debounce before sending to webview. Collapsed phases don't render step detail.

### R3: Memory from Multiple Pinned Panels

**Risk**: Users could theoretically pin many `JobDetailPanel` instances.

**Mitigation**: VS Code's native webview lifecycle handles resource management. Each panel filters the shared SSE subscription (no per-panel connections). In practice, users rarely pin more than a few panels.

### R4: QueueItem Schema Extension Backward Compatibility

**Risk**: Adding `progress` to `QueueItem` response could break clients expecting the old schema.

**Mitigation**: The `progress` field is optional in the Zod schema. Old clients that don't read `progress` are unaffected. The extension's `QueueItemSchema` is updated with `.optional()` on the new field.

## Files Inventory

### Files to Modify

| File | Changes |
|------|---------|
| `api/types.ts` | Add `PhaseStatus`, `StepStatus`, `StepProgress`, `PhaseProgress`, `JobProgress`, `QueueItemProgressSummary` types and Zod schemas. Extend `QueueItem` with optional `progress` |
| `api/endpoints/queue.ts` | Add `getJobProgress(id)` endpoint method |
| `views/cloud/queue/provider.ts` | Subscribe to `workflows` SSE channel for progress events. Add elapsed time refresh timer (5-10s). Update tree item descriptions with phase progress |
| `views/cloud/queue/tree-item.ts` | Extend `QueueTreeItem` to display phase progress in description |
| `views/cloud/queue/detail-panel.ts` | Replace `WorkItemDetailPanel` with `JobDetailPanel` (or rename and refactor) |
| `views/cloud/queue/actions.ts` | Update `viewQueueItemDetails()` to use `JobDetailPanel` |
| `providers/status-bar.ts` | Add `CloudJobStatusBarItem` class and initialization |
| `constants.ts` | Add new command IDs for job detail panel actions |
| `package.json` | Register new commands and view contributions |

### New Files

| File | Purpose |
|------|---------|
| `views/cloud/queue/progress-state.ts` | `JobProgressState` class — manages local progress state with incremental merge and snapshot replace |
| `views/cloud/queue/detail-html.ts` | HTML generation for `JobDetailPanel` — extracted for clarity |
