# Implementation Plan: Live Log/Conversation Viewer

**Feature**: #180 — Real-time workflow monitoring (Part of #175)
**Branch**: `180-parent-epic-part-175`
**Date**: 2026-02-23

## Summary

Add a `JobLogChannel` class that streams live claude CLI output for remote jobs via a VS Code OutputChannel. The implementation follows the proven `AgentLogChannel` pattern — historical REST fetch + SSE live streaming on the shared `SSESubscriptionManager` connection, filtered by `jobId`. A new `'jobs'` SSE channel carries log, step-boundary, and terminal events. A "View Logs" button is added to the job detail webview and queue tree context menu.

## Technical Context

| Aspect | Value |
|--------|-------|
| Language | TypeScript |
| Framework | VS Code Extension API |
| Runtime | Node.js (extension host) |
| Patterns | Singleton SSE, static channel registry, OutputChannel per resource |
| Key Dependencies | `SSESubscriptionManager` (shared SSE), `queueApi` (REST), VS Code `OutputChannel` |
| Dependencies on other features | #178 (Worker conversation streaming), #176 (Orchestrator SSE endpoint) |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  VS Code Extension Host                                  │
│                                                          │
│  ┌──────────────────┐     ┌──────────────────────────┐  │
│  │  JobDetailPanel   │     │  Queue Tree Context Menu  │  │
│  │  (webview)        │     │  (tree-item action)       │  │
│  └────────┬─────────┘     └──────────┬───────────────┘  │
│           │ "View Logs"              │ "View Logs"       │
│           └──────────┬───────────────┘                   │
│                      ▼                                   │
│           ┌──────────────────┐                           │
│           │  JobLogChannel   │ ◄── Static registry       │
│           │  (per jobId)     │     Map<string, channel>  │
│           └──────┬───────────┘                           │
│             ┌────┴────┐                                  │
│             ▼         ▼                                  │
│     ┌──────────┐  ┌──────────────────┐                  │
│     │ REST API │  │ SSESubscription  │                  │
│     │ GET logs │  │ Manager          │                  │
│     │ (hist.)  │  │ channel: 'jobs'  │                  │
│     └──────────┘  └──────────────────┘                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
         │                      │
         ▼                      ▼
┌──────────────────────────────────────┐
│  Orchestrator API                     │
│  GET /api/jobs/:id/logs              │
│  SSE /events (channel: 'jobs')       │
└──────────────────────────────────────┘
```

## Key Technical Decisions

### D1: Shared SSE via SSESubscriptionManager (Q1 → Option A)
Add a `'jobs'` channel to `SSEChannel` type. Filter events client-side by `jobId`. Reuses existing reconnection, `Last-Event-ID`, and connection state infrastructure. Avoids per-job HTTP connections.

### D2: Pre-cleaned plain text content (Q2 → Option B)
Server strips ANSI codes before sending. Extension displays `content` as-is in OutputChannel. No ANSI parsing dependency needed.

### D3: Fetch last 10,000 lines, no pagination (Q3 → Option C)
Single REST fetch of most recent 10K lines. Show truncation header if more exist. No load-more in v1.

### D4: Dispose on session end (Q4 → Option C)
Static `activeChannels` map with `disposeAll()` called on extension deactivation. No mid-session auto-disposal.

### D5: Server-side cursor for historical-to-live handoff (Q5 → Option B)
Historical REST response includes `cursor` field. Pass to SSE as `Last-Event-ID` equivalent for zero-gap, zero-duplication transition.

### D6: Always visible "View Logs" button (Q6 → Option A)
Show for all job states. Pending/queued jobs show `"Waiting for job to start..."` and auto-populate when logs arrive.

### D7: Explicit step boundary events (Q7 → Option B)
Server emits `job:step-start` / `job:step-end` events alongside `job:log`. Clean separation of content from structure.

### D8: OutputChannel name = first 8 chars of UUID (Q8 → Option A)
Format: `"Job: my-workflow (a1b2c3d4)"`. Concise, reliably unique, familiar to developers.

### D9: Graceful degradation with retry (Q9 → Option C)
Open channel, display error inline, retry up to 3 times with backoff. Consistent with SSE reconnection behavior.

### D10: No memory limit in v1 (Q10 → Option A)
Trust OutputChannel's built-in efficiency. Document limitation for future review.

### D11: Job terminal state from log stream end (Q11 → Option C)
SSE sends `job:log:end` event with terminal status. Self-contained lifecycle, no coupling to `JobDetailPanel`.

---

## Implementation Phases

### Phase 1: Type Definitions and API Layer

**Files modified:**
- `packages/generacy-extension/src/api/types.ts`
- `packages/generacy-extension/src/api/endpoints/queue.ts`

**Changes:**

1. **Add `'jobs'` to `SSEChannel` type** (`types.ts:920`)
   ```typescript
   export type SSEChannel = 'workflows' | 'queue' | 'agents' | 'jobs';
   ```

2. **Add `SSEChannel` Zod schema update** (`types.ts:944`)
   ```typescript
   channel: z.enum(['workflows', 'queue', 'agents', 'jobs']),
   ```

3. **Add job log types** (new section in `types.ts` after Agent Log Types):
   - `JobLogLine` interface — `{ content: string; stream: 'stdout' | 'stderr'; timestamp: string; stepName?: string }`
   - `JobLogsResponse` interface — `{ lines: JobLogLine[]; total: number; cursor?: string; truncated: boolean }`
   - Zod schemas for both

4. **Add `JobDetailWebviewMessage` variant** (`types.ts:540-546`)
   - Add `| { type: 'viewLogs' }` to the union

5. **Add `getJobLogs` endpoint** (`queue.ts`):
   ```typescript
   async getJobLogs(id: string, options?: { limit?: number }): Promise<JobLogsResponse>
   ```
   - `GET /queue/${id}/logs?limit=${options?.limit ?? 10000}`

6. **Add `ALL_CHANNELS` update** (`sse.ts:30`):
   ```typescript
   const ALL_CHANNELS: SSEChannel[] = ['workflows', 'queue', 'agents', 'jobs'];
   ```

### Phase 2: JobLogChannel Implementation

**New file:** `packages/generacy-extension/src/views/cloud/log-viewer/log-channel.ts`

**Structure** (mirrors `AgentLogChannel`):

```typescript
export class JobLogChannel implements vscode.Disposable {
  private static activeChannels: Map<string, JobLogChannel> = new Map();

  private readonly outputChannel: vscode.OutputChannel;
  private readonly jobId: string;
  private readonly workflowName: string;
  private sseDisposable: vscode.Disposable | undefined;
  private disposed = false;
  private lastStepName: string | undefined;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(jobId: string, workflowName: string) { ... }

  async open(): Promise<void> { ... }
  private async fetchHistoricalLogs(): Promise<string | undefined> { ... }
  private subscribeToSSE(cursor?: string): void { ... }
  private handleLogEvent(event: SSEEvent): void { ... }
  private handleStepBoundary(event: SSEEvent): void { ... }
  private handleJobEnd(event: SSEEvent): void { ... }
  private formatLogLine(line: JobLogLine): string { ... }
  private appendStepSeparator(stepName: string): void { ... }
  private handleFetchError(error: unknown): void { ... }

  dispose(): void { ... }
  static async openJobLogs(jobId: string, workflowName: string): Promise<void> { ... }
  static disposeAll(): void { ... }
}
```

**Key behaviors:**

- **`open()`**: Clear channel → show header → fetch historical logs → subscribe SSE → show channel
- **`fetchHistoricalLogs()`**: Call `queueApi.getJobLogs(jobId, { limit: 10000 })`. Display lines with timestamp prefix. Show truncation header if `response.truncated`. Return `response.cursor` for SSE handoff.
- **`subscribeToSSE(cursor?)`**: Subscribe to `'jobs'` channel. Filter by `jobId`. Handle three event types:
  - `job:log` → append formatted line
  - `job:step-start` → insert step separator `────── Step: {name} ──────`
  - `job:log:end` → append terminal status message, stop streaming
- **`formatLogLine()`**: Prefix with `[HH:mm:ss]`. For stderr, prefix with `[ERR]`.
- **Error handling with retry**: On REST fetch failure, show error inline, retry up to 3 times with 5s/10s/20s backoff.
- **Pending job handling**: If historical fetch returns 0 lines and job is pending/queued, show `"Waiting for job to start..."`. SSE will deliver lines when they arrive.

**OutputChannel naming**: `"Job: ${workflowName} (${jobId.slice(0, 8)})"`

### Phase 3: Module Wiring and Index

**New file:** `packages/generacy-extension/src/views/cloud/log-viewer/index.ts`

```typescript
export { JobLogChannel } from './log-channel';
```

**Files modified:**
- `packages/generacy-extension/src/constants.ts` — Add `viewJobLogs: 'generacy.queue.viewLogs'` to `CLOUD_COMMANDS`
- `packages/generacy-extension/src/views/cloud/queue/actions.ts` — Add `viewJobLogs` command handler and register it
- `packages/generacy-extension/src/views/cloud/queue/index.ts` — Re-export `viewJobLogs` from actions

**Command registration** (in `actions.ts` → `registerQueueActions()`):
```typescript
context.subscriptions.push(
  vscode.commands.registerCommand(
    CLOUD_COMMANDS.viewJobLogs,
    async (item?: QueueTreeItem) => {
      if (!item || !isQueueTreeItem(item)) {
        vscode.window.showWarningMessage('Please select a queue item');
        return;
      }
      await JobLogChannel.openJobLogs(item.queueItem.id, item.queueItem.workflowName);
    }
  )
);
```

### Phase 4: Job Detail Panel Integration

**Files modified:**
- `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts` — Handle `viewLogs` message
- `packages/generacy-extension/src/views/cloud/queue/detail-html.ts` — Add "View Logs" button
- `packages/generacy-extension/src/api/types.ts` — Already done in Phase 1

**detail-panel.ts** — Add case in `handleMessage()`:
```typescript
case 'viewLogs':
  void JobLogChannel.openJobLogs(this.queueItem.id, this.queueItem.workflowName);
  break;
```

**detail-html.ts** — Add "View Logs" button in the header/actions section:
- Button with `$(terminal)` codicon icon
- Sends `{ type: 'viewLogs' }` postMessage on click
- Visible for all job states (per Q6 decision)

### Phase 5: Package.json and Context Menu

**File modified:** `packages/generacy-extension/package.json`

1. **Register command**:
   ```json
   {
     "command": "generacy.queue.viewLogs",
     "title": "View Logs",
     "category": "Generacy",
     "icon": "$(terminal)"
   }
   ```

2. **Add to queue tree context menu**:
   ```json
   {
     "command": "generacy.queue.viewLogs",
     "when": "view == generacy.queue && viewItem =~ /^queueItem/",
     "group": "inline@4"
   }
   ```
   - Uses `/^queueItem/` regex to match all job states (pending, running, completed, failed, cancelled)

3. **Add to queue tree item context menu** (right-click):
   ```json
   {
     "command": "generacy.queue.viewLogs",
     "when": "view == generacy.queue && viewItem =~ /^queueItem/",
     "group": "navigation@2"
   }
   ```

### Phase 6: Extension Lifecycle Integration

**File modified:** `packages/generacy-extension/src/extension.ts`

Add `JobLogChannel.disposeAll()` to the `deactivate()` function alongside other cleanup:
```typescript
export function deactivate(): void {
  JobLogChannel.disposeAll();
  // ... existing cleanup
}
```

### Phase 7: Tests

**New file:** `packages/generacy-extension/src/views/cloud/log-viewer/__tests__/log-channel.test.ts`

Test cases:
1. **Channel creation**: Creates OutputChannel with correct name format
2. **Channel reuse**: Same jobId returns existing channel
3. **Historical log fetch**: Calls `queueApi.getJobLogs` with correct params, displays lines
4. **Truncation header**: Shows truncation message when `response.truncated === true`
5. **SSE subscription**: Subscribes to `'jobs'` channel
6. **Event filtering**: Only processes events matching jobId
7. **Log line formatting**: Timestamps, stderr prefix
8. **Step boundary**: Inserts separator on `job:step-start`
9. **Job end**: Shows terminal message on `job:log:end`, stops streaming
10. **Retry on error**: Retries historical fetch up to 3 times
11. **Pending job**: Shows waiting message for pending/queued jobs
12. **Dispose**: Cleans up SSE subscription, removes from map
13. **disposeAll**: Disposes all active channels

**Test file:** `packages/generacy-extension/src/views/cloud/queue/__tests__/actions.test.ts` (extend)
- Add test for `viewJobLogs` command registration

---

## Data Flow: Historical + Live Handoff

```
1. User clicks "View Logs" on job abc12345
2. JobLogChannel.openJobLogs("abc12345", "my-workflow")
3. Create/reuse channel → outputChannel.clear()
4. Show header: "--- Logs for my-workflow (abc12345) ---"
5. REST: GET /queue/abc12345/logs?limit=10000
   ← Response: { lines: [...], total: 12500, cursor: "evt_789", truncated: true }
6. Show: "--- Showing last 10,000 of 12,500 lines ---"
7. Append all 10,000 lines with timestamps
8. Show: "--- Live log stream active ---"
9. SSE subscribe('jobs', handler) — events with jobId=abc12345
   Server uses cursor "evt_789" context to avoid re-sending
10. Live events arrive:
    job:log → append line
    job:step-start → append separator
    job:log:end → append "--- Job completed ---", stop streaming
```

## SSE Event Contracts

### `job:log` event
```json
{
  "id": "evt_001",
  "event": "job:log",
  "channel": "jobs",
  "data": {
    "jobId": "abc12345-...",
    "content": "Reading file: src/main.ts",
    "stream": "stdout",
    "stepName": "implement",
    "timestamp": "2026-02-23T15:30:00.000Z"
  },
  "timestamp": "2026-02-23T15:30:00.000Z"
}
```

### `job:step-start` event
```json
{
  "id": "evt_002",
  "event": "job:step-start",
  "channel": "jobs",
  "data": {
    "jobId": "abc12345-...",
    "stepName": "validate",
    "stepIndex": 5,
    "totalSteps": 6
  },
  "timestamp": "2026-02-23T15:31:00.000Z"
}
```

### `job:log:end` event
```json
{
  "id": "evt_003",
  "event": "job:log:end",
  "channel": "jobs",
  "data": {
    "jobId": "abc12345-...",
    "status": "completed",
    "completedAt": "2026-02-23T15:35:00.000Z"
  },
  "timestamp": "2026-02-23T15:35:00.000Z"
}
```

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/api/types.ts` | Modify | Add `'jobs'` to SSEChannel, add JobLogLine/JobLogsResponse types, add `viewLogs` message type |
| `src/api/endpoints/queue.ts` | Modify | Add `getJobLogs()` endpoint method |
| `src/api/sse.ts` | Modify | Add `'jobs'` to `ALL_CHANNELS` array |
| `src/views/cloud/log-viewer/log-channel.ts` | **New** | Core `JobLogChannel` class |
| `src/views/cloud/log-viewer/index.ts` | **New** | Module exports |
| `src/views/cloud/log-viewer/__tests__/log-channel.test.ts` | **New** | Unit tests |
| `src/views/cloud/queue/actions.ts` | Modify | Add `viewJobLogs` command handler + registration |
| `src/views/cloud/queue/index.ts` | Modify | Re-export `viewJobLogs` |
| `src/views/cloud/queue/detail-panel.ts` | Modify | Handle `viewLogs` webview message |
| `src/views/cloud/queue/detail-html.ts` | Modify | Add "View Logs" button |
| `src/constants.ts` | Modify | Add `viewJobLogs` command constant |
| `src/extension.ts` | Modify | Add `JobLogChannel.disposeAll()` to deactivation |
| `package.json` | Modify | Register command and context menu entries |

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| #178 not ready (no server endpoints) | High | Log channel shows error with retry. Extension code is self-contained and testable with mocks. |
| High log volume causes OutputChannel lag | Medium | v1 accepts this (Q10). Monitor real usage. OutputChannel is optimized for large text. |
| SSE reconnection drops log lines | Medium | Server-side cursor (Q5) ensures zero-gap handoff. `Last-Event-ID` replay on reconnection. |
| Multiple open channels consume memory | Low | Each OutputChannel is lightweight when idle. `disposeAll()` on deactivation ensures cleanup. |
| Race between historical fetch and SSE start | Medium | Cursor-based handoff (Q5) eliminates the race entirely. |

## Out of Scope (v1)

- Structured conversation view (stretch goal — render tool calls, file reads, diffs)
- Search within logs
- Pause/resume auto-scroll (OutputChannel auto-scrolls by default)
- Toggle word wrap (OutputChannel setting)
- Copy selection to clipboard (OutputChannel supports this natively)
- Webview-based viewer with Monaco editor
- Log pagination / load-more
- Memory limit / log rotation
