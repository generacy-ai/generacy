# Tasks: Job Completion Notifications

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Configuration & Constants

### T001 [DONE] [P] Add notification configuration settings to package.json
**File**: `packages/generacy-extension/package.json`
- Add `generacy.notifications.enabled` (boolean, default: `true`) — master toggle for job completion/failure notifications
- Add `generacy.notifications.onComplete` (boolean, default: `true`) — notify on successful completion
- Add `generacy.notifications.onError` (boolean, default: `true`) — notify on job failure
- Add `generacy.notifications.sound` (boolean, default: `false`) — reserved for future use, with `markdownDescription` noting it is not yet implemented
- Place new settings after the existing `generacy.dashboard.notifications` setting
- Update `generacy.dashboard.notifications` description to clarify its scope: "Notification level for orchestration activity events (workflow progress, agent connections). For job completion/failure alerts, see generacy.notifications.* settings."

### T002 [DONE] [P] Add notification config key constants
**File**: `packages/generacy-extension/src/constants.ts`
- Add to `CONFIG_KEYS` object:
  - `notificationsEnabled: 'notifications.enabled'`
  - `notificationsOnComplete: 'notifications.onComplete'`
  - `notificationsOnError: 'notifications.onError'`

---

## Phase 2: Status Bar Enhancement

### T003 [DONE] Enhance CloudJobStatusBarProvider with flash method
**File**: `packages/generacy-extension/src/providers/status-bar.ts`
- Add `private currentCount = 0` instance field to track job count state
- Add `private flashTimer: ReturnType<typeof setTimeout> | undefined` for flash timeout management
- Update `updateCount()` to set `this.currentCount = count` before the existing logic
- Add `public flash(status: 'completed' | 'failed' | 'cancelled'): void` method:
  - Save current `text` and `backgroundColor` of `statusBarItem`
  - Set flash appearance based on status:
    - `completed`: `$(check) Job completed`, default background
    - `failed`: `$(error) Job failed`, `statusBarItem.errorBackground` theme color
    - `cancelled`: `$(stop) Job cancelled`, `statusBarItem.warningBackground` theme color
  - Force `statusBarItem.show()` during flash
  - Clear any existing `flashTimer` before starting a new one
  - After 3000ms, revert to saved text/backgroundColor; hide if `currentCount === 0`
- Update `dispose()` to clear `flashTimer` if active

---

## Phase 3: Core Notification Service

### T004 [DONE] Create JobNotificationService — SSE subscription and event filtering
**File**: `packages/generacy-extension/src/services/job-notification-service.ts` (new)
- Create `JobNotificationService` class implementing `vscode.Disposable`
- Constructor parameters: `cloudStatusBar: CloudJobStatusBarProvider`, `queueProvider: QueueTreeProvider`, `extensionUri: vscode.Uri`
- Subscribe to `queue` channel via `SSESubscriptionManager.getInstance().subscribe()`
- Filter events: only process `queue:updated` events where `data.status` is `'completed'`, `'failed'`, or `'cancelled'`
- Implement `dispose()`: dispose all SSE subscriptions, clear all timers

### T005 [DONE] Add event deduplication logic
**File**: `packages/generacy-extension/src/services/job-notification-service.ts`
- Add `private readonly seenEventIds = new Set<string>()` and `private readonly seenEventIdOrder: string[] = []`
- On each qualifying event, check if `event.id` is in `seenEventIds`; skip if already seen
- Add new event IDs to both `seenEventIds` and `seenEventIdOrder`
- When `seenEventIds.size > 100`, evict the oldest ID (shift from `seenEventIdOrder`, delete from `seenEventIds`)

### T006 [DONE] Add configuration checking
**File**: `packages/generacy-extension/src/services/job-notification-service.ts`
- Read `generacy.notifications.enabled` via `vscode.workspace.getConfiguration('generacy')` — skip all notifications if `false`
- Read `generacy.notifications.onComplete` — skip completed job notifications if `false`
- Read `generacy.notifications.onError` — skip failed/cancelled job notifications if `false`
- Configuration is read on each event (no caching needed — `getConfiguration` is fast)

### T007 [DONE] Add data enrichment via JobProgress API
**File**: `packages/generacy-extension/src/services/job-notification-service.ts`
- On terminal events, call `queueApi.getJobProgress(jobId)` to fetch full progress details
- Extract from `JobProgress`:
  - `pullRequestUrl` for "View PR" button on completed jobs
  - Failed phase/step name and `error` message for failure notifications
- Compute duration from `QueueItem.startedAt` / `QueueItem.completedAt` (available in SSE event data)
- Gracefully degrade if `getJobProgress()` fails: show notification without PR button or step details, fall back to `QueueItem.error` field
- Add `private formatDuration(ms: number): string` helper (e.g., "31m 22s", "1h 5m")

### T008 [DONE] Add notification display and action handling
**File**: `packages/generacy-extension/src/services/job-notification-service.ts`
- **Completed jobs**: `vscode.window.showInformationMessage` with:
  - Message: `"✅ {workflowName} completed ({duration})"` with PR info if available (e.g., `"→ PR #{number}: {title}"`)
  - Actions: `"View PR"` (only if `pullRequestUrl` exists), `"View Details"`
- **Failed jobs**: `vscode.window.showWarningMessage` with:
  - Message: `"❌ {workflowName} failed at step \"{stepName}\" ({duration})"` with error detail
  - Actions: `"View Logs"`, `"View Details"`
- **Cancelled jobs**: `vscode.window.showInformationMessage` with:
  - Message: `"{workflowName} was cancelled"`
  - Action: `"View Details"`
- Action handlers:
  - `"View PR"` → `vscode.env.openExternal(vscode.Uri.parse(pullRequestUrl))`
  - `"View Details"` / `"View Logs"` → `vscode.commands.executeCommand('generacy.queue.viewProgress', jobId)` (use `viewJobProgress` command since `viewDetails` expects a `QueueTreeItem`, not a raw ID)
- Trigger `cloudStatusBar.flash(status)` on every terminal event

### T009 [DONE] Add rate limiting (batch when 3+ events in 10s)
**File**: `packages/generacy-extension/src/services/job-notification-service.ts`
- Define `PendingNotification` interface: `{ queueItem: QueueItem, status: 'completed' | 'failed' | 'cancelled', progress?: JobProgress, timestamp: number }`
- Add `private pendingNotifications: PendingNotification[]` and `private batchTimer: ReturnType<typeof setTimeout> | undefined`
- When a new notification is ready to display:
  - Add to `pendingNotifications` with current timestamp
  - If no `batchTimer` running, start a 10-second window timer
  - When timer fires: if 3+ pending, show single summary notification (e.g., "3 jobs completed, 1 failed") with "View Queue" action → `generacy.queue.focus`; if <3, show individual notifications
- Clear `batchTimer` in `dispose()`

### T010 [DONE] Add focus batching (queue notifications when VS Code unfocused)
**File**: `packages/generacy-extension/src/services/job-notification-service.ts`
- Add `private unfocusedQueue: PendingNotification[]`
- Track `vscode.window.state.focused` via `vscode.window.onDidChangeWindowState`
- When unfocused: queue notifications into `unfocusedQueue` instead of displaying
- On refocus: if 3+ queued, show single summary notification; if <3, show individually
- Clear `unfocusedQueue` and listener in `dispose()`

### T011 [DONE] Add continueOnError step-failure handling
**File**: `packages/generacy-extension/src/services/job-notification-service.ts`
- Subscribe to `workflows` channel in addition to `queue` channel
- Listen for `workflow:step:complete` events where `data.step.status === 'failed'`
- When a step fails but no corresponding terminal `queue:updated` event arrives within a short window (e.g., 5s), infer `continueOnError`
- On `continueOnError` step failures: flash status bar via `cloudStatusBar.flash('failed')` but suppress the toast notification
- Track pending step failures with a timer; clear if terminal event arrives for the same job

---

## Phase 4: Service Wiring

### T012 [DONE] Wire JobNotificationService into cloud initialization
**File**: `packages/generacy-extension/src/commands/cloud.ts`
- Import `JobNotificationService` from `../services/job-notification-service`
- After the existing `NotificationManager` initialization (after line 208), instantiate:
  ```typescript
  const jobNotificationService = new JobNotificationService(
    cloudStatusBar,
    queueProvider,
    context.extensionUri,
  );
  context.subscriptions.push(jobNotificationService);
  logger.info('Job notification service initialized');
  ```
- The existing `NotificationManager` remains unchanged

---

## Phase 5: Testing

### T013 [DONE] [P] Write unit tests for CloudJobStatusBarProvider.flash()
**File**: `packages/generacy-extension/src/providers/__tests__/status-bar.test.ts`
- Test flash with `'completed'` status: verify icon text set to `$(check) Job completed`, background color reset, item shown
- Test flash with `'failed'` status: verify icon text set to `$(error) Job failed`, background color set to `statusBarItem.errorBackground`
- Test flash with `'cancelled'` status: verify icon text set to `$(stop) Job cancelled`, background color set to `statusBarItem.warningBackground`
- Test revert after 3000ms: use `vi.useFakeTimers()`, advance by 3000ms, verify previous text/background restored
- Test that re-hide occurs after flash revert when `currentCount === 0`
- Test that rapid sequential flashes clear previous timer (no stale revert)
- Follow existing mock pattern in `status-bar.test.ts` for `vscode.window.createStatusBarItem`

### T014 [DONE] [P] Write unit tests for JobNotificationService
**File**: `packages/generacy-extension/src/services/__tests__/job-notification-service.test.ts` (new)
- **Deduplication tests**:
  - Duplicate event IDs are ignored (no duplicate notification)
  - FIFO eviction works: after 101 events, oldest ID is evicted and can trigger again
- **Configuration tests**:
  - When `notifications.enabled` is `false`, no notifications shown for any status
  - When `notifications.onComplete` is `false`, completed jobs are suppressed but failed still shows
  - When `notifications.onError` is `false`, failed/cancelled jobs are suppressed but completed still shows
- **Notification content tests**:
  - Completed job with PR: message includes workflow name, duration, PR info; "View PR" and "View Details" buttons present
  - Completed job without PR: message includes workflow name, duration; only "View Details" button
  - Failed job: warning message includes workflow name, failed step, error detail; "View Logs" and "View Details" buttons
  - Cancelled job: info message with workflow name; "View Details" button
- **Action handling tests**:
  - "View PR" action calls `vscode.env.openExternal` with PR URL
  - "View Details" action calls `vscode.commands.executeCommand` with correct command and arguments
- **Rate limiting tests**:
  - 1-2 notifications within 10s: shown individually
  - 3+ notifications within 10s: grouped into summary with "View Queue" action
- **Focus batching tests**:
  - Notifications queue when `window.state.focused` is `false`
  - On refocus with <3 queued: shown individually
  - On refocus with 3+ queued: shown as summary
- **Data enrichment tests**:
  - When `getJobProgress()` fails: notification still shown with fallback data from QueueItem
  - Duration formatting: seconds, minutes, hours
- **Status bar flash tests**:
  - `cloudStatusBar.flash()` is called for each terminal event
- **continueOnError tests**:
  - Step failure without subsequent terminal event → status bar flash only, no toast
  - Step failure followed by terminal event within window → normal terminal notification
- **Dispose tests**:
  - All timers cleared on dispose
  - All subscriptions disposed
- Mock `SSESubscriptionManager.getInstance()`, `queueApi.getJobProgress()`, `vscode.window.*`, `vscode.workspace.getConfiguration()`

---

## Phase 6: Validation

### T015 [DONE] Verify TypeScript compilation
**Files**:
- All modified and new files
- Run `pnpm --filter generacy-extension exec tsc --noEmit` to ensure no type errors
- Fix any compilation issues

### T016 [DONE] Run existing test suite
**Files**:
- `packages/generacy-extension/src/**/*.test.ts`
- Run `pnpm --filter generacy-extension test` to ensure no regressions
- Fix any failing tests caused by the changes

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (Configuration) must complete before Phase 3 (Service) — service reads config keys
- Phase 2 (Status Bar) must complete before Phase 3 (Service) — service calls `flash()`
- Phase 3 (Service) must complete before Phase 4 (Wiring) — wiring imports the service
- Phases 1-4 (Implementation) must complete before Phase 5 (Testing)
- Phase 5 (Testing) must complete before Phase 6 (Validation)

**Parallel opportunities within phases**:
- T001 and T002 can run in parallel (different files)
- T013 and T014 can run in parallel (different test files)
- Within Phase 3, tasks T004-T011 are sequential (same file, each builds on prior work)

**Critical path**:
T001 → T003 → T004 → T005 → T006 → T007 → T008 → T009 → T010 → T011 → T012 → T014 → T015 → T016
