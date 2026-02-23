# Clarification Questions

## Status: Pending

## Questions

### Q1: Event Type Mapping Between Executor and SSE
**Context**: The `ExecutionEventEmitter` in the workflow engine emits 14 event types (e.g., `step:start`, `action:retry`), but the orchestrator's existing `SSEEventType` union already defines its own overlapping set (e.g., `step:started`, `step:completed`, `step:failed`). The naming conventions differ — executor uses past-tense-less forms (`step:start`) while orchestrator uses past tense (`step:started`). The spec doesn't address how to reconcile these two type systems.
**Question**: Should the worker forward executor events using the executor's native type names (adding them as new SSE event types), or should events be translated into the orchestrator's existing naming convention before broadcasting?
**Options**:
- A) Forward native executor types: Add all 14 executor event types (e.g., `step:start`, `action:retry`) as new entries in the orchestrator's `SSEEventType` union. Extension maps them back to `ExecutionEvent` format on receipt.
- B) Translate to orchestrator conventions: Worker or orchestrator maps executor events to the existing orchestrator naming (e.g., `step:start` → `step:started`). Requires defining mappings for the 8 event types that don't exist in the orchestrator yet (`step:output`, `action:start`, `action:complete`, `action:error`, `action:retry`, `phase:error`, `execution:cancel`, `execution:error`).
- C) Namespace executor events: Prefix executor events in a new namespace (e.g., `executor:step:start`) to avoid collision with existing orchestrator workflow events, keeping both systems independent.
**Answer**:

---

### Q2: SSE Channel Strategy for Executor Events
**Context**: The existing SSE infrastructure uses three channels: `workflows`, `queue`, and `agents`. The spec says executor events should be broadcast on the `workflows` channel, but executor events are much higher volume (50-200/min per workflow) compared to current workflow-level state changes. Mixing fine-grained executor events with coarse workflow state changes on the same channel means all `workflows` channel subscribers (including the existing orchestrator dashboard) would receive high-frequency executor events they don't need.
**Question**: Should executor events be broadcast on the existing `workflows` channel or on a new dedicated channel?
**Options**:
- A) New `execution` channel: Add a dedicated SSE channel for executor events. Existing dashboard subscribes only to `workflows`; the extension subscribes to both `workflows` and `execution` when monitoring a job. Clean separation of concerns.
- B) Use existing `workflows` channel with type filtering: Broadcast everything on `workflows` and rely on clients to filter by event type. Simpler server-side but increases bandwidth to all subscribers.
- C) Sub-channels: Extend the channel model to support `workflows:events` and `workflows:logs` sub-channels alongside the existing `workflows` channel. More granular but requires changes to the subscription manager.
**Answer**:

---

### Q3: Conversation Log Streaming Format
**Context**: The spec says Claude process stdout is captured as raw text chunks (up to 4KB) and streamed to the extension. However, US2 requires that "tool calls and tool responses are visually distinguishable in the output." Raw stdout text doesn't inherently distinguish between tool calls and responses — that requires parsing Claude's output format. The spec doesn't define whether parsing happens on the worker, orchestrator, or extension side.
**Question**: Where should Claude output parsing (to distinguish tool calls, tool responses, and reasoning) occur, and what format should the log stream use?
**Options**:
- A) Raw text, extension parses: Stream raw stdout as-is. Extension parses Claude output format to apply visual differentiation. Simplest server-side but couples extension to Claude's output format.
- B) Worker pre-parses into structured chunks: Worker parses Claude stdout into structured segments (`{ type: 'tool_call' | 'tool_response' | 'reasoning' | 'text', content: string }`). More processing on the worker but cleaner client experience.
- C) Worker tags boundaries only: Worker inserts lightweight boundary markers (e.g., `<!-- tool_call_start -->`) into the text stream when it detects tool call patterns. Extension uses markers for styling but still receives mostly raw text. Middle ground.
**Answer**:

---

### Q4: Authentication for Worker-to-Orchestrator Event POSTs
**Context**: The spec says to "reuse existing worker-to-orchestrator auth" (FR-010), but the current worker codebase (`src/worker/`) only communicates with Redis for heartbeats — there's no existing HTTP client or auth token setup for worker-to-orchestrator REST calls. The orchestrator supports API key auth (`X-API-Key`) and JWT auth (`Authorization: Bearer`), but the worker doesn't currently hold either credential.
**Question**: How should workers authenticate when POSTing events and logs to the orchestrator?
**Options**:
- A) Dedicated worker API key: Provision each worker with an API key (scoped to `workflows:write`) at startup via environment variable. Simple and stateless. Requires key management.
- B) Worker JWT from Redis: Orchestrator writes a short-lived JWT to Redis during job assignment; worker reads it and uses Bearer auth. Token is scoped to the specific workflow. More secure but adds Redis coordination.
- C) Shared service-to-service secret: Use a single shared secret (HMAC-signed requests) between all workers and the orchestrator. No per-worker keys needed, but less granular access control.
**Answer**:

---

### Q5: Connection Pool Behavior at Limit
**Context**: The spec states a 3-connection-per-user SSE limit (matching the existing `maxConnectionsPerClient: 3` config). The extension needs one event stream + one log stream per monitored workflow, meaning a user can only monitor 1 workflow simultaneously (2 connections) with 1 connection spare, or at most 1.5 workflows. This seems restrictive given US3 describes a dashboard showing multiple running jobs with live-updating progress.
**Question**: How should the extension handle the connection limit when a user wants to monitor multiple running workflows?
**Options**:
- A) Increase connection limit: Raise `maxConnectionsPerClient` to 6 or 8 to support monitoring 3-4 workflows simultaneously. Simple but increases orchestrator resource usage.
- B) Multiplex events over a single connection: Use one SSE connection for all executor events (filtered server-side by a list of workflow IDs) and one for all logs. Maximum 2 connections regardless of monitored workflows. Requires extending the subscription filter model.
- C) Single active + dashboard polling: Only the actively-viewed workflow gets SSE connections. The dashboard uses REST polling for status summaries of other workflows. Limits real-time to the focused job.
- D) Combine event and log streams: Merge executor events and conversation logs into a single SSE stream per workflow (differentiated by event type). Halves connection usage to 1 per workflow, allowing 3 simultaneous.
**Answer**:

---

### Q6: Buffering Discrepancy Between Spec and Existing Code
**Context**: The spec calls for expanded buffers — 200 events with 5-minute retention (FR-005) and 500KB log buffers with 10-minute retention (FR-006). The existing `SSESubscriptionManager` defaults are 100 events and 60-second retention. The spec's `SC-007` success criterion targets <50MB for 100 concurrent workflows. With 200 events + 500KB logs per workflow, 100 workflows could use up to ~70MB (rough estimate), exceeding the target.
**Question**: Should we use the spec's proposed buffer sizes, or adjust them to stay within the 50MB memory target for 100 concurrent workflows?
**Options**:
- A) Use spec sizes, adjust SC-007 target: Keep 200 events / 5min and 500KB logs / 10min as specified. Update the success criterion to ~75MB for 100 concurrent workflows.
- B) Reduce to fit 50MB target: Use 100 events / 3min retention and 256KB log buffer / 5min retention. Tighter memory but shorter reconnection window.
- C) Tiered buffering: Full buffers for workflows with active SSE subscribers (max ~10), minimal buffers (50 events, 128KB logs) for unmonitored workflows. Optimizes memory for actual usage patterns.
**Answer**:

---

### Q7: Dashboard Scope — New Webview vs. Extending Existing
**Context**: The existing orchestrator dashboard panel (`packages/generacy-extension/src/views/cloud/orchestrator/panel.ts`) already shows queue stats, agent cards, and an activity feed with real-time SSE updates. US3 describes a "job dashboard" with filtering by status and repository. These could be the same panel (extended) or a separate view. The spec references "extending existing orchestrator dashboard webview pattern" (FR-014) but doesn't specify whether this means extending the existing panel or creating a new panel following the same pattern.
**Question**: Should the job dashboard be integrated into the existing orchestrator dashboard panel or built as a separate dedicated panel?
**Options**:
- A) Extend existing panel: Add a "Jobs" tab or section to the current orchestrator dashboard. Reuses the existing SSE subscription and data loading. Single panel for all orchestrator concerns.
- B) Separate panel: Create a new `JobDashboardPanel` following the same singleton webview pattern. Keeps job monitoring concerns isolated. Users can have both panels open simultaneously.
- C) Tree view + panel: Use a VS Code tree view in the sidebar for the job list (with status icons and filters) and open a detail webview panel when clicking a job. More native VS Code UX pattern.
**Answer**:

---

### Q8: Conversation Viewer Implementation
**Context**: FR-016 says the conversation viewer should be a "new output channel or webview panel per job." These are very different UX choices: an output channel is a simple text log (like the existing `WorkflowOutputChannel`), while a webview panel supports rich HTML rendering with tool call/response styling. US2 requires tool calls and responses to be "visually distinguishable," which is easier with a webview but possible with ANSI-colored output channels.
**Question**: What UI component should the conversation viewer use?
**Options**:
- A) VS Code Output Channel: Reuse the same `WorkflowOutputChannel` pattern with ANSI color codes for tool call/response differentiation. Simple, familiar, and consistent with local execution. Limited formatting.
- B) Webview panel: Rich HTML panel with syntax highlighting, collapsible tool calls, and formatted JSON responses. Better visual experience but more implementation effort and doesn't match local execution UX.
- C) Output channel with webview option: Default to output channel for consistency with local execution, but offer a "Rich View" command that opens a webview for users who want formatted output. Supports both use cases.
**Answer**:

---

### Q9: Event Forwarding Failure Handling
**Context**: FR-009 says event forwarding should be "fire-and-forget with retry queue (max 50 events); drop oldest on overflow." The technical design notes say exponential backoff with max 3 retries per batch. But what happens when the orchestrator is down for an extended period? After 50 events overflow and retries are exhausted, the extension receives nothing. The spec doesn't address whether the extension should be informed that events were dropped or if there's a recovery mechanism beyond SSE reconnection.
**Question**: When events are dropped due to worker-to-orchestrator communication failure, how should the system handle the gap?
**Options**:
- A) Silent drop with gap indicator: Worker tracks the count of dropped events. When forwarding resumes, include a `events_dropped: N` metadata field in the next batch. Extension shows "N events were missed" in the output.
- B) Silent drop, no notification: Accept event loss silently. The extension's SSE reconnection + buffer replay handles what it can; anything else is lost. Simplest implementation.
- C) Worker persists to disk: Write overflow events to a temporary file on the worker. When the orchestrator becomes available, replay from disk before resuming live forwarding. More reliable but adds I/O complexity.
**Answer**:

---

### Q10: Notification Configuration Defaults
**Context**: US4 says users can "configure which notification types they receive (completion, failure, retries)" but doesn't specify the defaults. For a monitoring feature, overly aggressive defaults (notifying on every retry) could annoy users, while overly quiet defaults (only failures) might defeat the purpose.
**Question**: What should the default notification settings be when the feature is first enabled?
**Options**:
- A) Failures only by default: Only notify on job failure. Users opt-in to completion and retry notifications. Least disruptive for users who don't customize settings.
- B) Completion + failure by default: Notify on both completion and failure. Retry notifications are opt-in. Balances information with noise.
- C) All notifications by default: Enable completion, failure, and retry notifications. Users opt-out of what they don't want. Maximum visibility out of the box.
**Answer**:

---

### Q11: Scope of "Monitored" Jobs for Notifications
**Context**: US4 says the user gets notified "when a monitored job completes." The spec doesn't define what makes a job "monitored." Options range from all jobs the user has submitted, to only jobs the user has explicitly opened in the dashboard, to only jobs with an active SSE connection. This significantly affects the notification volume and whether the extension needs to maintain a background subscription.
**Question**: What determines whether a job is "monitored" for notification purposes?
**Options**:
- A) All user-submitted jobs: Any job submitted by the authenticated user triggers notifications. Extension maintains a lightweight background poll or single SSE subscription for all user jobs.
- B) Explicitly opened jobs: Only jobs the user has clicked on in the dashboard or explicitly subscribed to. Requires user action but avoids unwanted notifications.
- C) Currently running + recently submitted: Jobs the user submitted in the current VS Code session, plus any still running when the session starts. Automatic but session-scoped.
**Answer**:

---

### Q12: Graceful Degradation Behavior
**Context**: FR-019 says the extension should "fall back to existing polling behavior when SSE connection cannot be established." The current extension SSE client already has reconnection with exponential backoff (up to 30s). The spec doesn't define when to give up on SSE and switch to polling — after N failed reconnection attempts? After a timeout? And should the extension attempt to re-establish SSE periodically after falling back?
**Question**: What should trigger the fallback from SSE to polling, and should the extension periodically retry SSE after falling back?
**Options**:
- A) Fallback after 5 failed reconnections, retry SSE every 5 minutes: After 5 consecutive reconnection failures (~2 minutes with backoff), switch to 30s polling. Attempt SSE reconnection every 5 minutes in the background.
- B) Fallback after 30 seconds of disconnection, retry SSE every 10 minutes: Quicker fallback to keep users informed. Less frequent SSE retry to reduce failed connection noise.
- C) Never fully fall back: Keep attempting SSE reconnection indefinitely (with backoff capped at 30s). Supplement with polling at reduced frequency (60s) whenever SSE is disconnected. Both mechanisms coexist.
**Answer**:

---

### Q13: Log Stream Reconnection — `?since={timestamp}` Precision
**Context**: The spec says the conversation log SSE stream supports reconnection via `?since={timestamp}`. However, if multiple log chunks arrive within the same millisecond timestamp, using timestamp-based replay could miss or duplicate chunks. Additionally, the ring buffer (500KB) may have evicted content between the `since` timestamp and the current buffer start, creating gaps the client can't detect.
**Question**: Should log stream reconnection use timestamps, sequence numbers, or byte offsets, and how should the client handle gaps from buffer eviction?
**Options**:
- A) Sequence numbers with gap detection: Assign monotonic sequence numbers to each log chunk. Client sends `?since_seq=N` on reconnection. If the buffer's oldest chunk is > N+1, include a `[gap: N chunks missed]` marker in the replayed stream.
- B) Timestamps with best-effort replay: Keep the timestamp approach. Accept that sub-millisecond duplicates are unlikely in practice. If the buffer doesn't reach back to the requested timestamp, replay from the oldest available and include a warning header.
- C) Byte offsets: Track total bytes written per workflow. Client sends `?since_byte=N`. Replay from byte offset if still in buffer, otherwise from buffer start. Precise but adds tracking overhead.
**Answer**:

---

### Q14: Multi-Instance Orchestrator Support
**Context**: The spec's assumptions mention "Redis pub/sub can be used for internal orchestrator event distribution if the orchestrator scales to multiple instances." However, the current implementation uses in-memory buffers for event storage and SSE broadcasting. If the orchestrator runs multiple instances behind a load balancer, a worker's POST might hit instance A while the extension's SSE connection is on instance B. The spec doesn't clarify whether single-instance is the v1 assumption or if multi-instance must work from day one.
**Question**: Should the v1 implementation support multi-instance orchestrator deployment, or is single-instance sufficient?
**Options**:
- A) Single-instance only for v1: Keep in-memory buffers. Document that the orchestrator must run as a single instance for real-time features. Simplest and fastest to implement.
- B) Redis-backed from day one: Use Redis pub/sub to distribute events between orchestrator instances. In-memory buffers per instance are populated from Redis. Adds complexity but avoids a future migration.
- C) Sticky sessions as intermediate: Use session affinity (sticky sessions) on the load balancer to route worker POSTs and extension SSE connections to the same orchestrator instance. In-memory buffers work but require LB configuration.
**Answer**:

---

### Q15: Event Payload Size and Sensitive Data
**Context**: The `ExecutionEvent` type includes a `data?: unknown` field that can contain arbitrary data from step execution — potentially including environment variables, API responses, or user content. The spec doesn't address whether event payloads should be sanitized before forwarding, or what the maximum payload size should be. Large `step:output` events with full Claude responses could be several KB each.
**Question**: Should event payloads be size-limited and/or sanitized before forwarding from worker to orchestrator?
**Options**:
- A) Size limit only: Cap individual event payloads at 16KB. Truncate `data` field if exceeded with a `[truncated]` marker. No content sanitization — trust that workflows don't emit secrets in event data.
- B) Size limit + environment variable masking: Cap at 16KB and apply the same sensitive key detection already used in `WorkflowOutputChannel` (mask values for keys containing password, secret, token, api_key). Defence in depth.
- C) No limits for v1: Forward payloads as-is. The existing 4KB log chunk limit and 200-event buffer provide implicit bounds. Revisit if actual usage reveals problems.
**Answer**:
