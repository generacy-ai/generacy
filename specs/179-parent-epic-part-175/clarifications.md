# Clarification Questions

## Status: Resolved

## Questions

### Q1: Workflows SSE Event Schema for Phase/Step Progress
**Context**: The spec assumes the orchestrator (#176) emits `workflow:phase:start`, `workflow:phase:complete`, `workflow:step:start`, `workflow:step:complete`, and `workflow:progress` events. However, the existing `workflows` SSE channel only emits `workflow:started`, `workflow:completed`, `workflow:failed`, and `workflow:cancelled` — none of which carry phase/step detail. The new event types and their payload schemas need to be explicitly defined and coordinated with the orchestrator team.
**Question**: What is the exact payload schema for the new phase/step SSE events? Specifically, does `workflow:progress` include the full `JobProgress` object (all phases and steps), or only a summary (current phase index + name)?
**Options**:
- A) Full state snapshot: `workflow:progress` sends the complete `JobProgress` with all phases/steps and their statuses on every update. Simpler client-side logic but larger payloads.
- B) Incremental deltas: `workflow:phase:*` and `workflow:step:*` events send only the changed phase/step data. The client accumulates state. Smaller payloads but requires careful state management and ordering guarantees.
- C) Hybrid: Periodic full `workflow:progress` snapshots (e.g., every 10s) combined with incremental `phase:*`/`step:*` events between snapshots. Balances payload size with state recovery.
**Answer**: C) Hybrid — Periodic full snapshots (every ~10s) combined with incremental phase/step events. This aligns with the architecture's webhook+polling hybrid reliability pattern from the label protocol. Full snapshots provide automatic state recovery after reconnection gaps (directly addresses Q6 too), while incremental events keep the UI responsive between snapshots.

### Q2: QueueItem API Extension for Initial Progress Load
**Context**: The spec assumes the `QueueItem` API response will be extended with a `progress` field for initial load and polling fallback, but doesn't specify whether this is a new endpoint or an extension of the existing `GET /queue/:id` response. This affects how `JobDetailPanel` fetches initial state when opened and how the polling fallback reconstructs progress after an SSE reconnection gap.
**Question**: Should progress data be fetched via the existing `getQueueItem(id)` endpoint (extended response) or via a new dedicated `getJobProgress(jobId)` endpoint?
**Options**:
- A) Extend existing endpoint: Add `progress?: JobProgress` to the `QueueItem` response from `GET /queue/:id`. Single request gets everything.
- B) New dedicated endpoint: Add `GET /queue/:id/progress` that returns `JobProgress` separately. Keeps QueueItem lightweight for list views.
- C) Both: Extend list endpoint with a summary field (`currentPhase`, `phaseProgress`) and add a dedicated endpoint for the full progress breakdown.
**Answer**: C) Both — Extend the list endpoint with a lightweight summary (`currentPhase`, `phaseProgress`) and add `GET /queue/:id/progress` for the full breakdown. The list view shouldn't pay the cost of fetching full progress for every job, but the detail panel needs everything. This follows the progressive complexity pattern used throughout the architecture.

### Q3: Tree View Elapsed Time Timer Impact on Performance
**Context**: The spec calls for a 1-second `setInterval` in `QueueTreeProvider` that fires `_onDidChangeTreeData` to refresh elapsed times for running jobs. The existing provider uses a 200ms debounce on SSE-triggered refreshes. Firing a full tree data change event every second could cause performance issues (re-rendering all tree items) and conflicts with the debounce logic, especially with many running jobs.
**Question**: Should the elapsed time timer trigger a full tree refresh, or should it use a more targeted update mechanism?
**Options**:
- A) Full tree refresh every 1s: Simple implementation using existing `_onDidChangeTreeData.fire()`. Acceptable since tree items are lightweight.
- B) Targeted item refresh: Use `_onDidChangeTreeData.fire(specificItem)` to only refresh running job items. More efficient but requires tracking which items are running.
- C) Description-only updates at longer interval: Update elapsed time every 5-10 seconds instead of 1s, since exact-second precision in a tree view is not critical for UX.
**Answer**: C) Description-only updates at 5-10s interval — Second-level precision in a tree view isn't critical for UX — the detail webview is where that matters. A 5-10 second refresh avoids the performance issues of firing `_onDidChangeTreeData` every second across all items, and sidesteps the debounce conflict with SSE-triggered refreshes.

### Q4: JobDetailPanel Relationship to WorkItemDetailPanel
**Context**: The spec creates a new `JobDetailPanel` in `views/cloud/job-detail/` that follows the same preview/pin singleton pattern as `WorkItemDetailPanel`. Both are triggered by clicking a queue item. It's unclear whether `JobDetailPanel` replaces `WorkItemDetailPanel` or coexists with it — and if they coexist, what determines which panel opens when a user clicks a queue item.
**Question**: Does `JobDetailPanel` replace `WorkItemDetailPanel`, or do they coexist? If they coexist, what triggers each?
**Options**:
- A) Replace: `JobDetailPanel` supersedes `WorkItemDetailPanel` entirely. All queue item clicks open the new panel, which includes both metadata (status, priority, timeline) and phase/step progress.
- B) Coexist — status-based: Running jobs open `JobDetailPanel` (with live progress); completed/pending/failed jobs open `WorkItemDetailPanel` (with metadata/timeline).
- C) Coexist — user choice: Add a "View Progress" action alongside the existing detail click. Clicking the item opens `WorkItemDetailPanel`; a separate command opens `JobDetailPanel`.
**Answer**: A) Replace — `JobDetailPanel` supersedes `WorkItemDetailPanel` entirely. It can display both metadata (status, priority, timeline) AND phase/step progress in one view, with the progress section being contextual — live for running jobs, static for completed/failed ones. Two panels for the same entity would confuse users.

### Q5: Status Bar Item Visibility and Positioning
**Context**: The spec adds a new status bar item showing cloud job count alongside the existing `ExecutionStatusBarProvider` (which shows local execution status). Both could be visible simultaneously. The spec doesn't define the priority (left/right positioning), alignment (left vs. right side of status bar), or how it interacts with the existing execution status bar when both are active.
**Question**: Where should the cloud job count status bar item be positioned relative to the existing local execution status bar item, and should it be on the left or right side?
**Options**:
- A) Left side, next to existing: Place adjacent to the local execution status bar (left side, slightly lower priority so it appears to the right of local status). Both visible simultaneously.
- B) Right side: Place on the right side of the status bar alongside language/encoding indicators. Visually separated from local execution status.
- C) Merged: Combine into a single status bar item that shows both local and cloud status (e.g., "$(terminal) Running | $(cloud) 3 jobs"). Saves space but increases complexity.
**Answer**: A) Left side, next to existing — Local and cloud execution are closely related concepts. Placing them adjacent on the left side makes them easy to discover together. Merging adds complexity for marginal space savings, and right-side placement disconnects related indicators.

### Q6: Error State Recovery in JobDetailPanel
**Context**: The spec describes showing failed steps with inline error messages, but doesn't address how the `JobDetailPanel` handles scenarios where the SSE connection is lost while viewing a job, or what happens when a user opens a detail panel for a job that has already completed or failed (no more SSE events expected).
**Question**: How should `JobDetailPanel` handle SSE disconnection and viewing of already-completed/failed jobs?
**Options**:
- A) Polling fallback with banner: Show a "Reconnecting..." banner in the webview during SSE disconnection. Fall back to polling the progress endpoint every 5s. For completed/failed jobs, fetch once and display static view.
- B) Static snapshot only: For completed/failed jobs, fetch progress once and render statically (no SSE subscription needed). For running jobs during SSE disconnect, show stale data with a "Connection lost" warning and a manual Refresh button.
- C) Auto-close on disconnect: If SSE disconnects for more than 30s, close the detail panel and show a notification prompting the user to reopen when connectivity is restored.
**Answer**: A) Polling fallback with banner — Show a "Reconnecting..." banner during SSE disconnection and fall back to polling the progress endpoint every 5s. For completed/failed jobs, fetch once and display statically (no SSE subscription needed). This mirrors the architecture's reliability-first approach. Auto-close would be frustrating. The hybrid approach from Q1 makes reconnection recovery straightforward since the next full snapshot restores complete state.

### Q7: Phase/Step Expand/Collapse Default State
**Context**: The spec says phases show their steps "when expanded" (FR-007) but doesn't specify the default expand/collapse state when the detail panel opens. With potentially 8+ phases and many steps per phase (especially implementation phases), showing everything expanded could be overwhelming, while collapsing everything hides the most relevant information.
**Question**: What should the default expand/collapse state be when `JobDetailPanel` opens?
**Options**:
- A) Smart defaults: Currently-running phase expanded, completed phases collapsed, pending phases collapsed. Automatically expand a phase when it starts running.
- B) All expanded: Show everything expanded by default. User can collapse as needed. Simpler implementation.
- C) Current + previous expanded: Expand the currently-running phase and the most recently completed phase. All others collapsed.
**Answer**: A) Smart defaults — Currently-running phase expanded, completed and pending phases collapsed. Auto-expand a phase when it starts running. This surfaces the most relevant information without overwhelming the user — especially important for 8+ phase workflows with many implementation steps.

### Q8: Debounce Strategy for Rapid SSE Events
**Context**: During active workflow execution, phase/step start/complete events may arrive in rapid succession (e.g., multiple steps completing within milliseconds). The existing `QueueTreeProvider` uses a 200ms debounce for tree refreshes. The spec doesn't specify a debounce strategy for `JobDetailPanel` webview updates, which could cause visual flickering or excessive message passing if every event triggers an immediate DOM update.
**Question**: What debounce interval should be used for `JobDetailPanel` webview updates from SSE events?
**Options**:
- A) No debounce: Send every event immediately to the webview. The webview uses `requestAnimationFrame` for batched DOM updates. Most responsive but highest message volume.
- B) 200ms debounce (match tree): Buffer events for 200ms and send a single aggregated update. Consistent with existing tree behavior.
- C) Tiered debounce: Phase-level changes (start/complete) sent immediately (these are infrequent and important). Step-level changes debounced at 200ms. Balances responsiveness with efficiency.
**Answer**: C) Tiered debounce — Phase-level changes (start/complete) sent immediately — they're infrequent and high-signal. Step-level changes debounced at 200ms (matching existing tree behavior). This gives users instant feedback on major transitions while preventing flickering during rapid step completions.

### Q9: Handling of Skipped Phases/Steps
**Context**: The `PhaseProgress` and `StepProgress` types include a `skipped` status, but the spec doesn't describe when or why phases/steps would be skipped, how they should be visually distinguished from pending items, or whether skipped items should be included in the phase count (e.g., "Phase 5/8" — does 8 include skipped phases?).
**Question**: How should skipped phases/steps be displayed, and should they count toward the total in progress indicators?
**Options**:
- A) Exclude from count: Show "Phase 5/6" if 2 of 8 phases are skipped. Skipped items shown with a dimmed/strikethrough style and a skip icon.
- B) Include in count with distinct style: Show "Phase 5/8 (2 skipped)" in the tree. Skipped items shown with a grey dash icon and muted text in the detail view.
- C) Hide skipped entirely: Don't show skipped phases/steps in either the tree or detail view. Only show phases/steps that will actually execute.
**Answer**: B) Include in count with distinct style — Show "Phase 5/8 (2 skipped)" in the tree. Skipped items displayed with grey dash icon and muted text in the detail view. Hiding skipped phases confuses users who know the full workflow shape. Excluding from the count makes totals inconsistent across different job runs.

### Q10: Step Output Display
**Context**: The `StepProgress` type includes an optional `output?: string` field, but the spec explicitly lists log streaming as out of scope. It's unclear what `output` contains (a summary line? final result? truncated stdout?), how large it can be, and whether/how it should be displayed in the `JobDetailPanel`.
**Question**: What is the intended use of the `output` field on `StepProgress`, and should it be displayed in the detail panel?
**Options**:
- A) Summary line only: `output` contains a single-line summary (e.g., "Generated 3 files", "PR #42 created"). Display inline below the step name in the detail view.
- B) Full output with truncation: `output` contains potentially multi-line text (truncated to ~1KB by the orchestrator). Display in an expandable code block within the step.
- C) Remove from MVP: Drop the `output` field from `StepProgress` since log streaming is out of scope. Add it back when log streaming is implemented.
**Answer**: A) Summary line only — `output` contains a single-line summary (e.g., "Generated 3 files", "PR #42 created") displayed inline below the step name. Since log streaming is explicitly out of scope, full output risks scope creep. Summary lines still provide useful at-a-glance context for completed steps.

### Q11: Estimated Time Remaining Data Source
**Context**: FR-014 (P3) calls for showing estimated time remaining based on historical phase durations. The spec notes this "requires orchestrator to provide estimates" but lists it as a client-side feature. It's unclear whether the orchestrator will compute and send `estimatedRemainingMs` in progress events, or whether the extension should compute estimates locally from historical data it caches.
**Question**: Where should estimated time remaining be computed?
**Options**:
- A) Orchestrator-provided: The orchestrator sends `estimatedRemainingMs` in `workflow:progress` events based on its historical data. Extension just displays it. Simpler client but requires orchestrator work.
- B) Client-computed: Extension caches completed phase durations from past jobs and computes estimates locally. More complex client but no orchestrator dependency.
- C) Defer entirely: Remove FR-014 from this spec since it's P3 and depends on orchestrator capabilities not yet specified. Revisit as a follow-up feature.
**Answer**: C) Defer entirely — FR-014 is P3 and depends on orchestrator capabilities not specified in #176 or #177. Ship without it and revisit as a follow-up. Implementing client-side estimates would be inaccurate without sufficient historical data, and orchestrator-provided estimates add scope to an already-complex orchestrator build.

### Q12: Multiple Concurrent JobDetailPanels
**Context**: The spec says `JobDetailPanel` follows the preview/pin pattern from `WorkItemDetailPanel`. In that pattern, only one unpinned preview exists at a time, but users can pin panels to keep them open. With multiple running jobs, a user might want to monitor several jobs simultaneously. The spec doesn't clarify limits on pinned panels or how SSE subscriptions scale.
**Question**: Should there be a limit on the number of pinned `JobDetailPanel` instances, and how should SSE subscriptions be managed for multiple open panels?
**Options**:
- A) No limit: Users can pin as many panels as they want. Each panel filters the same `workflows` SSE subscription by its `jobId`. The shared subscription model means no additional connections.
- B) Limit to 5 pinned panels: Cap at 5 pinned panels. Show a warning when the user tries to pin a 6th. This prevents excessive memory usage from many concurrent webviews.
- C) Single panel, tab-based: Only one `JobDetailPanel` exists, but it supports tabbed navigation between multiple jobs within the same webview. Reduces resource usage but increases webview complexity.
**Answer**: A) No limit — Since the hybrid approach from Q1 uses a shared SSE subscription (panels just filter by `jobId`), there's no connection-per-panel overhead. VS Code's native webview lifecycle already handles resource management. An artificial limit adds code complexity for a scenario that self-regulates — users rarely pin more than a few panels anyway.
