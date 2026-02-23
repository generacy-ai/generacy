# Implementation Plan: Job Completion Notifications

## Summary

Add a `JobNotificationService` that listens for terminal job status transitions (`completed`, `failed`, `cancelled`) via the existing SSE `queue:updated` events and surfaces them as VS Code notifications with actionable buttons (View PR, View Details). Enhance the existing `CloudJobStatusBarProvider` with flash-on-completion behavior (icon + background color change for 3 seconds). Add new `generacy.notifications.*` configuration settings alongside the existing `generacy.dashboard.notifications` setting.

## Technical Context

- **Language**: TypeScript
- **Framework**: VS Code Extension API
- **Build**: pnpm, esbuild
- **Existing patterns**: SSE subscription via `SSESubscriptionManager.subscribe()`, Zod-validated API calls via `queueApi`, singleton/disposable pattern
- **Key dependencies**: `vscode`, existing `SSESubscriptionManager`, `queueApi.getJobProgress()`

## Architecture Overview

```
SSE (queue channel)
     │
     ▼
JobNotificationService
     │
     ├─ Filters for terminal statuses (completed/failed/cancelled)
     ├─ Deduplicates via bounded ID set (100)
     ├─ Checks configuration (enabled, onComplete, onError)
     ├─ Rate-limits / batches (3+ in 10s → summary)
     ├─ Batches when VS Code unfocused (3+ → summary)
     │
     ├─ On completion: fetches JobProgress for PR URL + duration
     ├─ On failure: fetches JobProgress for failed step/phase + error
     │
     ├─ Shows vscode.window notifications with action buttons
     └─ Notifies CloudJobStatusBarProvider to flash

CloudJobStatusBarProvider (enhanced)
     │
     ├─ Existing: shows running count
     └─ New: flash icon+color for 3s on terminal events
```

## Implementation Phases

### Phase 1: Configuration Settings

**Files modified**: `packages/generacy-extension/package.json`, `packages/generacy-extension/src/constants.ts`

Add new VS Code configuration properties under `generacy.notifications`:

```json
{
  "generacy.notifications.enabled": {
    "type": "boolean",
    "default": true,
    "description": "Enable notifications when cloud jobs complete or fail. This controls job completion toasts specifically — see generacy.dashboard.notifications for dashboard-level event notifications."
  },
  "generacy.notifications.onComplete": {
    "type": "boolean",
    "default": true,
    "description": "Show a notification when a cloud job completes successfully."
  },
  "generacy.notifications.onError": {
    "type": "boolean",
    "default": true,
    "description": "Show a notification when a cloud job fails."
  },
  "generacy.notifications.sound": {
    "type": "boolean",
    "default": false,
    "markdownDescription": "Play a sound when a job completes or fails. *(Not yet implemented — reserved for future use.)*"
  }
}
```

Update `constants.ts` to add notification config keys:

```typescript
export const CONFIG_KEYS = {
  // ... existing
  notificationsEnabled: 'notifications.enabled',
  notificationsOnComplete: 'notifications.onComplete',
  notificationsOnError: 'notifications.onError',
};
```

### Phase 2: Enhance CloudJobStatusBarProvider

**Files modified**: `packages/generacy-extension/src/providers/status-bar.ts`

Add a `flash()` method to `CloudJobStatusBarProvider` that temporarily changes the icon and background color for 3 seconds, then reverts:

```typescript
public flash(status: 'completed' | 'failed' | 'cancelled'): void {
  // Save current state
  const previousText = this.statusBarItem.text;
  const previousBg = this.statusBarItem.backgroundColor;

  // Set flash appearance
  if (status === 'completed') {
    this.statusBarItem.text = `$(check) Job completed`;
    this.statusBarItem.backgroundColor = undefined; // default
  } else if (status === 'failed') {
    this.statusBarItem.text = `$(error) Job failed`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    this.statusBarItem.text = `$(stop) Job cancelled`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  this.statusBarItem.show();

  // Revert after 3 seconds
  clearTimeout(this.flashTimer);
  this.flashTimer = setTimeout(() => {
    this.statusBarItem.text = previousText;
    this.statusBarItem.backgroundColor = previousBg;
    // Re-hide if count was 0
    if (this.currentCount === 0) {
      this.statusBarItem.hide();
    }
  }, 3000);
}
```

This requires tracking `currentCount` as instance state (currently derived on each `updateCount` call).

### Phase 3: Create JobNotificationService

**New file**: `packages/generacy-extension/src/services/job-notification-service.ts`

Core responsibilities:

1. **SSE subscription**: Subscribe to `queue` channel, filter for `queue:updated` events where `status` is `completed`, `failed`, or `cancelled`.

2. **Deduplication**: Maintain a `Set<string>` of seen event IDs, bounded to 100 entries (FIFO eviction). Prevents duplicate notifications after SSE reconnection with `Last-Event-ID` replay.

3. **Configuration check**: Read `generacy.notifications.enabled`, `.onComplete`, `.onError` settings. Skip notification if disabled.

4. **Data enrichment**: On terminal events, call `queueApi.getJobProgress(id)` to fetch:
   - `pullRequestUrl` (for "View PR" button on success)
   - Failed phase/step name and error details (for failure message)
   - Duration (computed from `startedAt`/`completedAt` on `QueueItem`)

5. **Notification display**:
   - **Completed**: `showInformationMessage` with workflow name, duration, PR info. Actions: "View PR" (if PR exists), "View Details".
   - **Failed**: `showWarningMessage` with workflow name, duration, failed step. Actions: "View Logs", "View Details".
   - **Cancelled**: `showInformationMessage` with workflow name. Action: "View Details".

6. **Action handling**:
   - "View PR" → `vscode.env.openExternal(prUrl)`
   - "View Details" / "View Logs" → `vscode.commands.executeCommand('generacy.queue.viewDetails', item)`

7. **Rate limiting**: If 3+ notifications would fire within a 10-second window, group into a single summary notification (e.g., "3 jobs completed, 1 failed") with a "View Queue" action that executes `generacy.queue.focus`.

8. **Focus batching**: Track `vscode.window.state.focused`. When unfocused, queue notifications. On refocus, if 3+ queued, show a single summary instead of individual toasts.

9. **continueOnError inference**: If a step fails (`workflow:step:complete` with status `failed`) but no terminal `queue:updated` follows, treat as `continueOnError`. Flash the status bar via `CloudJobStatusBarProvider.flash()` but suppress the toast. This requires also subscribing to `workflows` channel for step-level failure events.

10. **Status bar flash**: On any terminal event, call `cloudStatusBar.flash(status)`.

#### Class signature:

```typescript
export class JobNotificationService implements vscode.Disposable {
  constructor(
    private readonly cloudStatusBar: CloudJobStatusBarProvider,
    private readonly queueProvider: QueueTreeProvider,
    private readonly extensionUri: vscode.Uri,
  ) { ... }

  dispose(): void { ... }
}
```

#### Key internal state:

```typescript
private readonly seenEventIds = new Set<string>();
private readonly seenEventIdOrder: string[] = []; // FIFO for eviction
private pendingNotifications: PendingNotification[] = [];
private batchTimer: ReturnType<typeof setTimeout> | undefined;
private unfocusedQueue: PendingNotification[] = [];
```

### Phase 4: Wire Into Cloud Initialization

**Files modified**: `packages/generacy-extension/src/commands/cloud.ts`

After the existing `NotificationManager` initialization (line 205-208), instantiate `JobNotificationService`:

```typescript
// Initialize job notification service (terminal status alerts)
const jobNotificationService = new JobNotificationService(
  cloudStatusBar,
  queueProvider,
  context.extensionUri,
);
context.subscriptions.push(jobNotificationService);
logger.info('Job notification service initialized');
```

The existing `NotificationManager` remains unchanged — it handles ambient dashboard-level notifications. The new `JobNotificationService` handles job-specific terminal alerts.

### Phase 5: Update Existing Dashboard Notification Setting Description

**Files modified**: `packages/generacy-extension/package.json`

Update the description of the existing `generacy.dashboard.notifications` setting to clarify its scope relative to the new settings:

```json
{
  "generacy.dashboard.notifications": {
    "description": "Notification level for orchestration activity events (workflow progress, agent connections). For job completion/failure alerts, see generacy.notifications.* settings."
  }
}
```

## Data Model

No new persistent data models. The service uses in-memory state only:

| State | Type | Purpose |
|-------|------|---------|
| `seenEventIds` | `Set<string>` (max 100) | Deduplication of SSE replay events |
| `pendingNotifications` | `PendingNotification[]` | Rate-limiting batch window |
| `unfocusedQueue` | `PendingNotification[]` | Notifications queued while VS Code unfocused |

```typescript
interface PendingNotification {
  queueItem: QueueItem;
  status: 'completed' | 'failed' | 'cancelled';
  progress?: JobProgress;
  timestamp: number;
}
```

## API Contracts

No new API endpoints. Uses existing:

- **`GET /queue/:id/progress`** → `JobProgress` (via `queueApi.getJobProgress(id)`)
  - Called on completion to get `pullRequestUrl`
  - Called on failure to get failed phase/step details
  - Already used by `JobDetailPanel`

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SSE event type | `queue:updated` | Already emitted and handled (Q1 answer). No backend changes. |
| Relationship to existing NotificationManager | Separate service, incremental migration (Q2-C) | Existing `NotificationManager` handles dashboard-level events generically. New service is job-terminal-specific. |
| Failed step info | Fetch `JobProgress` on failure (Q3-A) | Single API call on infrequent event. `JobProgress` already has full phase/step detail. |
| PR info | Fetch `JobProgress` on completion (Q4-A) | Same pattern as failure. `pullRequestUrl` is on `JobProgress`. |
| `continueOnError` | Infer from behavior (Q5-C) | If step fails but job continues → flash status bar, suppress toast. No backend changes. |
| View command | Use `generacy.queue.viewDetails` (Q6-A) | Already registered and opens `JobDetailPanel`. |
| Config namespace | Separate scopes (Q7-B) | Dashboard notifications vs job terminal alerts are conceptually different. |
| Dedup set | In-memory, 100 IDs (Q8-A) | SSE restart doesn't replay; reconnect replay window is small. |
| Status bar flash | Icon swap + background color, 3s revert (Q9-B) | Native VS Code API. More noticeable than color alone. |
| Sound | Deferred/P3 (Q10-A) | No clean VS Code API. Setting declared for forward-compatibility. |
| Unfocused batching | Batch if 3+ accumulated (Q11-B) | Prevents stale toast flood on refocus. |
| Rate limiting | Group if 3+ in 10s (Q12-B) | Consistent with existing NotificationManager batch pattern. |

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| API call on every terminal event | Network overhead if many jobs finish | Failures are infrequent; completions are low-cardinality. Rate-limited to 3+ → batch. |
| SSE reconnection replays events | Duplicate notifications | Bounded dedup set of 100 event IDs covers replay window. |
| Notification flood from concurrent jobs | UX degradation | Rate limiting (3+ in 10s → summary) + unfocused batching. |
| `getJobProgress` fails | Missing PR/step info | Gracefully degrade: show notification without PR button or step name. Use `error` field from `QueueItem` as fallback. |
| Configuration conflicts with dashboard setting | User confusion | Clear descriptions in settings differentiating scope. |
| Status bar flash timer race conditions | Visual glitch | Clear previous timer before starting new flash. Track count state. |

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/generacy-extension/package.json` | Modify | Add `generacy.notifications.*` settings, update dashboard setting description |
| `packages/generacy-extension/src/constants.ts` | Modify | Add notification config key constants |
| `packages/generacy-extension/src/providers/status-bar.ts` | Modify | Add `flash()` method, track `currentCount` |
| `packages/generacy-extension/src/services/job-notification-service.ts` | **New** | Core notification service |
| `packages/generacy-extension/src/commands/cloud.ts` | Modify | Wire `JobNotificationService` into initialization |

## Testing Strategy

- **Unit tests**: `JobNotificationService` logic — deduplication, rate limiting, configuration checks, notification formatting, focus batching
- **Integration tests**: SSE event → notification flow using mock SSE events
- **Manual testing**: Trigger job completion/failure via orchestrator, verify toast content, action buttons, status bar flash
