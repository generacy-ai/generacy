# Research: Job Completion Notifications

## Existing Notification Infrastructure Analysis

### Current NotificationManager (`src/utils/notifications.ts`)

The existing `NotificationManager` is a **generic SSE event broadcaster**. It subscribes to all three SSE channels (`workflows`, `queue`, `agents`) and shows notifications based on a single `generacy.dashboard.notifications` setting with three levels:

- `all` — immediate toast per event
- `summary` — batches in 10-second windows, shows a count summary
- `none` — suppresses everything

**Limitation**: It treats all SSE events uniformly. A `queue:item:added` event gets the same treatment as a `queue:updated` with `status: 'failed'`. There's no semantic understanding of job lifecycle or terminal states.

**Decision**: Keep the existing `NotificationManager` for ambient dashboard awareness. The new `JobNotificationService` is a complementary service with job-terminal-specific logic. This follows the incremental migration strategy (Q2-C) — the old manager can be deprecated later once its responsibilities are fully absorbed.

### Current CloudJobStatusBarProvider (`src/providers/status-bar.ts`)

Simple counter display: `$(cloud) N job(s)`. Hides when count is 0. No visual feedback on state transitions — it simply reflects the current running count derived from `queueProvider.getItemsByStatus('running')`.

**Enhancement needed**: Add `flash()` method for transient visual feedback. The provider currently doesn't track its own count (it's computed externally in `cloud.ts` and passed via `updateCount()`), so we need to store `currentCount` to properly revert after a flash.

### SSE Event Flow for Queue Updates

```
Orchestrator → SSE /events → SSESubscriptionManager → subscribers
```

The `queue:updated` event carries a partial `QueueItem` payload. The `QueueTreeProvider` handles this at line 384 by merging the update into its local cache. The event `data` includes at minimum: `id`, and the changed fields (e.g., `status`).

**Key observation**: The `QueueItem` type does NOT include `pullRequestUrl` or `failedStep`. These are only available on `JobProgress` (returned by `GET /queue/:id/progress`). This confirms the need to fetch `JobProgress` on terminal events.

## VS Code API Constraints

### Notification API

- `vscode.window.showInformationMessage(message, ...actions)` — up to 3 action buttons
- `vscode.window.showWarningMessage(message, ...actions)` — yellow accent
- `vscode.window.showErrorMessage(message, ...actions)` — red accent
- Actions are strings; the selected action is returned via the thenable
- No way to customize notification appearance beyond severity level
- No way to add icons/emoji to the notification title (they render as plain text, but emoji unicode characters do render)

### StatusBarItem API

- `backgroundColor` supports `ThemeColor` values:
  - `statusBarItem.errorBackground` (red)
  - `statusBarItem.warningBackground` (yellow/orange)
  - `undefined` (default theme color)
- Icons via codicon syntax: `$(check)`, `$(error)`, `$(stop)`, `$(cloud)`
- `text` property is plain string with codicon support
- No animation API — must use timer-based state swapping

### Window Focus State

- `vscode.window.state.focused` — boolean
- `vscode.window.onDidChangeWindowState` — event for focus/blur transitions
- When unfocused, `showInformationMessage` still fires but may be queued by the OS notification system

## Notification Format Design

### Success notification:
```
$(check) workflow-name completed (31m 22s)
  → PR #62: fix: request_decision options not displaying
  [View PR] [View Details]
```

Since VS Code's notification API only supports a plain string message + action buttons, the actual format will be:

```typescript
vscode.window.showInformationMessage(
  `✅ ${workflowName} completed (${duration})` +
    (prUrl ? ` → PR: ${prTitle}` : ''),
  ...(prUrl ? ['View PR'] : []),
  'View Details'
);
```

### Failure notification:
```typescript
vscode.window.showWarningMessage(
  `❌ ${workflowName} failed at step "${failedStep}" (${duration})` +
    (error ? ` — ${error}` : ''),
  'View Logs',
  'View Details'
);
```

### Cancelled notification:
```typescript
vscode.window.showInformationMessage(
  `⏹ ${workflowName} was cancelled`,
  'View Details'
);
```

### Batch summary:
```typescript
vscode.window.showInformationMessage(
  `${completedCount} jobs completed, ${failedCount} failed`,
  'View Queue'
);
```

## Duration Formatting

The codebase has three existing `formatDuration` implementations (in `status-bar.ts`, `tree-item.ts`, and `detail-html.ts`). The notification service needs duration formatting for `startedAt` → `completedAt`. Rather than creating a fourth implementation, we'll use the same inline pattern since the service only needs it in one place:

```typescript
private formatDuration(startedAt: string, completedAt: string): string {
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
```

## Deduplication Strategy

SSE reconnection sends `Last-Event-ID` header, and the server replays events after that ID. This means a reconnection could replay terminal events that already triggered notifications.

**Approach**: Maintain a bounded `Set<string>` of seen event IDs. Use a parallel `string[]` as a FIFO queue. When the set exceeds 100 entries, remove the oldest.

```typescript
private trackEventId(id: string): boolean {
  if (this.seenEventIds.has(id)) return false; // already seen
  this.seenEventIds.add(id);
  this.seenEventIdOrder.push(id);
  while (this.seenEventIdOrder.length > 100) {
    this.seenEventIds.delete(this.seenEventIdOrder.shift()!);
  }
  return true; // new event
}
```

**Why 100?** SSE reconnection replays a bounded window. 100 is generous for the typical replay scenario. On VS Code restart, the SSE connection starts fresh without `Last-Event-ID`, so no replay occurs.

## Rate Limiting Algorithm

```
Event arrives → add to pendingNotifications[]
  If no batch timer running:
    Start 10-second timer
  When timer fires:
    If pendingNotifications.length >= 3:
      Show single summary notification
    Else:
      Show individual notifications for each
    Clear pendingNotifications[]
```

This matches the existing `NotificationManager`'s 10-second batch window pattern.

## Focus Batching Algorithm

```
Event arrives:
  If window.state.focused:
    Process normally (rate limiting applies)
  Else:
    Add to unfocusedQueue[]

On window focus:
  If unfocusedQueue.length >= 3:
    Show single summary
  Else:
    Show individual notifications
  Clear unfocusedQueue[]
```

## continueOnError Inference

The orchestrator emits `workflow:step:complete` events on the `workflows` channel. If a step has `status: 'failed'` but no corresponding `queue:updated` with a terminal status follows within a short window, the job is continuing despite the step failure.

**Simplified approach**: Subscribe to `workflows` channel. On `workflow:step:complete` with `status: 'failed'`, flash the status bar. The toast notification is only triggered by `queue:updated` with terminal status — so if the job continues, no toast fires. The flash is a lightweight "heads up" that something went wrong but the job is proceeding.

This naturally handles `continueOnError` without needing the flag — if the step failure is fatal, the job will transition to `failed` status via `queue:updated`, triggering the full failure notification. If it's non-fatal, only the status bar flash occurs.
