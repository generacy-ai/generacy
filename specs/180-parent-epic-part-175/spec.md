# Feature Specification: Live Conversation/Log Viewer for Remote Jobs

**Epic**: #175 — Real-time workflow monitoring
**Branch**: `180-parent-epic-part-175` | **Date**: 2026-02-23 | **Status**: Draft

## Summary

Add a live log/conversation viewer panel in the VS Code extension that streams claude CLI output in real-time for remote jobs. Users should be able to see what the agent is reading, writing, and thinking as it works — similar to watching a terminal. The viewer connects to the SSE log stream provided by #178, displays historical logs on open, and auto-scrolls as new output arrives. It integrates with the job detail view (#179) via a "View Logs" button.

## Current State

The extension has a local `OutputChannel` that displays execution events for locally-run workflows. For remote jobs executed by agent containers, there is no way to see the claude conversation output. The worker captures stdout/stderr but doesn't stream it to the extension. The existing `AgentLogChannel` in `views/cloud/agents/log-channel.ts` demonstrates the pattern — singleton output channels per agent with hybrid REST + SSE fetching — but is scoped to agent-level logs, not per-job claude conversation output.

## User Stories

### US1: Watch a Running Job's Output

**As a** developer monitoring a remote workflow,
**I want** to see the live claude CLI output for a running job,
**So that** I can understand what the agent is doing and catch issues early without waiting for completion.

**Acceptance Criteria**:
- [ ] A "View Logs" action is available from the job detail panel and queue tree context menu
- [ ] Clicking it opens an OutputChannel showing the job's claude output
- [ ] New log lines appear within 1–2 seconds of being generated on the worker
- [ ] stdout and stderr are visually differentiated (stderr prefixed/colored)
- [ ] Step boundaries are shown as visual separators with step name and timestamp

### US2: View Logs for a Job Already in Progress

**As a** developer who opens the log viewer after a job has already started,
**I want** to see the historical output followed by the live stream,
**So that** I have full context without missing earlier output.

**Acceptance Criteria**:
- [ ] Opening the viewer mid-job fetches the historical log buffer via `GET /api/jobs/:jobId/logs`
- [ ] After the buffer loads, the SSE stream is subscribed for live updates
- [ ] There is no gap or duplication between historical and live data
- [ ] A visual indicator marks where the live stream begins

### US3: Control Log Scrolling and Search

**As a** developer reviewing verbose job output,
**I want** to pause auto-scroll, search within the logs, and toggle word wrap,
**So that** I can inspect specific sections without losing my place.

**Acceptance Criteria**:
- [ ] Auto-scroll to bottom is enabled by default and resumes when the user scrolls to the end
- [ ] Word wrap can be toggled via OutputChannel settings
- [ ] Text can be selected and copied to clipboard
- [ ] VS Code's built-in OutputChannel search (Ctrl+F) works

### US4: View Logs for Multiple Jobs

**As a** developer running several workflows concurrently,
**I want** to have separate log viewers for different jobs,
**So that** I can monitor multiple jobs at once without output mixing.

**Acceptance Criteria**:
- [ ] Each job gets its own named OutputChannel (e.g., "Job: workflow-name (job-id-short)")
- [ ] Re-opening logs for the same job reuses the existing channel
- [ ] Channels are automatically cleaned up when the job reaches a terminal state and the user closes the channel
- [ ] Opening a second job's logs does not close the first

### US5: View Logs for Completed/Failed Jobs

**As a** developer investigating a failed job,
**I want** to view the full log output after a job has completed or failed,
**So that** I can diagnose what went wrong.

**Acceptance Criteria**:
- [ ] Logs can be opened for jobs in any terminal state (completed, failed, cancelled)
- [ ] The full buffered output is fetched and displayed
- [ ] No SSE subscription is attempted for terminal-state jobs
- [ ] The channel clearly indicates the job's final status

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `JobLogChannel` class managing OutputChannel instances per job | P1 | Follow `AgentLogChannel` singleton-per-ID pattern |
| FR-002 | Fetch historical logs via `GET /api/jobs/:jobId/logs` on channel open | P1 | Display with timestamps; show count summary if truncated |
| FR-003 | Subscribe to `GET /api/jobs/:jobId/logs?stream=true` SSE for live updates | P1 | Use existing `SSESubscriptionManager` or direct SSE connection |
| FR-004 | Display log lines with `[HH:MM:SS]` timestamp prefix | P1 | Group timestamps per-second or per-line based on volume |
| FR-005 | Differentiate stdout vs stderr output | P1 | Prefix stderr lines with `[stderr]` marker |
| FR-006 | Show step boundaries as separator lines | P1 | Format: `────── Step: step-name ──────` with timestamp |
| FR-007 | Add "View Logs" button to job detail webview | P1 | Sends `openLogs` message to extension host |
| FR-008 | Add "View Logs" context menu item to queue tree items | P2 | Only for running/completed/failed jobs |
| FR-009 | Register `generacy.job.viewLogs` command | P1 | Accepts job ID, opens or reveals the log channel |
| FR-010 | Reuse existing channel when re-opening logs for same job | P1 | Clear and refresh if job has restarted |
| FR-011 | Skip SSE subscription for terminal-state jobs | P1 | Only fetch historical buffer |
| FR-012 | Add `getJobLogs` method to API endpoints module | P1 | `GET /api/jobs/:jobId/logs` returning log entries |
| FR-013 | Handle SSE reconnection gracefully with `Last-Event-ID` | P2 | Avoid duplicate lines on reconnect |
| FR-014 | Show connection status indicators in output | P2 | `--- Live stream active ---` / `--- Reconnecting... ---` |
| FR-015 | Dispose SSE subscription when OutputChannel is closed | P1 | Prevent resource leaks |
| FR-016 | Dispose all channels on extension deactivation | P1 | Static `disposeAll()` method |
| FR-017 | Filter log stream by step name (stretch) | P3 | Optional query param or client-side filter |
| FR-018 | Structured conversation rendering in webview (stretch) | P3 | Future: rich rendering of tool calls, file edits, diffs |

## Technical Design

### Architecture

```
┌─────────────────────┐     ┌──────────────────────┐
│  Job Detail Panel   │────▶│   JobLogChannel      │
│  (View Logs btn)    │     │   (per job instance)  │
└─────────────────────┘     └──────────┬───────────┘
                                       │
┌─────────────────────┐     ┌──────────▼───────────┐
│  Queue Tree Item    │────▶│   VS Code            │
│  (context menu)     │     │   OutputChannel      │
└─────────────────────┘     └──────────────────────┘
                                       ▲
                            ┌──────────┴───────────┐
                            │  Data Sources         │
                            │                       │
                            │  1. REST: Historical  │
                            │     GET /jobs/:id/logs│
                            │                       │
                            │  2. SSE: Live stream   │
                            │     GET /jobs/:id/     │
                            │     logs?stream=true   │
                            └───────────────────────┘
```

### Key Classes

**`JobLogChannel`** (`views/cloud/log-viewer/channel.ts`)
- Follows the established `AgentLogChannel` singleton-per-ID pattern
- Manages one `vscode.OutputChannel` per job ID
- Static `Map<string, JobLogChannel>` for instance tracking
- `open()`: fetch historical → display → subscribe SSE
- `dispose()`: unsubscribe SSE → dispose channel → remove from map
- Static `openJobLogs(job)`: create-or-reuse entry point
- Static `disposeAll()`: cleanup on deactivation

**Log Entry Format** (from #178):
```typescript
interface LogEntry {
  timestamp: string;
  stream: 'stdout' | 'stderr';
  stepName?: string;
  content: string;
}
```

### Data Flow

1. User clicks "View Logs" → `generacy.job.viewLogs` command fires
2. `JobLogChannel.openJobLogs(jobId, jobName)` called
3. If channel exists for this job, reveal it; otherwise create new
4. Fetch `GET /api/jobs/:jobId/logs` → display historical lines with timestamps
5. If job is not in terminal state:
   a. Subscribe to SSE stream `GET /api/jobs/:jobId/logs?stream=true`
   b. Append each incoming log entry to OutputChannel
   c. Insert step boundary separators when `stepName` changes
6. On SSE disconnect → show reconnecting indicator, rely on auto-reconnect
7. On job terminal state event → show final status, unsubscribe SSE

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/generacy-extension/src/views/cloud/log-viewer/channel.ts` | Create | `JobLogChannel` class |
| `packages/generacy-extension/src/views/cloud/log-viewer/index.ts` | Create | Module exports |
| `packages/generacy-extension/src/api/endpoints/jobs.ts` | Modify | Add `getJobLogs()` method |
| `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts` | Modify | Add "View Logs" message handler |
| `packages/generacy-extension/src/views/cloud/queue/detail-html.ts` | Modify | Add "View Logs" button to HTML |
| `packages/generacy-extension/src/views/cloud/queue/actions.ts` | Modify | Register `generacy.job.viewLogs` command |
| `packages/generacy-extension/src/constants.ts` | Modify | Add command constant |
| `packages/generacy-extension/src/api/types.ts` | Modify | Add `LogEntry` schema if not present |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Log delivery latency | < 2 seconds end-to-end | Timestamp comparison: worker generation → extension display |
| SC-002 | Historical log load time | < 3 seconds for 10K lines | Time from channel open to content visible |
| SC-003 | No log duplication | 0 duplicate lines on reconnect | Manual test: disconnect/reconnect SSE mid-stream |
| SC-004 | Resource cleanup | 0 leaked subscriptions | Verify SSE unsubscribed after channel close via debug logs |
| SC-005 | Multi-job support | 5+ concurrent channels | Open logs for 5 jobs simultaneously without performance degradation |
| SC-006 | Mid-job open completeness | 100% of buffered lines shown | Open viewer mid-job, compare output against full buffer |

## Assumptions

- #178 (Worker conversation streaming) is implemented: `GET /api/jobs/:jobId/logs` and `GET /api/jobs/:jobId/logs?stream=true` endpoints exist and return `LogEntry` objects
- #176 (Orchestrator SSE endpoint) is implemented: SSE infrastructure with reconnection and `Last-Event-ID` support is available
- #179 (Job detail webview) is implemented: the `JobDetailPanel` exists with webview message handling
- The log buffer on the server retains at least the last 10,000 lines per job
- The SSE log stream endpoint supports `Last-Event-ID` for seamless reconnection
- VS Code's built-in `OutputChannel` provides sufficient functionality for v1 (search, copy, scroll)
- Log volume per job is manageable in an OutputChannel (typically < 100K lines)

## Out of Scope

- **Structured conversation rendering**: Rich rendering of tool calls, file diffs, and thinking blocks in a webview is a stretch goal for a future iteration
- **Log persistence**: Logs are not saved to disk by the extension; they are fetched from the server each time
- **Log export**: No "Save Logs to File" functionality in this iteration
- **Terminal emulation**: No ANSI color code rendering or full terminal emulation — OutputChannel displays plain text with prefixes
- **Real-time filtering**: Client-side step name filtering is deferred to P3; users can use VS Code's built-in search
- **Monaco editor webview**: A richer webview-based viewer with syntax highlighting is a future enhancement
- **Log aggregation across jobs**: No combined/merged view of multiple job logs in a single panel
- **Notification on job events**: No toast notifications when errors appear in logs (covered separately)

---

*Generated by speckit*
