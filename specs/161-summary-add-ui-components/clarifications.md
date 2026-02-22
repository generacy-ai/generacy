# Clarification Questions

## Status: Pending

## Questions

### Q1: SSE Migration Strategy for Queue Tree Provider
**Context**: The existing `QueueTreeProvider` uses polling (30s default) for updates. The spec requires SSE as the primary real-time mechanism (FR-004) with polling as fallback (FR-010). This is a significant architectural change to an existing component—we need to decide how to integrate SSE without breaking the current polling behavior.
**Question**: Should the queue tree provider be refactored to use SSE as primary with polling fallback, or should SSE be additive (used only for the new dashboard/agent views) while the queue tree keeps its current polling approach?
**Options**:
- A) Refactor queue to SSE-primary: Migrate `QueueTreeProvider` to subscribe to SSE events (`queue:item:added`, `queue:updated`, etc.) for real-time updates, falling back to polling only when SSE is disconnected. All views share one SSE connection.
- B) SSE for new views only: Keep `QueueTreeProvider` polling as-is. Use SSE only for the new dashboard and agent views. This minimizes risk to existing functionality but means queue updates arrive at different speeds depending on the view.
- C) Shared SSE manager with opt-in: Create a centralized SSE subscription manager in the extension that any view can subscribe to. Refactor queue to use it, but keep polling as an always-on secondary mechanism for data integrity.
**Answer**:

### Q2: Dashboard Layout and Placement
**Context**: The spec says the dashboard opens via command palette or sidebar icon (US1), and the technical design shows a `WebviewViewProvider`. VS Code supports webviews as editor panels (like the existing `OrgDashboardPanel` which uses `createWebviewPanel`) or as sidebar/panel views (using `registerWebviewViewProvider`). The placement affects available screen real estate and user workflow.
**Question**: Should the orchestration dashboard be a full editor-tab webview panel (like the existing org dashboard), a sidebar webview view, or both?
**Options**:
- A) Editor tab panel: Opens as a tab in the editor area using the existing `createWebviewPanel` pattern. Provides maximum space for the three-section layout (queue summary, agent summary, activity feed).
- B) Sidebar webview view: Registers as a webview in the sidebar/panel area. More compact, always accessible, but limited horizontal space may not accommodate the grid layout described in the spec.
- C) Both: Register a sidebar summary view (compact stats) and a command to open a full editor panel with the detailed dashboard. The sidebar acts as a quick glance; the panel is the full experience.
**Answer**:

### Q3: Agent Status Terminology Mapping
**Context**: The spec uses status values "available", "busy", and "offline" (US1, US3), but the existing orchestrator agent code uses "connected", "idle", "busy", and "disconnected" as status values. The spec's terminology doesn't map 1:1 to the existing backend statuses—for instance, "available" could mean "connected" or "idle" or both, and "offline" likely maps to "disconnected".
**Question**: How should the UI map between the spec's agent statuses and the orchestrator's existing status values?
**Options**:
- A) Map directly: "available" = "idle", "busy" = "busy", "offline" = "disconnected", ignore "connected" (treat as transitional to "idle").
- B) Show all four statuses: Display the orchestrator's actual statuses (connected, idle, busy, disconnected) in the UI instead of the spec's three-status model. More accurate but potentially more complex for users.
- C) Map with grouping: "available" = "connected" + "idle" (both mean ready for work), "busy" = "busy", "offline" = "disconnected". The UI shows three groups but the detail panel shows the precise status.
**Answer**:

### Q4: Queue Priority Adjustment Semantics
**Context**: The spec says priority can be "adjusted (up/down)" via context menu (US2, FR-005), and the existing codebase defines priority as an enum: `'low' | 'normal' | 'high' | 'urgent'`. The spec doesn't clarify whether "up/down" means moving to the next/previous priority level in this enum, setting an absolute priority, or reordering within the queue.
**Question**: What does "adjust priority up/down" mean for queue items?
**Options**:
- A) Step through levels: "Up" moves to the next higher level (e.g., normal → high), "Down" moves to the next lower level (e.g., high → normal). Capped at "urgent" and "low".
- B) Set absolute priority: Show a quick-pick dropdown letting the user choose from all four priority levels (low, normal, high, urgent) directly.
- C) Both: Provide inline up/down buttons for quick adjustment and a context menu option to set a specific priority level.
**Answer**:

### Q5: Work Item Detail Panel Lifecycle
**Context**: The spec says clicking a work item opens a detail webview panel (US4, FR-007). When multiple items are clicked, it's unclear whether each opens its own panel (potentially many tabs), reuses a single panel (losing previous detail), or uses a side-by-side layout. The existing org dashboard uses a singleton panel pattern.
**Question**: How should multiple work item detail panels be managed?
**Options**:
- A) Singleton reuse: One detail panel that updates its content when a different item is selected. Simple, no tab clutter, but you can't compare two items.
- B) Multiple panels: Each item opens its own panel tab. Allows comparison but can clutter the editor with many tabs.
- C) Singleton with pinning: Default to reusing one panel, but provide a "pin" action that keeps the current panel open and opens a new one for the next selection (similar to VS Code's preview tab behavior).
**Answer**:

### Q6: Activity Feed Event Types and Content
**Context**: The spec mentions the activity feed shows "workflow starts, completions, failures, agent assignments" (US1) and references a new `GET /activity` endpoint. However, the existing SSE infrastructure already emits granular events (workflow:started, workflow:completed, workflow:failed, queue:item:added, agent:connected, etc.). It's unclear whether the activity feed is a server-side aggregation of these events or a client-side view over the SSE event stream.
**Question**: Should the activity feed be driven by the new `GET /activity` REST endpoint (server-aggregated) or by accumulating SSE events on the client side?
**Options**:
- A) Server-aggregated (REST): The `GET /activity` endpoint returns pre-aggregated, human-readable activity entries. The feed loads initial data from REST and appends new items from SSE. Server owns the activity log format and persistence.
- B) Client-side accumulation: The extension listens to SSE events and builds the activity feed locally. No new endpoint needed (remove `GET /activity` from scope). Simpler backend but feed is lost on extension restart.
- C) Hybrid: Use `GET /activity` for initial load (last 20 historical events) and SSE for real-time additions. This provides persistence and real-time updates but requires both mechanisms.
**Answer**:

### Q7: Agent Log Streaming Implementation
**Context**: The spec requires agent logs accessible via output channel (US3, FR-009) and lists a new `GET /agents/:id/logs` endpoint. It's unclear whether this endpoint returns historical logs as a batch, streams logs in real-time (SSE or chunked response), or both. The implementation approach significantly affects the output channel behavior.
**Question**: How should agent log streaming work between the API and the VS Code output channel?
**Options**:
- A) REST batch + SSE stream: `GET /agents/:id/logs` returns recent historical logs. New log lines arrive via SSE on a per-agent channel. The output channel shows history on open, then appends live lines.
- B) SSE-only streaming: Logs stream in real-time via SSE subscription with an agent filter. No historical logs—the output channel only shows logs from the moment it's opened.
- C) REST polling: `GET /agents/:id/logs` returns paginated log entries. The output channel polls periodically for new entries. Simpler but higher latency.
**Answer**:

### Q8: Error Handling for Unavailable New Endpoints
**Context**: The spec acknowledges that new API endpoints (priority, retry, assign, logs, activity) may not be available yet (Dependencies table, risk mitigation mentions "graceful degradation"). However, it doesn't specify what "graceful degradation" looks like in the UI—should actions be hidden, disabled with tooltip, or shown with an error on click?
**Question**: How should the UI handle actions that depend on not-yet-implemented API endpoints?
**Options**:
- A) Hide unavailable actions: Don't show context menu items or buttons for features whose endpoints return 404. Actions appear once endpoints are deployed. Cleaner but users won't know features are coming.
- B) Show disabled with tooltip: Display all actions but disable those whose endpoints aren't available. Show a tooltip like "This feature requires orchestrator v2.x". Users can see what's planned.
- C) Show and fail gracefully: Display all actions. If an endpoint returns 404, show a user-friendly message: "This feature is not yet available on your orchestrator version." Users discover limitations naturally.
**Answer**:

### Q9: Notification Toast Scope and Frequency
**Context**: FR-012 mentions notification toasts for "critical events (agent offline, work item failed)" as P3. In a system with many agents and work items, frequent toast notifications could become overwhelming and disruptive. The spec doesn't define thresholds, deduplication, or user preferences for notifications.
**Question**: How should notification toasts be scoped and rate-limited?
**Options**:
- A) All critical events: Show a toast for every agent going offline and every work item failure. Simple implementation but potentially noisy in large deployments.
- B) Batched/deduplicated: Aggregate notifications over a short window (e.g., 10 seconds). "3 agents went offline" instead of 3 separate toasts. Reduces noise but adds complexity.
- C) User-configurable: Add a setting `generacy.dashboard.notifications` with options: "all", "summary", "none". Default to "summary" (batched). Users can opt in to verbose or opt out entirely.
**Answer**:

### Q10: Tree View Grouping and Default View Mode
**Context**: FR-002 mentions "status/repo/assignee grouping modes" for the queue tree view. The existing `QueueTreeProvider` already supports `flat`, `byStatus`, `byRepository`, and `byAssignee` view modes. The spec doesn't specify the default view mode or how the user switches between them. The agent tree view (FR-003) doesn't mention any grouping modes.
**Question**: What should the default grouping mode be for the queue tree view, and should the agent tree view support grouping?
**Options**:
- A) Queue defaults to byStatus, agents flat: Queue tree defaults to grouping by status (pending/in-progress/completed/failed sections). Agent tree shows a flat list sorted by status (available first, offline last). Users switch queue grouping via a view action button.
- B) Queue defaults to flat, agents flat: Both start flat for simplicity. Grouping is available through a dropdown/toggle button in the tree view title bar. Less visual structure but simpler initial experience.
- C) Queue defaults to byStatus, agents by status: Both tree views group by status as default. Consistent behavior across views. Agent tree groups into "Available", "Busy", "Offline" sections.
**Answer**:

### Q11: Queue Item Cancel vs Workflow Cancel
**Context**: The spec says "an in-progress item can be cancelled via context menu" (US2) and maps this to `DELETE /workflows/:id` (existing endpoint). However, the queue and workflow are distinct concepts in the codebase—a queue item references a workflow but they have separate lifecycles. Cancelling could mean removing the item from the queue, cancelling the underlying workflow, or both.
**Question**: When a user cancels an in-progress queue item, what should happen?
**Options**:
- A) Cancel workflow only: Call `DELETE /workflows/:id` to cancel the underlying workflow. The queue item status will update to "cancelled" as a side effect of the workflow cancellation event.
- B) Cancel both explicitly: Cancel the workflow via `DELETE /workflows/:id` AND update the queue item status. Ensures both entities are in a consistent cancelled state even if event propagation fails.
- C) Cancel queue item only: Remove/cancel the queue item without affecting the running workflow. The workflow continues but is "untracked" from the queue. This seems unlikely to be desired but should be clarified.
**Answer**:

### Q12: Confirmation Dialogs for Destructive Actions
**Context**: The spec mentions "confirmation" for cancellation (US2) but doesn't specify the confirmation UX for other potentially destructive actions like retry (which may re-execute work) or manual dispatch (which overrides automatic assignment). Consistent confirmation behavior is important for user trust.
**Question**: Which queue actions should require confirmation dialogs?
**Options**:
- A) Cancel only: Only cancellation shows a confirmation dialog ("Are you sure you want to cancel this work item?"). Retry and dispatch proceed immediately since they're constructive actions.
- B) Cancel and retry: Both cancellation and retry require confirmation. Retry confirmation shows what will be re-executed. Manual dispatch proceeds without confirmation since the user explicitly chose the agent.
- C) All destructive/override actions: Cancel, retry, and manual dispatch all require confirmation. Manual dispatch confirmation shows the target agent and warns that it overrides automatic assignment.
**Answer**:

### Q13: Dashboard Empty State Content
**Context**: US1 mentions "a meaningful empty state when no data is available" but doesn't define what "meaningful" looks like. The empty state could appear when the orchestrator has no workflows, no agents, or when the extension first connects. The content shown affects user onboarding and understanding.
**Question**: What should the dashboard empty state display?
**Options**:
- A) Simple message: Show "No orchestration data available" with a refresh button. Minimal, gets out of the way.
- B) Guided setup: Show contextual messages per section—"No work items in queue. Create a workflow to get started." / "No agents connected. See documentation to register agents." Includes links to relevant commands or docs.
- C) Connection status focused: Show the orchestrator connection status prominently. If connected but empty, show "Connected to orchestrator — no active workflows." If disconnected, show troubleshooting steps.
**Answer**:

### Q14: Pagination Strategy for Large Queues
**Context**: The risks section mentions "large queue / agent counts degrade performance" and suggests pagination in tree providers and limiting activity feed to 50 items. However, the spec doesn't define pagination UX—whether to use "Load More" nodes in the tree, virtual scrolling, or fixed page sizes. The existing `QueueTreeProvider` doesn't implement pagination.
**Question**: How should pagination be implemented for large queue and agent lists?
**Options**:
- A) Load More tree node: Show the first N items (e.g., 50) with a "Load More..." tree item at the bottom that fetches the next page. Simple, standard VS Code tree pattern.
- B) Fixed page with navigation: Show a fixed page of items with "Previous/Next" actions in the tree view title. More structured but unusual for tree views.
- C) Auto-expand on scroll: Load items incrementally as the user scrolls through the tree view. Seamless but harder to implement with VS Code's TreeDataProvider API.
**Answer**:

### Q15: Extension Package.json Contributions
**Context**: The spec defines new commands (e.g., `generacy.openDashboard`), tree views (agent list), and configuration settings (e.g., `generacy.dashboard.pollInterval`) but doesn't enumerate the full set of `package.json` contribution points needed. VS Code extensions require explicit declarations of views, commands, menus, and configuration in `package.json`. Missing declarations will cause features to silently not appear.
**Question**: Should the spec include an explicit list of all `package.json` contribution points (commands, views, menus, configuration) that need to be added?
**Options**:
- A) Yes, enumerate all contributions: Add a section listing every new command ID, view container, view, menu contribution, and configuration key. This serves as a checklist for implementation and review.
- B) No, derive from requirements: Let the implementer derive the needed contributions from the functional requirements. The spec stays at a higher abstraction level.
**Answer**:

