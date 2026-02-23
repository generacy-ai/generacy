# Clarification Questions

## Status: Pending

## Questions

### Q1: SSE Channel Routing for Job Logs
**Context**: The existing `SSESubscriptionManager` supports three channels: `'workflows'`, `'queue'`, and `'agents'`. The `AgentLogChannel` subscribes to the `'agents'` channel and filters events by `agentId`. The spec references a per-job SSE endpoint (`GET /api/jobs/:jobId/logs?stream=true`) which implies a direct SSE connection per job, but the existing SSE infrastructure uses a single shared connection with channel-based multiplexing. These are fundamentally different approaches with different resource and complexity trade-offs.
**Question**: Should the job log SSE stream use the existing `SSESubscriptionManager` channel multiplexing (adding a new `'jobs'` or `'logs'` channel and filtering by jobId), or should each `JobLogChannel` establish its own dedicated SSE connection to the per-job endpoint?
**Options**:
- A) Shared SSE via SSESubscriptionManager: Add a `'jobs'` channel to the existing manager. All job log events flow through one connection, filtered client-side by jobId. Matches the `AgentLogChannel` pattern and reuses reconnection/Last-Event-ID infrastructure, but mixes high-volume log data with lower-volume orchestration events.
- B) Dedicated SSE connection per job: Each `JobLogChannel` opens its own SSE connection to `GET /api/jobs/:jobId/logs?stream=true`. More resource-intensive (one HTTP connection per open viewer) but isolates log traffic, allows per-job `Last-Event-ID` tracking, and matches the endpoint design from #178.
- C) Hybrid approach: Use a dedicated SSE connection per job for streaming, but leverage `SSESubscriptionManager` patterns (reconnection logic, state tracking) via a shared utility class.
**Answer**:

### Q2: Log Entry Format and Content Scope
**Context**: The spec defines a `LogEntry` with `{ timestamp, stream, stepName, content }` but doesn't specify what `content` actually contains. Claude CLI output includes structured conversation turns (user messages, assistant responses, tool calls with results, thinking blocks), ANSI escape codes, progress indicators, and raw text. The level of parsing/formatting applied before display significantly affects implementation complexity and user experience.
**Question**: What does `content` in a `LogEntry` represent — raw unprocessed CLI stdout/stderr lines, or pre-parsed/cleaned text? Specifically, should the extension expect and handle ANSI escape codes, or will the server strip them?
**Options**:
- A) Raw CLI output: The server sends stdout/stderr verbatim. The extension must strip ANSI codes before displaying in OutputChannel (which doesn't support ANSI rendering). Simple server-side, but extension must handle cleanup.
- B) Pre-cleaned plain text: The server strips ANSI codes and non-printable characters before sending. The extension displays content as-is. Cleaner contract, server does the work.
- C) Semi-structured text: The server does basic cleanup (strip ANSI) and adds minimal structure (e.g., prefixing tool call names), but content remains plain text suitable for OutputChannel.
**Answer**:

### Q3: Historical Log Pagination and Limits
**Context**: The spec mentions fetching historical logs via `GET /api/jobs/:jobId/logs` and assumes the server retains "at least 10,000 lines per job." For long-running jobs with verbose output, the log buffer could be very large. The spec says to "show count summary if truncated" but doesn't specify pagination strategy, maximum fetch size, or how to handle jobs with 50K+ lines of output.
**Question**: Should the historical log fetch retrieve all available lines in a single request, or use pagination? What is the maximum number of lines to fetch on initial load?
**Options**:
- A) Fetch all at once: Single request fetches the entire buffer (up to server limit). Simple implementation, but could be slow and memory-heavy for large logs. Show a loading indicator during fetch.
- B) Fetch last N lines with load-more: Fetch the most recent 5,000 lines initially. Show a "Load earlier logs" message at the top. User can trigger additional fetches. Similar to terminal scrollback.
- C) Fetch last N lines, no pagination: Fetch the most recent 10,000 lines. If truncated, show `--- Showing last 10,000 of {total} lines ---` header. No load-more capability in v1.
**Answer**:

### Q4: Channel Cleanup Timing for Terminal Jobs
**Context**: The spec says channels should be "automatically cleaned up when the job reaches a terminal state and the user closes the channel." This is ambiguous about the trigger: does cleanup happen automatically after a delay when a job completes, or only when the user explicitly closes the OutputChannel tab? VS Code's `OutputChannel` doesn't have a built-in "onClose" event, making user-initiated close detection non-trivial.
**Question**: When should a `JobLogChannel` be disposed for a completed/failed job?
**Options**:
- A) Manual close only: The channel stays open until the user explicitly closes the OutputChannel panel. No automatic cleanup. Simplest to implement since VS Code doesn't fire events when OutputChannels are closed.
- B) Auto-dispose after delay: Automatically dispose the channel N minutes after the job reaches a terminal state, even if the user hasn't closed it. Keeps resource usage bounded but may surprise users who are still reading.
- C) Dispose on session end: Keep channels alive for the VS Code session. Clean up all channels on extension deactivation via `disposeAll()`. Don't proactively close channels mid-session.
**Answer**:

### Q5: SSE Reconnection and Gap Handling
**Context**: The spec requires "no gap or duplication between historical and live data" (US2) and mentions `Last-Event-ID` for reconnection (FR-013). However, the transition from historical REST fetch to SSE subscription inherently has a race window: logs generated between the REST response and SSE connection could be missed. The spec doesn't describe how to handle this overlap.
**Question**: How should the historical-to-live transition be handled to prevent gaps or duplicates?
**Options**:
- A) Overlap with dedup: Include a `lastEventId` or `lastTimestamp` from the historical fetch. Start the SSE stream from that point (potentially re-sending some lines). Client-side dedup by event ID or timestamp+content hash. Guarantees no gaps at the cost of some complexity.
- B) Server-side cursor: The historical REST response includes a `cursor` or `streamToken` that can be passed to the SSE endpoint as a query parameter to resume exactly where the REST response ended. Requires server support from #178.
- C) Accept small gaps: Subscribe to SSE first, buffer events, then fetch historical, then flush buffered events (deduping). This "subscribe-then-fetch" pattern minimizes the gap window but adds client-side buffering complexity.
**Answer**:

### Q6: "View Logs" Button Visibility and State
**Context**: The spec says a "View Logs" action should be available from both the job detail panel and the queue tree context menu. However, it doesn't specify whether the button should be visible for all job states (including `pending` and `queued` jobs that haven't started and have no logs yet), or how the button should behave when logs are unavailable.
**Question**: Should the "View Logs" button/action be visible for jobs that haven't started executing yet (pending/queued state)?
**Options**:
- A) Always visible, show empty state: Show the button for all job states. For pending/queued jobs, open the channel with a message like "Waiting for job to start..." and auto-populate when logs become available.
- B) Hidden until running: Only show the button once the job has started (running/completed/failed/cancelled states). For pending/queued jobs, the button is not rendered.
- C) Visible but disabled: Show the button for all states, but disable it with a tooltip ("Job hasn't started yet") for pending/queued jobs. Enable it once the job transitions to running.
**Answer**:

### Q7: Step Boundary Detection Source
**Context**: The spec requires step boundaries displayed as separator lines (FR-006: `────── Step: step-name ──────`). The `LogEntry` interface has an optional `stepName` field, but it's unclear whether step transitions are detected by comparing consecutive `stepName` values in the log stream, or if there are explicit step-start/step-end events in the SSE stream. The existing `StepProgress` and `PhaseProgress` types in the codebase suggest a separate progress event system.
**Question**: How are step boundaries detected in the log stream — via changes in the `stepName` field on `LogEntry` objects, or via separate SSE events?
**Options**:
- A) LogEntry stepName changes: Each `LogEntry` includes the current `stepName`. When the `stepName` changes between consecutive entries, insert a separator. Simple but requires tracking previous stepName client-side.
- B) Explicit boundary events: The SSE stream sends distinct `job:step-start` / `job:step-end` events alongside `job:log` events. The `JobLogChannel` listens for both event types and inserts separators on boundary events.
- C) Derive from progress events: Listen to the existing `workflow:step` progress events on the `'workflows'` SSE channel (already used by `JobDetailPanel`) to detect step transitions, cross-referencing with the log stream by timing.
**Answer**:

### Q8: OutputChannel Naming Collision
**Context**: The spec says each job gets its own named OutputChannel (e.g., "Job: workflow-name (job-id-short)"). If a user runs the same workflow multiple times, multiple channels would have very similar names differentiated only by a short job ID suffix. The spec doesn't define what "job-id-short" means (first 8 chars of UUID? a sequential number?) or how to handle name readability.
**Question**: What format should be used for the OutputChannel name, and how should the job ID be shortened?
**Options**:
- A) First 8 chars of UUID: `"Job: my-workflow (a1b2c3d4)"`. Concise and unique enough to avoid collisions. Matches common git short-hash conventions.
- B) Workflow name + sequential number: `"Job: my-workflow #3"`. More human-readable but requires tracking run counts, and the number may not match any server-side concept.
- C) Workflow name + timestamp: `"Job: my-workflow (14:32)"`. Immediately tells the user when the job started. May collide if two jobs start in the same minute.
**Answer**:

### Q9: Error Handling for Unavailable Log Endpoint
**Context**: The spec assumes #178 is implemented and the log endpoints exist. However, during development or if the worker version is older, the endpoints may return 404 or 500. The spec doesn't describe the user-facing error experience when logs cannot be fetched.
**Question**: How should the extension handle failures when the log endpoints are unavailable or return errors?
**Options**:
- A) Error message in OutputChannel: Open the channel and display an error message inline (e.g., `"Failed to load logs: Server returned 404. The job worker may not support log streaming."`). Keep the channel open for the user to see.
- B) Error notification + no channel: Show a VS Code error notification toast and don't open/create the OutputChannel. User can retry via the button.
- C) Graceful degradation with retry: Open the channel, show the error, and offer a retry mechanism. Display `"Retrying in 10s..."` and attempt periodic retries (3 attempts max) before giving up with a final error message.
**Answer**:

### Q10: Memory Management for Long-Running Jobs
**Context**: The spec notes that log volume is "typically < 100K lines" but doesn't address what happens when a long-running job produces significantly more output. VS Code's `OutputChannel.appendLine()` accumulates all text in memory with no built-in eviction. A job producing 200K+ lines could consume significant memory in the extension host process.
**Question**: Should the extension implement any memory protection for very long-running jobs with high log volume?
**Options**:
- A) No limit in v1: Trust that OutputChannel handles it. Accept potential memory pressure for extremely verbose jobs. Document the limitation and address in a future iteration if it becomes a real issue.
- B) Line count cap with rotation: After reaching a threshold (e.g., 50K lines), clear the channel and re-display the last 25K lines with a `"--- Earlier output truncated (showing last 25,000 lines) ---"` header. Prevents unbounded growth.
- C) Warning at threshold: After 50K lines, append a warning `"--- Log output is very large. Performance may degrade. ---"` but continue appending. Let the user decide whether to close the channel.
**Answer**:

### Q11: Coordination with Job Detail Panel SSE
**Context**: The `JobDetailPanel` already subscribes to the `'workflows'` SSE channel for progress events and has terminal-state detection logic. If a user has both the job detail panel and the log viewer open for the same job, there would be two independent SSE subscriptions tracking the same job's lifecycle. The spec doesn't address whether these should share state or coordinate.
**Question**: Should the `JobLogChannel` detect job terminal state independently (via its own SSE events or REST polling), or should it coordinate with the `JobDetailPanel`?
**Options**:
- A) Independent detection: `JobLogChannel` detects terminal state from its own SSE stream (e.g., a `job:completed` event on the log stream, or the SSE stream closing). No coupling to `JobDetailPanel`. Simpler, more self-contained.
- B) Shared job state service: Extract job state tracking into a shared service that both `JobDetailPanel` and `JobLogChannel` subscribe to. Reduces duplicate SSE subscriptions but adds architectural complexity.
- C) Event-driven from log stream end: The SSE log stream endpoint sends a final event (e.g., `job:log:end`) with the terminal status when the job completes, then closes the connection. `JobLogChannel` handles this terminal event to display final status and stop streaming. No coordination with detail panel needed.
**Answer**:
