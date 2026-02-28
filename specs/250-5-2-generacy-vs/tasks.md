# Tasks: 5.2 — Generacy VS Code Extension MVP

**Input**: `spec.md`, `plan.md`, existing codebase at `packages/generacy-extension/`
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Project Config Detection (US3)

### T001 [DONE] [US3] Add context keys and constants for project config
**File**: `packages/generacy-extension/src/constants.ts`
- Add `hasProjectConfig: 'generacy.hasProjectConfig'` to `CONTEXT_KEYS`
- Add `projectConfig: 'projectConfig'` to `CONFIG_KEYS` (if needed for settings)

### T002 [DONE] [US3] Create ProjectConfigService
**File**: `packages/generacy-extension/src/services/project-config-service.ts` (NEW)
- Create `ProjectConfig` interface: `project: { id: string; name: string }`, `repos?: { primary?: string }`
- Create `ProjectConfigSchema` using Zod for runtime validation (use `.passthrough()` for forward compat)
- Implement `ProjectConfigService` class (singleton, `vscode.Disposable`):
  - Parse `.generacy/config.yaml` from first workspace folder using `yaml` package (already in deps)
  - `FileSystemWatcher` for `.generacy/config.yaml` to auto-reload on changes
  - `onDidChange` EventEmitter for config change notifications
  - Getters: `projectId`, `projectName`, `reposPrimary`, `isConfigured`
  - Graceful fallback when no config exists (`isConfigured = false`)
  - `initialize()` method that reads config and sets up watcher
  - `dispose()` method for cleanup

### T003 [DONE] [P] [US3] Add project name to status bar
**File**: `packages/generacy-extension/src/providers/status-bar.ts`
- Add a new `ProjectStatusBarProvider` class (or extend `CloudJobStatusBarProvider`)
- Create a status bar item showing `$(project) ProjectName` when config is detected
- Subscribe to `ProjectConfigService.onDidChange` to update display
- Hide when no config exists

### T004 [DONE] [US3] Wire ProjectConfigService into extension activation
**File**: `packages/generacy-extension/src/extension.ts`
- Import and initialize `ProjectConfigService` during `activate()`
- Call `projectConfigService.initialize()` after workspace is available
- Set context key `generacy.hasProjectConfig` via `vscode.commands.executeCommand('setContext', ...)`
- Pass `ProjectConfigService` to status bar provider
- Pass `ProjectConfigService` to cloud commands initialization (for Phase 4)
- Add to `context.subscriptions` for disposal

### T005 [DONE] [P] [US3] Write ProjectConfigService unit tests
**File**: `packages/generacy-extension/src/services/__tests__/project-config-service.test.ts` (NEW)
- Test: valid config YAML parsing extracts `project.id`, `project.name`, `repos.primary`
- Test: missing config file returns `isConfigured = false` gracefully
- Test: invalid YAML triggers warning, doesn't throw
- Test: Zod validation error on malformed config → warning message, `isConfigured = false`
- Test: `onDidChange` emits when config changes
- Test: disposal cleans up watcher and emitter

---

## Phase 2: Waiting Queue Status (US4, US7)

### T006 [DONE] [US4] Extend QueueStatus type and schema with `waiting`
**File**: `packages/generacy-extension/src/api/types.ts`
- Add `'waiting'` to `QueueStatus` type union: `'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'`
- Add `'waiting'` to `QueueItemSchema` `status` z.enum
- Add `waitingFor?: string` field to `QueueItem` interface
- Add `waitingFor: z.string().optional()` to `QueueItemSchema`

### T007 [DONE] [P] [US4] Add waiting status icon to queue tree item
**File**: `packages/generacy-extension/src/views/cloud/queue/tree-item.ts`
- Add `waiting` entry to `STATUS_ICONS` record: `{ icon: 'bell', color: 'charts.orange' }`
- Update `getTimeInfo()` to handle `'waiting'` case — show `waitingFor` label and time waiting
- Update `getDescription()` to include `waitingFor` as description text for waiting items

### T008 [DONE] [P] [US4] Add waiting status to queue tree provider
**File**: `packages/generacy-extension/src/views/cloud/queue/provider.ts`
- Add `'waiting'` to the `statusOrder` array in `getStatusGroups()`: `['running', 'waiting', 'pending', ...]`
- Add `'waiting'` to the `statuses` quick pick list in the `filterByStatus` command
- Ensure `handleSSEEvent` correctly processes `queue:updated` events with `status === 'waiting'`

### T009 [DONE] [US4] Add waiting count to dashboard QueueStats and webview
**Files**:
- `packages/generacy-extension/src/views/cloud/orchestrator/webview.ts`
- `packages/generacy-extension/src/views/cloud/orchestrator/panel.ts`
- `packages/generacy-extension/src/views/cloud/orchestrator/sidebar-view.ts`
- Add `waiting: number` to `QueueStats` interface in `webview.ts`
- In `getQueueSummarySection()`: change stats grid from 4 to 5 columns, add "Waiting" card with `stat-waiting` class, style with `border-left-color: var(--vscode-charts-orange)`
- In `getPriorityBar()`: add `waiting` segment
- In `getDashboardStyles()`: add `.stat-waiting` and `.bar-waiting` CSS rules
- In `panel.ts` `computeQueueStats()`: add `case 'waiting': stats.waiting++; break;`
- In `sidebar-view.ts` `computeQueueStats()`: add `case 'waiting': stats.waiting++; break;`
- In `getSidebarQueueSummary()`: add waiting count to sidebar summary parts

### T010 [DONE] [US7] Add waiting notification to JobNotificationService
**File**: `packages/generacy-extension/src/services/job-notification-service.ts`
- Extend `TerminalStatus` type to include `'waiting'`: `type NotifiableStatus = 'completed' | 'failed' | 'cancelled' | 'waiting'`
- In `handleQueueEvent()`: add `status === 'waiting'` to the status check (it's not terminal, so handle separately)
- Show `vscode.window.showWarningMessage` for waiting events: `"Job X is waiting for: {waitingFor}"`
- Add "View Job" action button that opens job detail panel
- Add deduplication for waiting events (same pattern as terminal events)
- Respect `generacy.notifications.enabled` setting

### T011 [DONE] [P] [US4] Update existing tests for waiting status
**Files**:
- `packages/generacy-extension/src/views/cloud/queue/__tests__/tree-item.test.ts`
- `packages/generacy-extension/src/views/cloud/queue/__tests__/provider.test.ts`
- `packages/generacy-extension/src/services/__tests__/job-notification-service.test.ts`
- Add test cases for `waiting` status tree item rendering (icon, description, tooltip)
- Add test cases for `waiting` status in tree provider grouping
- Add test cases for waiting notification delivery and deduplication

---

## Phase 3: User Profile & Org Resolution (US2)

### T012 [DONE] [US2] Create user profile API endpoint
**File**: `packages/generacy-extension/src/api/endpoints/user.ts` (NEW)
- Define `UserOrg` interface: `{ id: string; name: string; role: 'owner' | 'admin' | 'member' }`
- Define `UserProfile` interface: `{ id, username, displayName, email, avatarUrl?, tier, organizations: UserOrg[] }`
- Define `UserProfileSchema` and `UserOrgSchema` using Zod
- Implement `getUserProfile()` function calling `GET /users/me` via `ApiClient`
- Export as `userApi` object with `getProfile` method (consistent with other endpoint modules)

### T013 [DONE] [US2] Extend User type with organizations
**File**: `packages/generacy-extension/src/api/types.ts`
- Add `UserOrg` interface and `UserOrgSchema` to types (or re-export from user endpoint)
- Add `organizations?: UserOrg[]` to existing `User` interface
- Add `organizations: z.array(UserOrgSchema).optional()` to `UserSchema`

### T014 [DONE] [US2] Fetch user profile after OAuth token exchange
**File**: `packages/generacy-extension/src/api/auth.ts`
- After successful `exchangeCodeForTokens()`, call `userApi.getProfile()` to get org memberships
- Store `organizationId` from first org (or org matching project config's project.id) in auth state
- Expose `getOrganizationId(): string | undefined` getter on `AuthService`
- Update `AuthUser` type to include `organizationId?: string` and `organizations?: UserOrg[]`
- On session restore, re-fetch profile if tokens are valid but org data is missing

---

## Phase 4: SSE Endpoint & Project Scoping (US4, US7)

### T015 [DONE] [US4] Update SSE connection to org-scoped endpoint
**File**: `packages/generacy-extension/src/api/sse.ts`
- Update `connect()` signature to accept optional `orgId` parameter
- Change URL construction in `openConnection()`:
  - From: `${this.baseUrl}/events?channels=${channelsParam}`
  - To: `${this.baseUrl}/api/orgs/${orgId}/orchestrator/events?channels=${channelsParam}` (when orgId provided)
  - Fall back to current path when no orgId (local orchestrator mode)
- Store `orgId` for reconnection

### T016 [DONE] [US4] Pass orgId from auth to SSE connection
**File**: `packages/generacy-extension/src/commands/cloud.ts`
- After auth state changes to authenticated, retrieve `orgId` from `AuthService.getOrganizationId()`
- Pass `orgId` to `sseManager.connect(baseUrl, token, orgId)`
- On auth state change to unauthenticated, call `sseManager.disconnect()`

### T017 [DONE] [US7] Add project-scoped notification filtering
**File**: `packages/generacy-extension/src/services/job-notification-service.ts`
- Accept `ProjectConfigService` in constructor (new parameter)
- In `handleQueueEvent()`, after building `queueItem`: check if `queueItem.repository` matches `projectConfig.reposPrimary` or `projectConfig.projectName`
- If project config exists but job doesn't match project, skip notification (status bar flash only)
- If no project config exists, show all notifications (fallback)

### T018 [DONE] [P] [US4] Add project-scoped default filter to queue tree view
**File**: `packages/generacy-extension/src/views/cloud/queue/provider.ts`
- Accept optional `ProjectConfigService` in constructor options
- When project config is detected, default filter shows items matching current project's repository
- Add "Show All Org Jobs" / "Show Project Jobs" toggle command
- Update filter logic in `fetchQueue()` to apply project filter when active

---

## Phase 5: Dashboard Polish & Waiting-for-Input UX (US4, US5)

### T019 [DONE] [US4] Add waiting-for-input jobs list to dashboard webview
**File**: `packages/generacy-extension/src/views/cloud/orchestrator/webview.ts`
- Rename "Pending" stat card label to "Active" (maps to `running` count per spec)
- Add new `getWaitingJobsSection()` function rendering a list of waiting jobs:
  - Each item shows: workflow name, `waitingFor` label, time waiting, "View" link
  - Styled with warning/orange accent color
- Add the section below the stats grid in `getQueueSummarySection()`
- Accept `waitingItems: QueueItem[]` in `DashboardData` for rendering the list
- Add CSS for `.waiting-jobs-list` section

### T020 [DONE] [P] [US5] Verify and add label badges to job detail view
**Files**:
- `packages/generacy-extension/src/views/cloud/queue/detail-html.ts`
- `packages/generacy-extension/src/api/types.ts`
- Add `labels?: string[]` field to `QueueItem` interface and `QueueItemSchema` (if not present)
- In `detail-html.ts`, add a labels section rendering each label as a styled badge
- Style with `display: inline-flex`, rounded corners, theme colors
- Position below status/priority badges area

### T021 [DONE] [US4] Pass waiting items data to dashboard panel
**File**: `packages/generacy-extension/src/views/cloud/orchestrator/panel.ts`
- When loading data, filter queue items with `status === 'waiting'` into separate array
- Pass waiting items to webview via `DashboardData`
- Ensure waiting items are included in dashboard update messages

---

## Phase 6: Live Log Streaming Validation (US6)

### T022 [DONE] [US6] Verify log streaming context menu action
**Files**:
- `packages/generacy-extension/src/views/cloud/queue/tree-item.ts`
- `packages/generacy-extension/package.json`
- Verify `contextValue` on `QueueTreeItem` includes status suffix enabling "View Logs" menu
- Check `package.json` `menus.view/item/context` has `generacy.queue.viewLogs` command bound to queue items with `when` clause: `viewItem =~ /queueItem-(running|completed|failed)/`
- Verify "View Logs" command is registered and works for both running and completed jobs
- If any binding is missing, add it

### T023 [DONE] [P] [US6] Verify SSE reconnection with Last-Event-ID
**File**: `packages/generacy-extension/src/views/cloud/log-viewer/log-channel.ts`
- Verify that `Last-Event-ID` header is sent on SSE reconnection for log streams
- Verify connection status indicator is displayed to user (connection/reconnection/disconnection states)
- Verify auto-scroll behavior in output channel
- If any gaps found, fix them

---

## Phase 7: Notifications Verification (US7)

### T024 [DONE] [US7] Verify notification settings and delivery
**Files**:
- `packages/generacy-extension/src/services/job-notification-service.ts`
- `packages/generacy-extension/package.json`
- Verify `generacy.notifications.enabled` setting controls all notifications
- Verify `generacy.notifications.onComplete` controls completion notifications
- Verify `generacy.notifications.onError` controls failure/cancellation notifications
- Verify "View Job" action on all notification types opens job detail panel
- Verify rate limiting works (3+ notifications in 10s → summary)
- Run existing notification tests: `src/services/__tests__/job-notification-service.test.ts`

### T025 [DONE] [P] [US7] Ensure notification sounds setting is reserved
**File**: `packages/generacy-extension/package.json`
- Verify `generacy.notifications.sound` setting exists in `contributes.configuration` (reserved for future)
- If missing, add it as a boolean with default `false` and description noting it's reserved

---

## Phase 8: Packaging & Build Verification (US1)

### T026 [US1] Verify build produces clean output
**Commands**:
- Run `pnpm build` in `packages/generacy-extension/` and verify `dist/extension.js` is produced
- Fix any TypeScript compilation errors from changes in Phases 1-7
- Ensure no unused imports or variables

### T027 [US1] Run all tests and fix failures
**Commands**:
- Run `pnpm test` in `packages/generacy-extension/`
- Fix any test failures caused by type changes (`waiting` status, new interfaces)
- Ensure test coverage for new code meets project standards

### T028 [P] [US1] Verify .vscodeignore excludes test and source files
**File**: `packages/generacy-extension/.vscodeignore`
- Verify exclusions: `src/`, `**/__tests__/`, `**/*.test.ts`, `tsconfig.json`, `*.map` (in production)
- Verify inclusions: `dist/`, `resources/`, `schemas/`, `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json`
- Add missing exclusions if needed

### T029 [P] [US1] Verify package.json metadata for marketplace
**File**: `packages/generacy-extension/package.json`
- Verify `publisher: generacy-ai` is set
- Verify `icon` path points to a valid file
- Verify `categories`, `keywords`, `engines.vscode` are set correctly
- Verify `repository` and `homepage` URLs are correct
- Verify `activationEvents` includes both `.yaml` and `.yml` patterns

### T030 [US1] Package extension as .vsix
**Commands**:
- Run `npx @vscode/vsce package` in `packages/generacy-extension/`
- Verify `.vsix` file is produced without errors
- Verify `.vsix` size is reasonable (< 5MB typically)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001-T005) must complete before Phase 4 (T015-T018) — ProjectConfigService needed
- Phase 2 (T006-T011) must complete before Phase 5 (T019-T021) — `waiting` type needed
- Phase 3 (T012-T014) must complete before Phase 4 (T015-T018) — orgId needed for SSE
- Phases 1-7 must complete before Phase 8 (T026-T030) — build/test validation

**Parallel opportunities within phases**:
- Phase 1: T002 sequential first, then T003/T005 parallel, then T004 (depends on T002)
- Phase 2: T006 first (type change), then T007/T008/T011 parallel, then T009/T010 (depend on T006)
- Phase 3: T012/T013 parallel, then T014 (depends on both)
- Phase 4: T015 first, then T016/T017/T018 parallel
- Phase 5: T019/T020 parallel, then T021 (depends on T019)
- Phase 6: T022/T023 fully parallel
- Phase 7: T024/T025 fully parallel
- Phase 8: T026 first, T027 second, T028/T029 parallel, T030 last

**Cross-phase parallelism**:
- Phase 1 and Phase 2 can run in parallel (no dependencies between them)
- Phase 3 can start as soon as T006 (type change) from Phase 2 is done
- Phase 6 and Phase 7 can run in parallel with Phase 5

**Critical path**:
T001 → T002 → T004 → T006 → T012/T013 → T014 → T015 → T016 → T026 → T027 → T030

---

## Summary

| Phase | Tasks | New Files | Modified Files | Est. Lines |
|-------|-------|-----------|----------------|------------|
| 1. Project Config | T001-T005 | 2 | 3 | ~400 |
| 2. Waiting Status | T006-T011 | 0 | 6 | ~200 |
| 3. User Profile | T012-T014 | 1 | 2 | ~160 |
| 4. SSE & Scoping | T015-T018 | 0 | 4 | ~120 |
| 5. Dashboard Polish | T019-T021 | 0 | 3 | ~150 |
| 6. Log Validation | T022-T023 | 0 | 2 | ~30 |
| 7. Notifications | T024-T025 | 0 | 2 | ~20 |
| 8. Build & Package | T026-T030 | 0 | 1 | ~10 |
| **Total** | **30 tasks** | **3 new** | **~15 modified** | **~1,090** |
