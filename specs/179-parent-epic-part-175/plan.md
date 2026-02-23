# Implementation Plan: Real-Time Job Progress View

**Feature**: 179-parent-epic-part-175
**Date**: 2026-02-23
**Status**: Draft

## Summary

Replace the polling-based queue tree view with a real-time job progress view that shows phase-by-phase, step-by-step execution detail. This involves three main changes:

1. **Enhance the queue tree view** with progress-aware descriptions and a `workflows` SSE channel subscription
2. **Replace `WorkItemDetailPanel`** with a new `JobDetailPanel` that renders live phase/step progress in a webview
3. **Add a cloud job status bar item** showing active job count

The implementation reuses the existing SSE infrastructure (shared connection, channel-based routing) and follows established patterns (singleton webviews, preview/pin, CSP-safe HTML generation, Zod-validated types).

## Technical Context

| Aspect | Detail |
|--------|--------|
| **Language** | TypeScript (strict mode) |
| **Runtime** | VS Code Extension Host (Node.js) |
| **Framework** | VS Code Extension API |
| **Test Framework** | Vitest |
| **Package Manager** | pnpm |
| **Module System** | ESM-style with TypeScript |
| **Key Dependencies** | `vscode`, `zod` |

### Codebase Conventions
- Singleton services via static `getInstance()` or module-level `getXxx()` functions
- All providers implement `vscode.Disposable` with proper cleanup
- SSE subscriptions via `getSSEManager().subscribe(channel, handler)` returning `Disposable`
- Webviews use nonce-based CSP, `postMessage` communication, `acquireVsCodeApi()` in client
- Tree items use `contextValue` for conditional menus (e.g., `queueItem-running`)
- All API types have companion Zod schemas for runtime validation
- Commands registered in `package.json` with `generacy.*` prefix

## Architecture Overview

```
                                SSE /events?channels=workflows,queue
                                         │
                     ┌───────────────────┐│┌──────────────────────┐
                     │ SSESubscription   ││ │                      │
                     │ Manager           │▼│                      │
                     │ (singleton)       ├──┤                      │
                     └─────┬──────┬──────┘  │                      │
                           │      │         │   Orchestrator API   │
                 subscribe │      │ subscribe│                      │
                'workflows'│     'queue'    │  GET /queue           │
                           │      │         │  GET /queue/:id       │
                    ┌──────▼──┐   │         │  GET /queue/:id/      │
                    │         │   │         │      progress         │
                    │ Job     │   │         └──────────────────────┘
                    │ Detail  │   │                    ▲
                    │ Panel   │   │                    │ REST
                    │         │   │                    │
                    │ filters │   │         ┌──────────┴───────┐
                    │ by      │   │         │                  │
                    │ jobId   │   │         │  Queue API       │
                    └─────────┘   │         │  (endpoints/     │
                                  │         │   queue.ts)      │
                    ┌─────────┐   │         └──────────────────┘
                    │ Queue   │◄──┘                  ▲
                    │ Tree    │─────────── REST ──────┘
                    │ Provider│
                    └────┬────┘
                         │
                    ┌────▼────────────────┐
                    │ QueueTreeItem       │
                    │ (with progress      │
                    │  summary in desc)   │
                    └─────────────────────┘

                    ┌─────────────────────┐
                    │ CloudJobStatusBar   │
                    │ (shows count,       │
                    │  click → queue view)│
                    └─────────────────────┘
```

### Data Flow

1. **Tree View Updates**:
   - `queue` SSE channel → `QueueTreeProvider.handleSSEEvent()` → tree refresh (existing)
   - `workflows` SSE channel → `QueueTreeProvider.handleWorkflowEvent()` → update progress summaries → tree refresh (new)
   - Polling fallback: `GET /queue` every 30s → includes `progress` summary on each item (enhanced)

2. **Detail Panel Updates**:
   - Initial load: `GET /queue/:id` + `GET /queue/:id/progress` in parallel
   - `workflows` SSE channel → filter by `jobId` → tiered debounce → `postMessage` to webview
   - `workflow:progress` snapshots → replace full `JobProgress` state
   - `workflow:phase:*` / `workflow:step:*` → merge incrementally into state
   - SSE disconnect → poll `GET /queue/:id/progress` every 5s + show banner

3. **Status Bar Updates**:
   - `queue` SSE channel → count items with `status === 'running'` → update text
   - Polling fallback: recount on tree provider refresh

## Implementation Phases

### Phase 1: Type Definitions and API Extensions
**Files**: `api/types.ts`, `api/endpoints/queue.ts`
**Estimated Complexity**: Low

Add the new progress types and API method.

#### Tasks

**1.1** Add progress types to `api/types.ts`

Add after the existing `QueueItem` section:

```typescript
// Phase/Step Progress Types
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepProgress { ... }
export interface PhaseProgress { ... }
export interface JobProgress { ... }
export interface QueueItemProgressSummary { ... }
```

Add corresponding Zod schemas (`StepProgressSchema`, `PhaseProgressSchema`, `JobProgressSchema`, `QueueItemProgressSummarySchema`).

Extend `QueueItem` and `QueueItemSchema` with optional `progress?: QueueItemProgressSummary`.

See [data-model.md](./data-model.md) for full type definitions.

**1.2** Add `getJobProgress()` to `api/endpoints/queue.ts`

```typescript
async getJobProgress(id: string): Promise<JobProgress> {
  const client = getApiClient();
  const response = await client.getValidated(`/queue/${id}/progress`, JobProgressSchema);
  return response.data;
}
```

**1.3** Add SSE event type interfaces for workflow phase/step events

Add `WorkflowPhaseEventData` and `WorkflowStepEventData` interfaces to `api/types.ts` (see [data-model.md](./data-model.md)).

---

### Phase 2: Queue Tree View Enhancement
**Files**: `views/cloud/queue/provider.ts`, `views/cloud/queue/tree-item.ts`
**Estimated Complexity**: Medium

Enhance the tree view with progress-aware descriptions and a `workflows` SSE subscription.

#### Tasks

**2.1** Subscribe to `workflows` SSE channel in `QueueTreeProvider`

Add a second SSE subscription in `subscribeSSE()`:

```typescript
// Existing queue subscription
const queueSub = sseManager.subscribe('queue', (event) => this.handleSSEEvent(event));

// New: workflows subscription for progress updates
const workflowsSub = sseManager.subscribe('workflows', (event) => this.handleWorkflowEvent(event));
```

**2.2** Add `handleWorkflowEvent()` to `QueueTreeProvider`

Handle `workflow:progress` events to update an internal `Map<string, QueueItemProgressSummary>` keyed by `jobId`. On update, fire debounced tree refresh.

Also handle `workflow:phase:start`, `workflow:phase:complete` to update the summary without waiting for a full snapshot.

**2.3** Update `QueueTreeItem` description to show progress

Modify `getDescription()` in `tree-item.ts` to accept an optional `QueueItemProgressSummary` and display it:

```
speckit-bugfix • Phase 5/8 · implementation • running for 18m
speckit-bugfix • Phase 5/8 (2 skipped) · implementation • running for 18m
```

**2.4** Add elapsed time refresh timer

Add a 10-second `setInterval` in the provider that fires `_onDidChangeTreeData` only when there are running jobs. Clear the timer when no jobs are running.

```typescript
private elapsedTimer: ReturnType<typeof setInterval> | undefined;

private updateElapsedTimer(): void {
  const hasRunning = this.queueItems.some(i => i.status === 'running');
  if (hasRunning && !this.elapsedTimer) {
    this.elapsedTimer = setInterval(() => this._onDidChangeTreeData.fire(), 10000);
  } else if (!hasRunning && this.elapsedTimer) {
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = undefined;
  }
}
```

---

### Phase 3: Job Progress State Manager
**Files**: New `views/cloud/queue/progress-state.ts`
**Estimated Complexity**: Medium

Create a reusable state manager that handles incremental merging and snapshot replacement.

#### Tasks

**3.1** Create `JobProgressState` class

```typescript
export class JobProgressState {
  private progress: JobProgress | null = null;

  /** Replace entire state (from snapshot or initial load) */
  applySnapshot(progress: JobProgress): void;

  /** Merge an incremental phase event */
  applyPhaseEvent(event: WorkflowPhaseEventData): void;

  /** Merge an incremental step event */
  applyStepEvent(event: WorkflowStepEventData): void;

  /** Get current state */
  getProgress(): JobProgress | null;

  /** Get expand/collapse recommendations (smart defaults per Q7) */
  getExpandedPhases(): Set<string>;
}
```

**3.2** Implement incremental merge logic

- `applyPhaseEvent`: Find phase by ID in `this.progress.phases`, update status/timestamps. If phase started, update `currentPhaseIndex`.
- `applyStepEvent`: Find phase by `phaseId`, find step by ID within phase, update status/timestamps/output/error.
- Handle edge case: event arrives for unknown phase/step → ignore (wait for next snapshot to reconcile).

**3.3** Implement smart expand/collapse logic

Track which phases should be expanded based on status:
- Running phase → expanded
- Just-completed phase → collapsed (with transition)
- Pending phase → collapsed
- When a new phase starts running → add to expanded set, remove previous

---

### Phase 4: Job Detail Panel (Webview)
**Files**: Replace `views/cloud/queue/detail-panel.ts`, new `views/cloud/queue/detail-html.ts`
**Estimated Complexity**: High

This is the core of the feature. Replace `WorkItemDetailPanel` with `JobDetailPanel`.

#### Tasks

**4.1** Create `JobDetailPanel` class (replace `WorkItemDetailPanel`)

Rename and refactor the existing file. Keep the same singleton preview/pin pattern. Key changes:
- Constructor accepts `QueueItem` + optional `JobProgress`
- Subscribes to `workflows` SSE channel (filtered by `jobId`) instead of only `queue`
- Uses `JobProgressState` for state management
- Implements tiered debounce: phase events immediate, step events 200ms
- Uses `postMessage` for incremental updates instead of full HTML regeneration

```typescript
export class JobDetailPanel {
  private static previewInstance: JobDetailPanel | undefined;
  private progressState: JobProgressState;
  private stepDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pollingFallbackTimer: ReturnType<typeof setInterval> | undefined;
  private isSSEConnected = true;

  // ... preview/pin pattern from WorkItemDetailPanel ...
}
```

**4.2** Implement SSE event handling with tiered debounce

```typescript
private handleWorkflowEvent(event: SSEEvent): void {
  const data = event.data as { jobId?: string; workflowId?: string };
  if (data.jobId !== this.queueItem.id && data.workflowId !== this.queueItem.workflowId) {
    return; // Not our job
  }

  switch (event.event) {
    case 'workflow:progress':
      // Snapshot — send immediately
      this.progressState.applySnapshot(event.data as JobProgress);
      this.sendProgressUpdate();
      break;

    case 'workflow:phase:start':
    case 'workflow:phase:complete':
      // Phase events — send immediately (high signal)
      this.progressState.applyPhaseEvent(event.data as WorkflowPhaseEventData);
      this.sendProgressUpdate();
      break;

    case 'workflow:step:start':
    case 'workflow:step:complete':
      // Step events — debounce 200ms
      this.progressState.applyStepEvent(event.data as WorkflowStepEventData);
      this.debouncedSendProgressUpdate();
      break;
  }
}
```

**4.3** Implement SSE connection monitoring and polling fallback

Listen to `SSESubscriptionManager.onDidChangeConnectionState`:
- On disconnect → start polling `GET /queue/:id/progress` every 5s, send `connectionStatus: { connected: false, reconnecting: true }` to webview
- On reconnect → stop polling, wait for next snapshot event

**4.4** Implement initial data loading

On panel creation or item change:
1. Set loading state in webview
2. Fetch `queueApi.getQueueItem(id)` and `queueApi.getJobProgress(id)` in parallel
3. Apply snapshot to `JobProgressState`
4. Send full `update` message to webview
5. For completed/failed jobs: skip SSE subscription (static view)

**4.5** Create HTML generation (`detail-html.ts`)

Extract HTML generation into a separate module for maintainability. The HTML includes:
- Header: workflow name, status badge, elapsed time, pin/refresh buttons
- Progress overview: "Phase 5/8 · implementation"
- Phase list: collapsible phases with status icons and timing
- Step list within expanded phases: status icons, names, durations, output summaries
- Error section: inline error messages for failed steps
- Reconnecting banner (hidden by default, shown via JS)
- PR link section (shown when `pullRequestUrl` is available)

Client-side JavaScript in the webview handles:
- `postMessage` listener for updates from extension
- DOM manipulation for incremental progress updates
- Phase expand/collapse toggling
- Elapsed time ticker (1-second `setInterval` for the running step's timer)
- Reconnecting banner show/hide

**4.6** Implement phase expand/collapse in webview

The webview maintains expand/collapse state locally. Smart defaults from `JobProgressState.getExpandedPhases()` sent with initial data. User toggles sent back via `{ type: 'togglePhase', phaseId }` and tracked locally in the webview's JavaScript.

**4.7** Handle completed/failed job static rendering

When `queueItem.status` is `completed`, `failed`, or `cancelled`:
- Fetch progress once via REST
- Render statically (no SSE subscription)
- All phases shown with final status, durations, outputs
- No elapsed time tickers
- Error messages shown inline for failed steps

---

### Phase 5: Cloud Job Status Bar
**Files**: `providers/status-bar.ts`, `constants.ts`
**Estimated Complexity**: Low

Add a status bar item showing active cloud job count.

#### Tasks

**5.1** Add `CloudJobStatusBarProvider` class

Create alongside the existing `ExecutionStatusBarProvider`:

```typescript
export class CloudJobStatusBarProvider implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private runningCount = 0;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99  // Just below local execution (100)
    );
    this.statusBarItem.name = 'Generacy Cloud Jobs';
    this.statusBarItem.command = 'generacy.queue.focus';
  }

  public updateCount(count: number): void { ... }
}
```

**5.2** Wire status bar to queue tree provider

In the cloud service initialization (`commands/cloud.ts`), connect the provider to SSE events:

```typescript
const cloudStatusBar = new CloudJobStatusBarProvider();
// Update on queue SSE events
sseManager.subscribe('queue', () => {
  const running = queueProvider.getItemsByStatus('running').length;
  cloudStatusBar.updateCount(running);
});
```

**5.3** Register `generacy.queue.focus` command

Register a command that focuses the queue tree view:
```typescript
vscode.commands.registerCommand('generacy.queue.focus', () => {
  vscode.commands.executeCommand('generacy.queue.focus');
});
```

---

### Phase 6: Integration and Wiring
**Files**: `views/cloud/queue/actions.ts`, `views/cloud/queue/index.ts`, `constants.ts`, `commands/cloud.ts`, `package.json`
**Estimated Complexity**: Medium

Wire everything together: command registration, menu contributions, and cleanup.

#### Tasks

**6.1** Update `viewQueueItemDetails()` in `actions.ts`

Change to use `JobDetailPanel.showPreview()` instead of `WorkItemDetailPanel.showPreview()`.

**6.2** Update constants and command registrations

Add to `constants.ts`:
```typescript
export const CLOUD_COMMANDS = {
  // ... existing ...
  viewJobProgress: 'generacy.queue.viewProgress',
  focusQueue: 'generacy.queue.focus',
};
```

**6.3** Update `package.json` command contributions

Register new commands:
- `generacy.queue.viewProgress` — "View Job Progress"
- `generacy.queue.focus` — "Focus Queue View"

**6.4** Update module exports in `views/cloud/queue/index.ts`

Export `JobDetailPanel` instead of `WorkItemDetailPanel`. Export `JobProgressState`.

**6.5** Update `commands/cloud.ts` initialization

Add `CloudJobStatusBarProvider` initialization and wiring.

---

### Phase 7: Testing
**Estimated Complexity**: Medium

#### Tasks

**7.1** Unit tests for `JobProgressState`

Test incremental merge, snapshot replacement, edge cases:
- Phase event for unknown phase
- Step event for unknown step
- Snapshot overwrites stale incremental state
- Smart expand/collapse logic

**7.2** Unit tests for progress type schemas

Test Zod schema validation for all new types:
- `JobProgressSchema` with valid and invalid data
- `StepProgressSchema` edge cases (optional fields)
- `QueueItemProgressSummarySchema`

**7.3** Unit tests for enhanced `QueueTreeItem`

Test description formatting with progress summary:
- Running job with phase progress
- Running job with skipped phases
- Completed job without progress
- Pending job without progress

**7.4** Integration test for `JobDetailPanel` lifecycle

Test preview/pin pattern, SSE subscription setup/teardown, initial data loading flow.

## Key Technical Decisions

### D1: Replace vs. Enhance WorkItemDetailPanel

**Decision**: Replace `WorkItemDetailPanel` entirely with `JobDetailPanel` (per Q4 answer).

**Rationale**: Two panels for the same entity would confuse users. The new panel includes both metadata and progress — with progress being contextual (live for running, static for completed). Renaming the file preserves git history.

### D2: postMessage vs. HTML Regeneration for Updates

**Decision**: Use `postMessage` for incremental updates. Generate initial HTML once, then update DOM via messages.

**Rationale**: Full HTML regeneration on every SSE event would cause flickering and loss of scroll position. `postMessage` enables targeted DOM updates while preserving webview state (expanded phases, scroll position).

### D3: Separate progress-state.ts Module

**Decision**: Extract `JobProgressState` into its own file.

**Rationale**: The state management logic (incremental merge, snapshot replace, expand/collapse tracking) is complex enough to warrant isolation. It's also independently testable without webview dependencies.

### D4: No New SSE Endpoint Required

**Decision**: Use the existing shared SSE connection on the `workflows` channel.

**Rationale**: The orchestrator already supports per-channel filtering. The `workflows` channel will carry the new event types. `JobDetailPanel` just filters events by `jobId` in its handler. This avoids connection proliferation (max 3 per client limit).

### D5: Elapsed Time in Webview vs. Extension

**Decision**: The webview manages its own 1-second elapsed time ticker for the running step. The tree view refreshes every 10 seconds.

**Rationale**: Second-level precision matters in the detail view but not the tree. Running a `setInterval` in the webview's JavaScript is efficient and avoids excessive `postMessage` calls.

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Orchestrator doesn't emit phase/step events yet (#177 dependency) | High — no data to display | The 10s `workflow:progress` snapshot provides full state. Phase/step events add real-time granularity but aren't strictly required. Can stub with snapshot-only mode. |
| Large step count causes webview performance issues | Medium — janky UI | 200ms step debounce + `requestAnimationFrame` for DOM updates. Collapsed phases skip step rendering. |
| SSE disconnect during active monitoring | Medium — stale data | Polling fallback every 5s with "Reconnecting..." banner. Snapshot event on reconnect restores full state. |
| QueueItem schema extension breaks existing consumers | Low — schema mismatch | `progress` field is `optional()` in Zod schema. No breaking changes. |
| Multiple pinned panels consume memory | Low — resource usage | VS Code manages webview lifecycle. Shared SSE subscription means no per-panel connection overhead. |

## Dependencies

| Dependency | Status | Impact |
|------------|--------|--------|
| #176 — Orchestrator SSE endpoint | Implemented | SSE infrastructure exists. New event types needed. |
| #177 — Worker event forwarding | In progress | Workers must emit `workflow:progress`, `workflow:phase:*`, `workflow:step:*` events. **Critical** for full functionality but degraded mode works with snapshots only. |

## Implementation Order

The phases should be implemented in order, but some tasks within phases can be parallelized:

1. **Phase 1** (Types) → Foundation for everything else
2. **Phase 2** (Tree View) + **Phase 3** (State Manager) → Can be done in parallel
3. **Phase 4** (Detail Panel) → Depends on Phase 1 and Phase 3
4. **Phase 5** (Status Bar) → Independent, can be done anytime after Phase 1
5. **Phase 6** (Wiring) → After Phases 2-5
6. **Phase 7** (Testing) → After all implementation phases

## Files Summary

### Modified Files
| File | Phase | Changes |
|------|-------|---------|
| `api/types.ts` | 1 | Add progress types, Zod schemas, extend QueueItem |
| `api/endpoints/queue.ts` | 1 | Add `getJobProgress()` method |
| `views/cloud/queue/provider.ts` | 2 | Add workflows SSE sub, progress tracking, elapsed timer |
| `views/cloud/queue/tree-item.ts` | 2 | Progress-aware description in QueueTreeItem |
| `views/cloud/queue/detail-panel.ts` | 4 | Replace WorkItemDetailPanel → JobDetailPanel |
| `views/cloud/queue/actions.ts` | 6 | Update to use JobDetailPanel |
| `views/cloud/queue/index.ts` | 6 | Update exports |
| `providers/status-bar.ts` | 5 | Add CloudJobStatusBarProvider |
| `constants.ts` | 6 | Add new command IDs |
| `commands/cloud.ts` | 6 | Wire cloud status bar |
| `package.json` | 6 | Register new commands |

### New Files
| File | Phase | Purpose |
|------|-------|---------|
| `views/cloud/queue/progress-state.ts` | 3 | JobProgressState: state management with merge/snapshot |
| `views/cloud/queue/detail-html.ts` | 4 | HTML generation for JobDetailPanel webview |
