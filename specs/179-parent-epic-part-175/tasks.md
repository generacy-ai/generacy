# Tasks: Real-Time Job Progress View

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, clarifications.md
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

### User Stories
- **US-LIST**: Job list view with real-time progress updates
- **US-DETAIL**: Job detail webview with phase/step breakdown
- **US-STATUS**: Status bar showing active job count
- **US-INFRA**: Shared infrastructure (types, state management)

---

## Phase 1: Type Definitions and API Extensions

> Foundation types and schemas that all subsequent phases depend on.

### T001 [DONE] [US-INFRA] Add progress type definitions to `api/types.ts`
**File**: `packages/generacy-extension/src/api/types.ts`
- Add `PhaseStatus` type (`'pending' | 'running' | 'completed' | 'failed' | 'skipped'`)
- Add `StepStatus` type (`'pending' | 'running' | 'completed' | 'failed' | 'skipped'`)
- Add `StepProgress` interface (id, name, status, startedAt, completedAt, durationMs, output, error)
- Add `PhaseProgress` interface (id, name, status, timestamps, steps array, error)
- Add `JobProgress` interface (jobId, currentPhaseIndex, totalPhases, completedPhases, skippedPhases, phases, pullRequestUrl, updatedAt)
- Add `QueueItemProgressSummary` interface (currentPhase, phaseProgress, totalPhases, completedPhases, skippedPhases)
- Extend `QueueItem` interface with optional `progress?: QueueItemProgressSummary`
- Reference: `data-model.md` for exact field definitions

### T002 [DONE] [US-INFRA] Add Zod schemas for progress types
**File**: `packages/generacy-extension/src/api/types.ts`
- Add `StepStatusSchema` — `z.enum(['pending', 'running', 'completed', 'failed', 'skipped'])`
- Add `PhaseStatusSchema` — `z.enum(['pending', 'running', 'completed', 'failed', 'skipped'])`
- Add `StepProgressSchema` with optional datetime fields and nonnegative durationMs
- Add `PhaseProgressSchema` with nested `z.array(StepProgressSchema)`
- Add `JobProgressSchema` with nested `z.array(PhaseProgressSchema)` and optional URL
- Add `QueueItemProgressSummarySchema`
- Extend `QueueItemSchema` with `.extend({ progress: QueueItemProgressSummarySchema.optional() })`
- Export all new schemas

### T003 [DONE] [US-INFRA] Add SSE event payload interfaces
**File**: `packages/generacy-extension/src/api/types.ts`
- Add `WorkflowPhaseEventData` interface (workflowId, jobId, phase: PhaseProgress, phaseIndex, totalPhases)
- Add `WorkflowStepEventData` interface (workflowId, jobId, phaseId, phaseIndex, step: StepProgress, stepIndex, totalSteps)
- Add `JobDetailWebviewMessage` union type (ready, refresh, pin, togglePhase, openPR, openAgent)
- Add `JobDetailExtensionMessage` union type (update, progressUpdate, phaseEvent, stepEvent, connectionStatus, error)
- Export all new types

### T004 [DONE] [P] [US-INFRA] Add `getJobProgress()` API endpoint
**File**: `packages/generacy-extension/src/api/endpoints/queue.ts`
- Add `getJobProgress(id: string): Promise<JobProgress>` method to the queue API
- Use `client.getValidated('/queue/${id}/progress', JobProgressSchema)`
- Return `response.data`
- Follow existing endpoint patterns in the file

---

## Phase 2: Queue Tree View Enhancement

> Enhance the existing tree view with real-time progress descriptions. Parallel with Phase 3.

### T005 [DONE] [P] [US-LIST] Subscribe to `workflows` SSE channel in QueueTreeProvider
**File**: `packages/generacy-extension/src/views/cloud/queue/provider.ts`
- Add a `Map<string, QueueItemProgressSummary>` field (`progressSummaries`) to `QueueTreeProvider`
- In `subscribeSSE()`, add second subscription: `sseManager.subscribe('workflows', (event) => this.handleWorkflowEvent(event))`
- Add `handleWorkflowEvent(event: SSEEvent)` method:
  - Handle `workflow:progress` events: extract `jobId`, build `QueueItemProgressSummary` from the snapshot, store in map, fire debounced tree refresh
  - Handle `workflow:phase:start` / `workflow:phase:complete`: update the summary for the job, fire debounced tree refresh
  - Ignore events for unknown/untracked jobs
- Dispose the new subscription in `dispose()`
- Also update `fetchQueue()` to populate `progressSummaries` from `QueueItem.progress` field when available from REST response

### T006 [DONE] [P] [US-LIST] Update QueueTreeItem description with progress info
**File**: `packages/generacy-extension/src/views/cloud/queue/tree-item.ts`
- Modify `QueueTreeItem` constructor or factory to accept optional `QueueItemProgressSummary`
- Update `getDescription()` to include progress when available:
  - Format: `repository • Phase 5/8 · implementation • running for 18m`
  - With skipped phases: `repository • Phase 5/8 (2 skipped) · implementation • running for 18m`
  - Without progress: keep existing format `repository • running for 18m`
- Update tooltip to include progress summary section when progress is available
- Update `provider.ts` `getTreeItem()` to pass progress summary from the map to tree items

### T007 [DONE] [US-LIST] Add elapsed time refresh timer for running jobs
**File**: `packages/generacy-extension/src/views/cloud/queue/provider.ts`
- Add `private elapsedTimer: ReturnType<typeof setInterval> | undefined` field
- Add `updateElapsedTimer()` method:
  - Check if any queue items have `status === 'running'`
  - If running jobs exist and no timer → start 10-second `setInterval` firing `_onDidChangeTreeData.fire()`
  - If no running jobs and timer exists → `clearInterval` and clear reference
- Call `updateElapsedTimer()` after each queue data refresh (SSE or polling)
- Clear timer in `dispose()`

---

## Phase 3: Job Progress State Manager

> Reusable state management for incremental merge and snapshot replacement. Parallel with Phase 2.

### T008 [DONE] [P] [US-DETAIL] Create `JobProgressState` class
**File**: `packages/generacy-extension/src/views/cloud/queue/progress-state.ts` (new)
- Create `JobProgressState` class with:
  - `private progress: JobProgress | null = null`
  - `private expandedPhases: Set<string> = new Set()`
  - `applySnapshot(progress: JobProgress): void` — replaces entire state, recalculates expanded phases
  - `getProgress(): JobProgress | null` — returns current state
  - `getExpandedPhases(): Set<string>` — returns set of phase IDs that should be expanded

### T009 [DONE] [US-DETAIL] Implement incremental merge logic in `JobProgressState`
**File**: `packages/generacy-extension/src/views/cloud/queue/progress-state.ts`
- Implement `applyPhaseEvent(event: WorkflowPhaseEventData): void`:
  - Find phase by `event.phase.id` in `this.progress.phases`
  - Update phase status, startedAt, completedAt, durationMs, error
  - If phase started (`status === 'running'`): update `currentPhaseIndex` to `event.phaseIndex`
  - If phase not found → ignore (wait for next snapshot)
- Implement `applyStepEvent(event: WorkflowStepEventData): void`:
  - Find phase by `event.phaseId` in `this.progress.phases`
  - Find step by `event.step.id` within the phase's `steps` array
  - Update step status, startedAt, completedAt, durationMs, output, error
  - If phase or step not found → ignore (wait for next snapshot)
- Update `updatedAt` timestamp on every successful merge

### T010 [DONE] [US-DETAIL] Implement smart expand/collapse logic
**File**: `packages/generacy-extension/src/views/cloud/queue/progress-state.ts`
- In `applySnapshot()`: recalculate expanded phases set:
  - Running phase → add to expanded set
  - All other phases → remove from expanded set
- In `applyPhaseEvent()`: update expanded set:
  - Phase started (`status === 'running'`) → add to expanded set, remove previously running phase
  - Phase completed → remove from expanded set
- `getExpandedPhases()` returns current set (used for initial webview render and updates)

---

## Phase 4: Job Detail Panel (Webview)

> Core feature: replace WorkItemDetailPanel with live phase/step progress webview.

### T011 [DONE] [US-DETAIL] Create `JobDetailPanel` class (replace `WorkItemDetailPanel`)
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts`
- Rename class from `WorkItemDetailPanel` to `JobDetailPanel`
- Keep the existing singleton preview/pin pattern (static `previewInstance`, `showPreview()`, `pin()`)
- Change constructor to accept `QueueItem` + optional `JobProgress`
- Add `private progressState: JobProgressState` field
- Add `private stepDebounceTimer: ReturnType<typeof setTimeout> | undefined`
- Add `private pollingFallbackTimer: ReturnType<typeof setInterval> | undefined`
- Add `private isSSEConnected = true` flag
- Change SSE subscription from `queue` channel to `workflows` channel
- Update `dispose()` to clear all timers and subscriptions
- Update webview message handling for new message types (togglePhase, openPR)

### T012 [DONE] [US-DETAIL] Implement SSE event handling with tiered debounce
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts`
- Add `handleWorkflowEvent(event: SSEEvent)` method:
  - Filter events: skip if `data.jobId !== this.queueItem.id && data.workflowId !== this.queueItem.workflowId`
  - `workflow:progress` → `progressState.applySnapshot()` + immediate `sendProgressUpdate()`
  - `workflow:phase:start` / `workflow:phase:complete` → `progressState.applyPhaseEvent()` + immediate `sendProgressUpdate()`
  - `workflow:step:start` / `workflow:step:complete` → `progressState.applyStepEvent()` + `debouncedSendProgressUpdate()`
- Add `sendProgressUpdate()`: posts `{ type: 'progressUpdate', progress }` to webview
- Add `debouncedSendProgressUpdate()`: 200ms debounce wrapper using `stepDebounceTimer`
- Clear debounce timer on dispose

### T013 [DONE] [US-DETAIL] Implement SSE connection monitoring and polling fallback
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts`
- Subscribe to `SSESubscriptionManager.onDidChangeConnectionState` event
- On disconnect:
  - Set `isSSEConnected = false`
  - Start `pollingFallbackTimer` — poll `getJobProgress(id)` every 5 seconds, apply snapshot
  - Send `{ type: 'connectionStatus', connected: false, reconnecting: true }` to webview
- On reconnect:
  - Set `isSSEConnected = true`
  - Clear `pollingFallbackTimer`
  - Send `{ type: 'connectionStatus', connected: true }` to webview
  - Wait for next snapshot event to restore full state
- Clear polling timer in `dispose()`

### T014 [DONE] [US-DETAIL] Implement initial data loading
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts`
- On panel creation or when switching to a new item:
  - Post `{ type: 'update', data: { item, progress: null } }` as loading placeholder
  - Fetch `queueApi.getQueueItem(id)` and `queueApi.getJobProgress(id)` in parallel (Promise.all)
  - Apply progress snapshot to `progressState`
  - Send full `{ type: 'update', data: { item, progress } }` message with expanded phases set
  - For completed/failed/cancelled jobs: skip SSE subscription (static view — no live updates)
  - For running/pending jobs: subscribe to `workflows` SSE channel

### T015 [DONE] [US-DETAIL] Create HTML generation module (`detail-html.ts`)
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-html.ts` (new)
- Export `getJobDetailHtml(webview, extensionUri, data)` function
- Generate CSP-safe HTML with nonce-based scripts and styles
- HTML structure:
  - **Header section**: workflow name, status badge (color-coded), elapsed time display, pin/refresh buttons
  - **Progress overview**: "Phase 5/8 · implementation" summary bar
  - **Phase list**: collapsible `<details>` or div-based phases with status icons (✅ completed, 🔄 running/spinner, ❌ failed, ⏭ skipped, ⬜ pending) and timing
  - **Step list**: within expanded phases — status icons, step names, durations, single-line output summaries
  - **Error section**: inline error messages for failed steps (red background)
  - **Reconnecting banner**: hidden by default, shown/hidden via JS on `connectionStatus` messages
  - **PR link section**: shown when `pullRequestUrl` is available
- Client-side JavaScript (`<script nonce>`) handles:
  - `window.addEventListener('message', ...)` for updates from extension
  - DOM manipulation for `progressUpdate` messages (update status icons, timings, step counts)
  - Phase expand/collapse toggling via click handlers
  - Elapsed time ticker: 1-second `setInterval` updating the running step's timer display
  - Reconnecting banner show/hide
  - `acquireVsCodeApi()` for posting messages back to extension (pin, refresh, togglePhase, openPR)

### T016 [DONE] [US-DETAIL] Implement phase expand/collapse in webview
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-html.ts`
- Webview maintains local expand/collapse state in a `Set<string>` (phase IDs)
- Initial state received from extension via `update` message (from `JobProgressState.getExpandedPhases()`)
- Click handlers on phase headers toggle expand/collapse locally
- On `progressUpdate` messages: auto-expand newly running phases, collapse previously running phases
- Post `{ type: 'togglePhase', phaseId }` back to extension for state tracking (optional — for restore on panel re-show)

### T017 [DONE] [US-DETAIL] Handle completed/failed job static rendering
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts`
- When `queueItem.status` is `completed`, `failed`, or `cancelled`:
  - Fetch progress once via REST (`getJobProgress`)
  - Render all phases with final status, durations, outputs
  - No SSE subscription needed
  - No elapsed time tickers (all times are final)
  - Error messages shown inline for failed steps
  - All phases with steps shown collapsed by default (user can expand any)
  - Show PR link if `pullRequestUrl` is present

---

## Phase 5: Cloud Job Status Bar

> Independent of Phases 2-4. Can run in parallel after Phase 1.

### T018 [DONE] [P] [US-STATUS] Add `CloudJobStatusBarProvider` class
**File**: `packages/generacy-extension/src/providers/status-bar.ts`
- Create `CloudJobStatusBarProvider` implementing `vscode.Disposable`
- Constructor creates `vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)`
- Set `statusBarItem.name = 'Generacy Cloud Jobs'`
- Set `statusBarItem.command = 'generacy.queue.focus'`
- Add `updateCount(count: number): void` method:
  - If `count === 0`: hide status bar item
  - If `count > 0`: show item, set text `$(cloud) ${count} job${count !== 1 ? 's' : ''}`
- Add `dispose()` method to dispose the status bar item
- Export the class

### T019 [DONE] [US-STATUS] Wire status bar to queue data
**File**: `packages/generacy-extension/src/commands/cloud.ts`
- Instantiate `CloudJobStatusBarProvider` during cloud service initialization
- Subscribe to `queue` SSE events to update count:
  - On queue event → get running items count from `QueueTreeProvider.getItemsByStatus('running')` → `cloudStatusBar.updateCount(count)`
- Also update count on tree provider refresh (polling fallback)
- Dispose status bar provider on deactivation

### T020 [DONE] [US-STATUS] Register `generacy.queue.focus` command
**File**: `packages/generacy-extension/src/commands/cloud.ts`
- Register command `generacy.queue.focus` that executes `vscode.commands.executeCommand('generacy.queue.focus')` to reveal the queue tree view
- Use existing view ID from constants (`VIEWS.queue`)

---

## Phase 6: Integration and Wiring

> Connect all components. Depends on Phases 2-5.

### T021 [DONE] [US-DETAIL] Update `viewQueueItemDetails()` to use `JobDetailPanel`
**File**: `packages/generacy-extension/src/views/cloud/queue/actions.ts`
- Change import from `WorkItemDetailPanel` to `JobDetailPanel`
- Update `viewQueueItemDetails()` to call `JobDetailPanel.showPreview()` instead of `WorkItemDetailPanel.showPreview()`
- Verify all call sites pass the same arguments

### T022 [DONE] [P] [US-INFRA] Update constants with new command IDs
**File**: `packages/generacy-extension/src/constants.ts`
- Add to `CLOUD_COMMANDS` object:
  - `viewJobProgress: 'generacy.queue.viewProgress'`
  - `focusQueue: 'generacy.queue.focus'`

### T023 [DONE] [P] [US-INFRA] Register new commands in `package.json`
**File**: `packages/generacy-extension/package.json`
- Add to `contributes.commands` array:
  - `{ "command": "generacy.queue.viewProgress", "title": "View Job Progress", "category": "Generacy" }`
  - `{ "command": "generacy.queue.focus", "title": "Focus Queue View", "category": "Generacy" }`

### T024 [DONE] [US-INFRA] Update module exports in `views/cloud/queue/index.ts`
**File**: `packages/generacy-extension/src/views/cloud/queue/index.ts`
- Export `JobDetailPanel` instead of `WorkItemDetailPanel`
- Export `JobProgressState` from `./progress-state`
- Remove `WorkItemDetailPanel` export (it's being replaced, not coexisting)

### T025 [DONE] [US-INFRA] Update `commands/cloud.ts` initialization for status bar
**File**: `packages/generacy-extension/src/commands/cloud.ts`
- Import `CloudJobStatusBarProvider`
- Add initialization code after queue tree provider setup
- Wire SSE queue events to status bar count updates
- Add to disposables array for proper cleanup

---

## Phase 7: Testing

> Verify all new functionality. Depends on all implementation phases.

### T026 [DONE] [P] [US-INFRA] Write unit tests for `JobProgressState`
**File**: `packages/generacy-extension/src/views/cloud/queue/__tests__/progress-state.test.ts` (new)
- Test `applySnapshot()`:
  - Stores full progress state correctly
  - Replaces previous state entirely
  - Recalculates expanded phases (running phase expanded)
- Test `applyPhaseEvent()`:
  - Updates existing phase status and timestamps
  - Updates `currentPhaseIndex` when phase starts running
  - Ignores event for unknown phase ID
  - Updates expanded phases set on phase start/complete
- Test `applyStepEvent()`:
  - Updates existing step within correct phase
  - Ignores event for unknown phase or step
  - Updates step output and error fields
- Test `getExpandedPhases()`:
  - Returns running phase ID only
  - Returns empty set when no phases are running
  - Tracks transition from one running phase to the next
- Test snapshot-after-incremental:
  - Snapshot overwrites stale incremental state correctly

### T027 [DONE] [P] [US-INFRA] Write unit tests for progress Zod schemas
**File**: `packages/generacy-extension/src/api/__tests__/types-progress.test.ts` (new)
- Test `StepProgressSchema`:
  - Valid minimal step (id, name, status only)
  - Valid full step (all optional fields present)
  - Rejects invalid status values
  - Rejects negative durationMs
- Test `PhaseProgressSchema`:
  - Valid phase with empty steps array
  - Valid phase with populated steps
  - Rejects invalid nested step data
- Test `JobProgressSchema`:
  - Valid complete progress object
  - Rejects missing required fields (jobId, phases, updatedAt)
  - Accepts optional pullRequestUrl with valid URL
  - Rejects invalid URL format for pullRequestUrl
- Test `QueueItemProgressSummarySchema`:
  - Valid with all optional fields present
  - Valid with no fields (empty object)
  - Rejects invalid types

### T028 [P] [US-LIST] Write unit tests for enhanced `QueueTreeItem`
**File**: `packages/generacy-extension/src/views/cloud/queue/__tests__/tree-item.test.ts`
- Extend existing tests with progress-aware description cases:
  - Running job with progress → shows `Phase 5/8 · implementation`
  - Running job with skipped phases → shows `Phase 5/8 (2 skipped) · implementation`
  - Running job without progress → falls back to existing format
  - Completed job with progress → shows completed format without phase indicator
  - Pending job → no progress displayed
- Test tooltip includes progress summary when available

### T029 [US-DETAIL] Write integration tests for `JobDetailPanel` lifecycle
**File**: `packages/generacy-extension/src/views/cloud/queue/__tests__/detail-panel.test.ts` (new or extend existing)
- Test preview/pin singleton pattern:
  - `showPreview()` creates a new panel
  - Second `showPreview()` reuses existing unpinned panel
  - `pin()` freezes panel, next `showPreview()` creates new
- Test SSE subscription lifecycle:
  - Running job → SSE subscription created
  - Completed job → no SSE subscription
  - Panel disposed → subscription cleaned up
- Test initial data loading:
  - Fetches item and progress in parallel
  - Sends `update` message to webview
- Test tiered debounce:
  - Phase events sent immediately
  - Step events debounced at 200ms
- Test polling fallback:
  - SSE disconnect → polling starts
  - SSE reconnect → polling stops

### T030 [US-STATUS] Write unit tests for `CloudJobStatusBarProvider`
**File**: `packages/generacy-extension/src/providers/__tests__/status-bar.test.ts` (new or extend existing)
- Test `updateCount(0)` → status bar item hidden
- Test `updateCount(1)` → shows "$(cloud) 1 job" (singular)
- Test `updateCount(3)` → shows "$(cloud) 3 jobs" (plural)
- Test status bar item has correct command (`generacy.queue.focus`)
- Test `dispose()` cleans up status bar item

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (Types) must complete before all other phases
- Phase 4 (Detail Panel) depends on Phase 1 and Phase 3 (State Manager)
- Phase 6 (Wiring) depends on Phases 2, 3, 4, and 5
- Phase 7 (Testing) depends on all implementation phases

**Parallel opportunities across phases**:
- Phase 2 (Tree View) and Phase 3 (State Manager) can run in parallel after Phase 1
- Phase 5 (Status Bar) can run in parallel with Phases 2, 3, and 4 (after Phase 1)

**Parallel opportunities within phases**:
- Phase 1: T001, T002, T003 are sequential (same file), T004 [P] is parallel (different file)
- Phase 2: T005 [P] and T006 [P] are parallel (different files), T007 depends on T005
- Phase 3: T008, T009, T010 are sequential (same new file)
- Phase 4: T011 → T012 → T013 → T014 sequential (same file), T015 [P] parallel (new file), T016 depends on T015, T017 depends on T011+T014
- Phase 5: T018 [P] is parallel (different file from Phase 4), T019 and T020 sequential (same file)
- Phase 6: T021, T022 [P], T023 [P] can partially run in parallel, T024 and T025 sequential
- Phase 7: T026 [P], T027 [P], T028 [P], T030 [P] can all run in parallel; T029 runs independently

**Critical path**:
T001 → T002 → T003 → T008 → T009 → T010 → T011 → T012 → T013 → T014 → T015 → T021 → T024 → T025

**Estimated scope**: ~30 tasks across 7 phases. Core complexity is in Phase 4 (Job Detail Panel webview and HTML generation).
