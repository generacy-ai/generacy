# Tasks: Live Log/Conversation Viewer

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Type Definitions and API Layer

### T001 [DONE] Add `'jobs'` to SSEChannel type and Zod schema
**File**: `packages/generacy-extension/src/api/types.ts`
- Add `'jobs'` to the `SSEChannel` type union at line 920: `'workflows' | 'queue' | 'agents' | 'jobs'`
- Add `'jobs'` to the `SSEEventSchema` Zod `z.enum` at line 944: `z.enum(['workflows', 'queue', 'agents', 'jobs'])`

### T002 [DONE] [P] Add job log types and Zod schemas
**File**: `packages/generacy-extension/src/api/types.ts`
- Add `JobLogLine` interface after the Agent Log Types section (~line 911):
  - `content: string` — the log line text (pre-cleaned, no ANSI)
  - `stream: 'stdout' | 'stderr'` — which output stream
  - `timestamp: string` — ISO timestamp
  - `stepName?: string` — optional step context
- Add `JobLogsResponse` interface:
  - `lines: JobLogLine[]` — array of log lines
  - `total: number` — total line count on server
  - `cursor?: string` — cursor for SSE handoff (per decision D5)
  - `truncated: boolean` — whether result was truncated
- Add `JobLogLineSchema` Zod schema
- Add `JobLogsResponseSchema` Zod schema

### T003 [DONE] [P] Add `viewLogs` message type to JobDetailWebviewMessage
**File**: `packages/generacy-extension/src/api/types.ts`
- Add `| { type: 'viewLogs' }` to the `JobDetailWebviewMessage` union at line 546

### T004 [DONE] Add `'jobs'` to ALL_CHANNELS array in SSE manager
**File**: `packages/generacy-extension/src/api/sse.ts`
- Update `ALL_CHANNELS` at line 30: `const ALL_CHANNELS: SSEChannel[] = ['workflows', 'queue', 'agents', 'jobs']`

### T005 [DONE] Add `getJobLogs` endpoint method
**File**: `packages/generacy-extension/src/api/endpoints/queue.ts`
- Add `getJobLogs(id: string, options?: { limit?: number }): Promise<JobLogsResponse>` method to `queueApi`
- Calls `GET /queue/${id}/logs?limit=${options?.limit ?? 10000}`
- Uses `JobLogsResponseSchema` for response validation
- Import `JobLogsResponse` and `JobLogsResponseSchema` from types

---

## Phase 2: Constants and Command Registration

### T006 [DONE] Add `viewJobLogs` command constant
**File**: `packages/generacy-extension/src/constants.ts`
- Add `viewJobLogs: 'generacy.queue.viewLogs'` to the `CLOUD_COMMANDS` object (after `viewJobProgress` at line 64)

### T007 [DONE] Register command in package.json
**File**: `packages/generacy-extension/package.json`
- Add command definition to the `contributes.commands` array:
  ```json
  {
    "command": "generacy.queue.viewLogs",
    "title": "View Logs",
    "category": "Generacy",
    "icon": "$(terminal)"
  }
  ```
- Add inline button for queue tree items in `menus.view/item/context`:
  ```json
  {
    "command": "generacy.queue.viewLogs",
    "when": "view == generacy.queue && viewItem =~ /^queueItem/",
    "group": "inline@4"
  }
  ```
- Add right-click context menu entry in `menus.view/item/context`:
  ```json
  {
    "command": "generacy.queue.viewLogs",
    "when": "view == generacy.queue && viewItem =~ /^queueItem/",
    "group": "navigation@2"
  }
  ```

---

## Phase 3: Core Implementation — JobLogChannel

### T008 [DONE] Create JobLogChannel class
**File**: `packages/generacy-extension/src/views/cloud/log-viewer/log-channel.ts` (new)
- Create the main `JobLogChannel` class implementing `vscode.Disposable`
- Follow the `AgentLogChannel` pattern from `views/cloud/agents/log-channel.ts`
- **Static registry**: `private static activeChannels: Map<string, JobLogChannel>`
- **Constructor** (private):
  - Accept `jobId: string` and `workflowName: string`
  - Create `vscode.OutputChannel` with name format `"Job: ${workflowName} (${jobId.slice(0, 8)})"`
  - Store `jobId`, `workflowName`, `sseDisposable`, `disposed`, `lastStepName`, `retryCount`, `retryTimer`
- **`open()` method**:
  - Clear output channel
  - Show header: `--- Logs for ${workflowName} (${jobId.slice(0, 8)}) ---`
  - Call `fetchHistoricalLogs()` to get cursor
  - Call `subscribeToSSE(cursor)` for live streaming
  - Show the output channel via `outputChannel.show(true)`
- **`fetchHistoricalLogs()` method** (private):
  - Call `queueApi.getJobLogs(this.jobId, { limit: 10000 })`
  - If `response.truncated`, show: `--- Showing last ${lines.length} of ${total} lines ---`
  - Append each line using `formatLogLine()`
  - If 0 lines returned, show `"Waiting for job to start..."`
  - Return `response.cursor` for SSE handoff
  - Wrap in try/catch with `handleFetchError()`
- **`subscribeToSSE(cursor?)` method** (private):
  - Dispose existing SSE subscription
  - Get `SSESubscriptionManager.getInstance()`
  - Subscribe to `'jobs'` channel
  - Filter events by `jobId` match
  - Route events: `job:log` → `handleLogEvent()`, `job:step-start` → `handleStepBoundary()`, `job:log:end` → `handleJobEnd()`
  - Show `--- Live log stream active ---` after subscribing
- **`handleLogEvent(event)` method** (private):
  - Extract `content`, `stream`, `timestamp` from event data
  - Call `formatLogLine()` and append to output channel
- **`handleStepBoundary(event)` method** (private):
  - Extract `stepName` from event data
  - Call `appendStepSeparator(stepName)`
- **`handleJobEnd(event)` method** (private):
  - Extract `status` from event data
  - Append `--- Job ${status} ---`
  - Dispose SSE subscription (stop listening)
- **`formatLogLine(line)` method** (private):
  - Format timestamp as `[HH:mm:ss]`
  - Prefix stderr lines with `[ERR]`
  - Return formatted string
- **`appendStepSeparator(stepName)` method** (private):
  - Append visual separator: `────── Step: ${stepName} ──────`
  - Update `lastStepName`
- **`handleFetchError(error)` method** (private):
  - Show error inline in output channel
  - Retry up to 3 times with backoff (5s, 10s, 20s)
  - On max retries, show final error message
- **`dispose()` method**:
  - Set `disposed = true`
  - Dispose SSE subscription
  - Clear retry timer
  - Dispose output channel
  - Remove from `activeChannels` map
- **`static openJobLogs(jobId, workflowName)` method**:
  - Check `activeChannels` map — if exists, just show and return
  - Create new `JobLogChannel`, add to map
  - Call `open()`
- **`static disposeAll()` method**:
  - Iterate and dispose all channels in `activeChannels`
  - Clear the map

### T009 [DONE] [P] Create log-viewer module index
**File**: `packages/generacy-extension/src/views/cloud/log-viewer/index.ts` (new)
- Export `JobLogChannel` from `./log-channel`

---

## Phase 4: Integration — Command Handlers and UI

### T010 [DONE] Add `viewJobLogs` command handler and registration
**File**: `packages/generacy-extension/src/views/cloud/queue/actions.ts`
- Import `JobLogChannel` from `../log-viewer`
- Import `CLOUD_COMMANDS` if not already imported
- Add `viewJobLogs` function:
  - Accept `QueueTreeItem` parameter
  - Validate item exists and `isQueueTreeItem(item)`
  - Call `JobLogChannel.openJobLogs(item.queueItem.id, item.queueItem.workflowName)`
- Register command in `registerQueueActions()`:
  ```typescript
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CLOUD_COMMANDS.viewJobLogs,
      async (item?: QueueTreeItem) => { ... }
    )
  );
  ```

### T011 [DONE] [P] Handle `viewLogs` message in JobDetailPanel
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts`
- Import `JobLogChannel` from `../log-viewer`
- Add case in `handleMessage()` method (where other message types are handled):
  ```typescript
  case 'viewLogs':
    void JobLogChannel.openJobLogs(this.queueItem.id, this.queueItem.workflowName);
    break;
  ```

### T012 [DONE] [P] Add "View Logs" button to job detail HTML
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-html.ts`
- Add a "View Logs" button in the header/actions section (alongside pin/refresh)
- Use `$(terminal)` codicon icon for consistency with tree context menu
- Button sends `{ type: 'viewLogs' }` via `postMessage` on click
- Visible for all job states (pending, running, completed, failed, cancelled — per decision D6)

### T013 [DONE] [P] Re-export from queue index if needed
**File**: `packages/generacy-extension/src/views/cloud/queue/index.ts`
- Verify current exports and add re-export for `viewJobLogs` from actions if the pattern requires it

---

## Phase 5: Extension Lifecycle

### T014 [DONE] Add JobLogChannel cleanup to extension deactivation
**File**: `packages/generacy-extension/src/extension.ts`
- Import `JobLogChannel` from `./views/cloud/log-viewer`
- Add `JobLogChannel.disposeAll()` to the `deactivate()` function alongside existing cleanup

---

## Phase 6: Testing

### T015 [DONE] Write unit tests for JobLogChannel
**File**: `packages/generacy-extension/src/views/cloud/log-viewer/__tests__/log-channel.test.ts` (new)
- **Channel creation**: Verify `OutputChannel` is created with correct name format `"Job: workflow-name (a1b2c3d4)"`
- **Channel reuse**: Same `jobId` returns existing channel instance (no duplicate)
- **Historical log fetch**: Calls `queueApi.getJobLogs` with correct params (`{ limit: 10000 }`), displays lines in order
- **Truncation header**: Shows truncation message when `response.truncated === true`
- **SSE subscription**: Subscribes to `'jobs'` channel on `SSESubscriptionManager`
- **Event filtering**: Only processes events where `data.jobId` matches this channel's `jobId`
- **Log line formatting**: Correct timestamp prefix `[HH:mm:ss]`, stderr prefix `[ERR]`
- **Step boundary**: Inserts visual separator `────── Step: stepName ──────` on `job:step-start` event
- **Job end**: Shows terminal message on `job:log:end` event, disposes SSE subscription
- **Retry on error**: Retries historical fetch up to 3 times with increasing backoff
- **Pending job**: Shows `"Waiting for job to start..."` when 0 lines returned
- **Dispose**: Cleans up SSE subscription, removes from activeChannels map
- **disposeAll**: Disposes all active channels and clears the map

### T016 [DONE] [P] Extend queue actions tests for viewJobLogs command
**File**: `packages/generacy-extension/src/views/cloud/queue/__tests__/actions.test.ts`
- Add test for `viewJobLogs` command registration
- Test that command calls `JobLogChannel.openJobLogs` with correct `id` and `workflowName`
- Test warning message when no queue item is selected

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (Types/API) must complete before Phase 3 (Core Implementation)
- Phase 2 (Constants/Package.json) must complete before Phase 4 (Integration)
- Phase 3 (Core Implementation) must complete before Phase 4 (Integration)
- Phase 4 (Integration) must complete before Phase 5 (Lifecycle)
- Phase 6 (Testing) depends on Phases 3-5

**Parallel opportunities within phases**:
- **Phase 1**: T002, T003 can run in parallel (both modify `types.ts` but in different sections). T004, T005 can run in parallel with each other (different files). T001 must be done before T004.
- **Phase 2**: T006 and T007 can run in parallel (different files)
- **Phase 3**: T008 and T009 can run in parallel (T009 is trivial index file)
- **Phase 4**: T010 is sequential (depends on T008). T011, T012, T013 can run in parallel (different files)
- **Phase 6**: T015 and T016 can run in parallel (different test files)

**Critical path**:
T001 → T002/T003 → T005 → T008 → T010 → T014 → T015
