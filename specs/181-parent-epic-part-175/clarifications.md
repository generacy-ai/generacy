# Clarification Questions

## Status: Pending

## Questions

### Q1: SSE Event Type Mismatch
**Context**: The spec references subscribing to `queue:item:updated` events, but the existing codebase uses `queue:updated` as the event type for item updates (see `provider.ts:384`). The `ActivityEventType` union also does not include `queue:item:updated` or `queue:updated`. This mismatch could cause the notification manager to never receive terminal status events.
**Question**: Should the implementation listen for the existing `queue:updated` event type, or should a new `queue:item:updated` event type be added to the SSE protocol?
**Options**:
- A) Use existing `queue:updated`: Listen for `queue:updated` (the event type already emitted by the orchestrator and handled by the queue provider). No backend changes needed.
- B) Add new `queue:item:updated`: Add a new dedicated event type to the SSE protocol specifically for terminal status transitions. Requires orchestrator changes.
**Answer**:

### Q2: Relationship with Existing NotificationManager
**Context**: The spec says the new `NotificationManager` in `src/services/notification-manager.ts` "replaces and extends" the existing `src/utils/notifications.ts`. However, the existing `NotificationManager` handles all SSE events across all channels (workflows, queue, agents) with a generic batching/summary mechanism and is currently wired into `cloud.ts`. The spec's new service is job-completion-specific. Replacing the existing one entirely could break dashboard-level notifications.
**Question**: Should the new `NotificationManager` fully replace the existing one, or should it be a separate, complementary service focused only on job terminal notifications?
**Options**:
- A) Replace entirely: Remove `src/utils/notifications.ts` and consolidate all notification logic into the new service, including handling non-job events.
- B) Separate service: Keep the existing `NotificationManager` for dashboard/general events and create the new service alongside it with a distinct name (e.g., `JobNotificationService`).
- C) Migrate incrementally: Create the new service, migrate job-specific notifications to it, and deprecate the old one for removal in a future PR.
**Answer**:

### Q3: Missing `failedStep` Field in Event Payload
**Context**: The spec assumes the SSE event payload includes a `failedStep` field for failure notifications (US2: "the step that failed"). However, the existing `QueueItem` interface has only an `error` string field — no `failedStep`. The `JobProgress` object has full phase/step detail but is not part of the queue SSE event payload. To show "failed at step X", the notification manager would need to either (a) fetch `JobProgress` via API, or (b) derive it from workflow SSE events.
**Question**: How should the notification manager obtain the failed step name for failure notifications?
**Options**:
- A) Fetch JobProgress on failure: When a `queue:updated` event with `status: 'failed'` arrives, make a `GET /queue/:id/progress` API call to retrieve the full `JobProgress` and find the failed step/phase.
- B) Track workflow events: Subscribe to the `workflows` SSE channel and maintain in-memory state of the latest phase/step per job, so it's available when the terminal event fires.
- C) Extend queue event payload: Add `failedStep` and `failedPhase` fields to the `queue:updated` SSE event payload (requires orchestrator changes).
- D) Use error string only: Show only the `error` field from `QueueItem` in failure notifications without identifying the specific step.
**Answer**:

### Q4: Missing PR Information in Queue Events
**Context**: The spec assumes the SSE event payload includes `prUrl` for showing PR number and title in success notifications with a "View PR" button. However, `QueueItem` has no `prUrl` field. The `pullRequestUrl` field exists only on `JobProgress`. Similarly, there is no `prTitle` or `prNumber` field in any existing type.
**Question**: How should the notification manager obtain PR information for success notifications?
**Options**:
- A) Fetch JobProgress on completion: When a completion event arrives, make a `GET /queue/:id/progress` API call to get `pullRequestUrl` from `JobProgress`.
- B) Track workflow phase events: Listen for `workflow:phase:complete` events on the `workflows` channel to capture `pullRequestUrl` when the PR-creation phase completes.
- C) Extend queue event payload: Add `pullRequestUrl` to the `queue:updated` SSE event (requires orchestrator changes).
**Answer**:

### Q5: `continueOnError` in Cloud Context
**Context**: US3 describes non-interrupting step failures for `continueOnError` steps. However, `continueOnError` is a property of local workflow step definitions (`src/views/local/runner/types.ts:49`), not of cloud `StepProgress` or SSE event payloads. The cloud orchestrator's step events (`WorkflowStepEventData`) contain a `StepProgress` snapshot that has `status` and `error` but no `continueOnError` flag.
**Question**: Is `continueOnError` step failure handling applicable to cloud jobs, and if so, how is the flag surfaced?
**Options**:
- A) Out of scope for cloud: Remove US3 from this spec since `continueOnError` is a local execution concept. Cloud jobs emit only terminal job-level statuses.
- B) Extend cloud step events: Add a `continueOnError` flag to `StepProgress` / `WorkflowStepEventData` in the orchestrator (requires backend changes).
- C) Infer from behavior: If a step fails but the job continues running (no terminal status), treat it as a `continueOnError` step. Flash the status bar but suppress toast.
**Answer**:

### Q6: `generacy.queue.viewProgress` Command Status
**Context**: The spec references `generacy.queue.viewProgress` as the command for "View Details" and "View Logs" action buttons. This command is declared in `package.json` but has no `registerCommand` implementation. The actual detail panel is opened via `generacy.queue.viewDetails` which is registered in `actions.ts`.
**Question**: Should the notification manager use the existing `generacy.queue.viewDetails` command, or should `generacy.queue.viewProgress` be implemented as part of this feature?
**Options**:
- A) Use existing `viewDetails`: Wire action buttons to `generacy.queue.viewDetails` since it already opens `JobDetailPanel`.
- B) Implement `viewProgress`: Register `generacy.queue.viewProgress` as part of this PR, potentially with additional parameters (e.g., scroll-to-error for "View Logs").
**Answer**:

### Q7: Configuration Namespace Conflict
**Context**: The spec introduces `generacy.notifications.enabled` as a master toggle, but an existing setting `generacy.dashboard.notifications` (with values `'all'`, `'summary'`, `'none'`) already controls notification behavior. Having two overlapping notification settings could confuse users — if `generacy.dashboard.notifications` is `'none'` but `generacy.notifications.enabled` is `true`, what happens?
**Question**: How should the new notification settings coexist with the existing `generacy.dashboard.notifications` setting?
**Options**:
- A) Replace the old setting: Deprecate `generacy.dashboard.notifications` and use only the new `generacy.notifications.*` settings for all notification control.
- B) Separate scopes: Keep both — `generacy.dashboard.notifications` controls dashboard/orchestrator panel notifications, and `generacy.notifications.*` controls job completion toasts. Document the distinction.
- C) Unify under new namespace: Migrate the old setting's functionality into the new `generacy.notifications.*` namespace (e.g., add `generacy.notifications.dashboard` with `'all'|'summary'|'none'`).
**Answer**:

### Q8: Deduplication Bound and Persistence
**Context**: FR-015 specifies tracking seen event IDs in a "bounded Set" to prevent duplicate notifications after SSE reconnection with `Last-Event-ID` replay. The spec doesn't define the bound size or whether it should persist across extension restarts.
**Question**: What should be the size limit of the deduplication set, and should it persist across VS Code sessions?
**Options**:
- A) In-memory, small bound: Keep last 100 event IDs in memory only. Restarting VS Code clears the set (acceptable since restart re-establishes SSE without replay).
- B) In-memory, large bound: Keep last 1000 event IDs in memory to handle long-running sessions with many jobs.
- C) Persisted: Store seen event IDs in `ExtensionContext.globalState` so they survive restarts (handles edge case of restart during SSE reconnection).
**Answer**:

### Q9: Status Bar Flash Animation Mechanism
**Context**: FR-013 specifies the status bar should "flash/animate" on job completion or failure with a "brief icon/color change, revert after 3-5 seconds." VS Code's `StatusBarItem` API supports changing `backgroundColor` to `statusBarItem.errorBackground` or `statusBarItem.warningBackground`, but true animation (pulsing, blinking) is not natively supported.
**Question**: What visual treatment should the status bar flash use?
**Options**:
- A) Background color change: Set `backgroundColor` to error/warning theme color for 3 seconds, then revert. Simple and native.
- B) Icon swap with color: Change both the icon (e.g., checkmark or X) and background color for 3 seconds, then revert.
- C) Text update: Temporarily replace the running count text with a brief message (e.g., "Job completed") for 3 seconds, then revert to the count.
**Answer**:

### Q10: Sound Notification Implementation
**Context**: FR-012 mentions using "VS Code accessibility sound API if available." VS Code does not have a public sound playback API. The `window.showInformationMessage` API has no sound parameter. Some extensions use `vscode.env.openExternal` with a custom URI or play sounds via Node.js `child_process`, but these are non-standard.
**Question**: How should sound notifications be implemented given the lack of a VS Code sound API?
**Options**:
- A) Skip for now: Mark sound support as P3/deferred since there's no clean VS Code API. Document it as a future enhancement.
- B) Use terminal bell: Write a BEL character (`\x07`) to the integrated terminal, which triggers the system alert sound if the terminal is configured for it.
- C) Node.js audio: Use a Node.js audio library (e.g., `play-sound`) bundled with the extension to play a bundled audio file.
**Answer**:

### Q11: Notification Behavior During Focus/Unfocus
**Context**: VS Code notifications behave differently depending on window focus. When VS Code is focused, toasts appear in the bottom-right. When minimized or unfocused, notifications may be silently queued. The spec doesn't address whether notifications should be batched, delayed, or shown individually when the user returns to VS Code after being away.
**Question**: Should job notifications that arrive while VS Code is unfocused be shown individually when the user returns, or batched into a summary?
**Options**:
- A) Show individually: Each terminal event gets its own notification toast regardless of focus state. VS Code handles queuing natively.
- B) Batch when unfocused: If 3+ notifications accumulated while unfocused, show a single summary notification (e.g., "3 jobs completed, 1 failed") with a "View Queue" action.
**Answer**:

### Q12: Multiple Concurrent Job Completions
**Context**: If a user has many jobs running and several complete within seconds of each other, they could receive a flood of notification toasts. The spec doesn't address rate limiting or grouping of notifications.
**Question**: Should there be rate limiting or grouping when multiple jobs complete in rapid succession?
**Options**:
- A) No rate limiting: Show each notification individually. Users can disable notifications via settings if overwhelmed.
- B) Rate limit with grouping: If more than 3 notifications would fire within 10 seconds, group them into a single summary notification.
- C) Sequential with delay: Show notifications sequentially with a 2-second minimum gap between toasts to avoid overwhelming the user.
**Answer**:
