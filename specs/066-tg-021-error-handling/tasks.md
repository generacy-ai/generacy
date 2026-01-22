# Tasks: Error Handling & UX Polish

**Input**: Design documents from `/specs/066-tg-021-error-handling/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- Tasks are organized by priority and logical grouping

---

## Phase 1: Enhanced Error Messages (P1)

### T001 ✓ Audit and enhance error code messages
**Files**: `packages/generacy-extension/src/utils/errors.ts`
**Priority**: P1
**Status**: Complete

Enhance the ERROR_MESSAGES dictionary with actionable messages following the What-Why-How pattern:
- ✓ Review all ErrorCode enum entries (20 codes found)
- ✓ Replace terse messages with detailed, actionable descriptions
- ✓ Each message explains: what happened, why it might have occurred, what to do next
- ✓ Added contextual help references where applicable
- ✓ Ensured messages are user-friendly and non-technical

**Acceptance**: All error codes have messages following What-Why-How pattern with clear next steps

---

### T002 [P] Add error recovery actions infrastructure
**Files**: `packages/generacy-extension/src/utils/errors.ts`
**Priority**: P1

Extend the error handling system to support recovery actions:
- Add `actions` parameter to `showError()` and `showWarning()` functions
- Implement action button rendering in error dialogs
- Add support for primary action indication
- Create helper functions for common actions (retry, show logs, open settings)
- Add telemetry for action usage (opt-in)

**Acceptance**: Error dialogs can display actionable buttons that execute recovery functions

---

### T003 [P] Create error message templates
**Files**: `packages/generacy-extension/src/utils/error-templates.ts` (new)
**Priority**: P1

Create reusable error message templates for common scenarios:
- Configuration errors (missing/invalid config)
- File system errors (not found, permission denied)
- Network errors (offline, timeout, rate limited)
- Authentication errors (required, expired, failed)
- Validation errors (workflow, schema)
- Each template should include default actions

**Acceptance**: Template library exists with 10+ common error scenarios

---

### T004 Apply enhanced error messages to Explorer module
**Files**: `packages/generacy-extension/src/views/local/explorer/provider.ts`, `packages/generacy-extension/src/views/local/explorer/tree-item.ts`
**Priority**: P1

Replace generic error throws with enhanced error messages:
- File not found errors → Include file path, suggest refresh/browse
- Permission errors → Explain permissions, suggest solutions
- Validation errors → Show specific validation failure, link to schema
- Add recovery actions: Refresh, Show Logs, Get Help

**Acceptance**: Explorer errors are actionable with clear next steps

---

### T005 Apply enhanced error messages to Runner module
**Files**: `packages/generacy-extension/src/views/local/runner/executor.ts`, `packages/generacy-extension/src/views/local/runner/terminal.ts`
**Priority**: P1

Replace generic error throws with enhanced error messages:
- Execution failures → Show which phase/step failed, why, suggest debug mode
- Environment errors → Explain missing variables, show how to configure
- Process errors → Explain exit codes, show output channel
- Add recovery actions: Retry, Debug, View Output

**Acceptance**: Runner errors explain failures and offer debug/retry options

---

### T006 Apply enhanced error messages to Debugger module
**Files**: `packages/generacy-extension/src/views/local/debugger/adapter.ts`, `packages/generacy-extension/src/debug/runtime.ts`
**Priority**: P1

Replace generic error throws with enhanced error messages:
- Breakpoint errors → Explain why breakpoint failed, suggest alternatives
- State inspection errors → Explain unavailable state, suggest when to inspect
- Session errors → Explain connection issues, suggest restart
- Add recovery actions: Restart Session, Clear Breakpoints, View Logs

**Acceptance**: Debugger errors guide users through debugging issues

---

### T007 Apply enhanced error messages to API/Cloud modules
**Files**: `packages/generacy-extension/src/api/client.ts`, `packages/generacy-extension/src/views/cloud/*/provider.ts`
**Priority**: P1

Replace generic error throws with enhanced error messages:
- Connection errors → Check internet, link to status page
- Authentication errors → Explain token state, suggest re-login
- API errors → Show error details from server, suggest retry
- Rate limit errors → Explain limits, show retry-after time
- Add recovery actions: Retry, Login, Check Status, Work Offline

**Acceptance**: API/cloud errors explain failures and offer offline mode

---

## Phase 2: Offline Mode Handling (P1)

### T008 ✓ Create network detection utility
**Files**: `packages/generacy-extension/src/utils/network.ts` (new)
**Priority**: P1
**Status**: Complete

Implement network connectivity detection:
- ✓ Use `navigator.onLine` for instant detection
- ✓ Implement API health check with `/health` endpoint
- ✓ Add network state change event emitter
- ✓ Track last online timestamp
- ✓ Add connectivity test with timeout (5s)
- ✓ Periodic health checks with interval

**Acceptance**: Network state accurately reflects connectivity and emits change events

---

### T009 ✓ [P] Implement request retry logic
**Files**: `packages/generacy-extension/src/utils/retry.ts` (new)
**Priority**: P1
**Status**: Complete

Create retry utilities with exponential backoff:
- ✓ Implement `withRetry()` wrapper function
- ✓ Support exponential backoff with jitter (1s, 2s, 4s, 8s, 16s, max 30s)
- ✓ Add configurable max attempts (default: 5)
- ✓ Add retry predicate to determine if error is retryable
- ✓ Track retry statistics for telemetry
- ✓ Provide preset configs for different scenarios (API, file system, validation)

**Acceptance**: Retry logic handles transient failures with appropriate backoff

---

### T010 ✓ Implement local cache layer
**Files**: `packages/generacy-extension/src/api/cache.ts` (new)
**Priority**: P1
**Status**: Complete

Create local caching for offline mode using VS Code Memento API:
- ✓ Implement `CachedData<T>` wrapper with TTL
- ✓ Add `getFromCache()` and `setCache()` functions
- ✓ Implement cache validation (check age vs TTL)
- ✓ Add cache eviction on expiry
- ✓ Support different TTLs per data type (org: 1h, queue: 5m, integrations: 15m)
- ✓ Add cache statistics (hit rate, size, expired entries)
- ✓ Implement CacheManager class with global state integration

**Acceptance**: Cache stores API responses with TTL and serves stale data when offline

---

### T011 Add offline-aware API client
**Files**: `packages/generacy-extension/src/api/client.ts`
**Priority**: P1

Enhance API client with offline mode support:
- Check network state before requests
- Fall back to cache when offline
- Queue write operations for later sync
- Add retry logic with exponential backoff
- Show cache staleness indicators
- Auto-retry when connection restored

**Acceptance**: API client gracefully handles offline state, uses cache, queues writes

---

### T012 Add offline mode UI to Dashboard
**Files**: `packages/generacy-extension/src/views/cloud/dashboard/webview.ts`, `packages/generacy-extension/src/views/cloud/dashboard/panel.ts`
**Priority**: P1

Add offline mode indicators and messaging:
- Show "Offline" badge in dashboard header
- Display cached data timestamp
- Disable write operations (buttons grayed out)
- Show "Last synced: X minutes ago"
- Add "Retry Connection" button

**Acceptance**: Dashboard shows offline state clearly and disables unavailable features

---

### T013 [P] Add offline mode UI to Queue view
**Files**: `packages/generacy-extension/src/views/cloud/queue/provider.ts`, `packages/generacy-extension/src/views/cloud/queue/tree-item.ts`
**Priority**: P1

Add offline mode indicators and behavior:
- Show cached queue with staleness indicator
- Disable queue actions (cancel, retry, priority)
- Show "Cached data" tree item at top
- Auto-refresh when connection restored
- Show last refresh timestamp

**Acceptance**: Queue view shows cached data with clear offline indicators

---

### T014 [P] Add offline mode UI to Integrations view
**Files**: `packages/generacy-extension/src/views/cloud/integrations/provider.ts`, `packages/generacy-extension/src/views/cloud/integrations/tree-item.ts`
**Priority**: P1

Add offline mode indicators and behavior:
- Show "Cannot verify connection status (offline)"
- Use cached integration status
- Disable connection actions
- Show last check timestamp
- Auto-verify when connection restored

**Acceptance**: Integrations view handles offline state gracefully

---

### T015 Add network status bar indicator
**Files**: `packages/generacy-extension/src/ui/progress/status.ts` (new), `packages/generacy-extension/src/extension.ts`
**Priority**: P1

Create status bar item showing network state:
- Show "$(cloud) Online" when connected
- Show "$(cloud-offline) Offline" when disconnected
- Add tooltip with last sync time
- Clicking opens network troubleshooting
- Register in extension activation

**Acceptance**: Status bar shows real-time network state

---

## Phase 3: Welcome Walkthrough (P2)

### T016 Create walkthrough content
**Files**: `packages/generacy-extension/src/ui/welcome/content.md` (new), `packages/generacy-extension/resources/walkthrough/*.png` (new)
**Priority**: P2

Design and write walkthrough content:
- Step 1: Introduction to Generacy (overview, key features)
- Step 2: Create your first workflow (command to create)
- Step 3: Run a workflow locally (command to run)
- Step 4: Debug a workflow (set breakpoint, step through)
- Step 5: Connect to cloud (optional, if authenticated)
- Create screenshots/diagrams for each step
- Write clear, concise descriptions

**Acceptance**: Walkthrough content covers key features with 5 interactive steps

---

### T017 Implement walkthrough provider
**Files**: `packages/generacy-extension/src/ui/welcome/walkthrough.ts` (new), `packages/generacy-extension/package.json`
**Priority**: P2

Implement VS Code Walkthrough API integration:
- Define walkthrough contribution in package.json
- Set walkthrough ID: "generacy.welcome"
- Configure steps with markdown content
- Set completion events for interactive steps
- Add media references (images, videos)
- Track walkthrough progress in global state

**Acceptance**: Walkthrough appears in VS Code's Get Started view

---

### T018 Add first-run detection and auto-show
**Files**: `packages/generacy-extension/src/extension.ts`
**Priority**: P2

Show walkthrough automatically on first activation:
- Check global state for `hasSeenWalkthrough` flag
- On first run, show walkthrough via command
- Set flag after showing
- Add "Help: Show Walkthrough" command for returning users
- Add to Command Palette

**Acceptance**: Walkthrough shows automatically on first activation, can be reopened later

---

## Phase 4: Keyboard Shortcuts (P2)

### T019 Define keyboard shortcut configuration
**Files**: `packages/generacy-extension/package.json`
**Priority**: P2

Add keybindings contribution to package.json:
- `Cmd/Ctrl+Shift+R`: Run current workflow (when: `editorLangId == yaml`)
- `Cmd/Ctrl+Shift+D`: Debug current workflow (when: `editorLangId == yaml`)
- `Cmd/Ctrl+Shift+V`: Validate current workflow (when: `editorLangId == yaml`)
- `Cmd/Ctrl+Shift+P`: Publish to cloud (when: `generacy.isAuthenticated`)
- Standard debug shortcuts (F5, F10, F11) inherit from VS Code

**Acceptance**: All shortcuts defined in package.json with proper context

---

### T020 Implement keyboard shortcut handlers
**Files**: `packages/generacy-extension/src/commands/shortcuts.ts` (new), `packages/generacy-extension/src/commands/index.ts`
**Priority**: P2

Create command handlers for keyboard shortcuts:
- `generacy.shortcuts.runWorkflow`: Detect active workflow, run it
- `generacy.shortcuts.debugWorkflow`: Detect active workflow, debug it
- `generacy.shortcuts.validateWorkflow`: Validate active workflow
- `generacy.shortcuts.publishWorkflow`: Publish active workflow to cloud
- Add context detection (which workflow is active)
- Show error if no workflow context

**Acceptance**: Keyboard shortcuts execute appropriate commands based on context

---

### T021 [P] Add keyboard shortcuts documentation
**Files**: `packages/generacy-extension/README.md`
**Priority**: P2

Document keyboard shortcuts in README:
- Add "Keyboard Shortcuts" section
- List all shortcuts with descriptions
- Explain context-awareness (when shortcuts are active)
- Note that shortcuts can be customized in VS Code settings

**Acceptance**: README has complete keyboard shortcuts reference

---

## Phase 5: Loading States & Progress Indicators (P1)

### T022 ✓ Create progress indicator utilities
**Files**: `packages/generacy-extension/src/ui/progress/indicators.ts` (new)
**Priority**: P1
**Status**: Complete

Build progress indication utilities:
- ✓ `withProgress()`: Wrapper for operations with progress reporting
- ✓ `showStatusBarProgress()`: Quick status bar updates
- ✓ `showNotificationProgress()`: Progress notifications with cancel support
- ✓ Implement time-based thresholds (100ms, 2s, 10s)
- ✓ Support percentage and message updates
- ✓ Support cancellation tokens
- ✓ `MultiStepProgress` class for multi-step operations
- ✓ `withAutomaticProgress()` with intelligent threshold detection

**Acceptance**: Utilities make it easy to show appropriate progress based on operation duration

---

### T023 Add loading states to Explorer tree view
**Files**: `packages/generacy-extension/src/views/local/explorer/provider.ts`, `packages/generacy-extension/src/views/local/explorer/tree-item.ts`
**Priority**: P1

Show loading feedback in Explorer:
- Show "$(sync~spin) Loading workflows..." while scanning
- Show skeleton tree items during load
- Handle empty state: "No workflows found. Create one to get started."
- Handle error state: "Failed to load workflows. Click to retry."
- Show refresh progress in status bar

**Acceptance**: Explorer shows clear loading states, never appears frozen

---

### T024 [P] Add loading states to Queue tree view
**Files**: `packages/generacy-extension/src/views/cloud/queue/provider.ts`, `packages/generacy-extension/src/views/cloud/queue/tree-item.ts`
**Priority**: P1

Show loading feedback in Queue view:
- Show "$(sync~spin) Fetching queue..." while loading
- Show cached data immediately if available
- Handle empty state: "Queue is empty"
- Handle error state with retry button
- Show polling indicator (subtle spinner)

**Acceptance**: Queue view shows loading state, uses cached data for instant feedback

---

### T025 [P] Add loading states to Integrations tree view
**Files**: `packages/generacy-extension/src/views/cloud/integrations/provider.ts`, `packages/generacy-extension/src/views/cloud/integrations/tree-item.ts`
**Priority**: P1

Show loading feedback in Integrations view:
- Show "$(sync~spin) Checking connection status..." while verifying
- Show last check timestamp for each integration
- Handle error state with "Retry" action
- Cache status to show immediately on reopen

**Acceptance**: Integrations view shows loading and last-check states

---

### T026 Add execution progress to Workflow Runner
**Files**: `packages/generacy-extension/src/views/local/runner/executor.ts`
**Priority**: P1

Show detailed progress during workflow execution:
- Display progress notification with workflow name
- Report per-phase progress (e.g., "Phase 2 of 5: build")
- Show percentage based on phases completed
- Update status bar with current phase
- Support cancellation (kill process, clean up)
- Show execution time on completion

**Acceptance**: Workflow execution shows clear progress with phase updates and cancellation

---

### T027 [P] Add progress to publish operation
**Files**: `packages/generacy-extension/src/views/cloud/publish/sync.ts`
**Priority**: P1

Show progress during workflow publishing:
- Display "Publishing workflow..." notification
- Show steps: Validating → Uploading → Syncing → Done
- Report percentage for each step
- Show file upload progress if large
- Handle errors with retry option
- Show success notification with version number

**Acceptance**: Publishing shows multi-step progress, handles large uploads

---

### T028 Create status bar manager
**Files**: `packages/generacy-extension/src/ui/progress/status.ts` (enhance)
**Priority**: P1

Build centralized status bar management:
- Manage status bar text with priorities (high-priority overwrites)
- Auto-clear temporary status after timeout
- Show permanent indicators: network status, sync status
- Show temporary indicators: current operation
- Support spinning icons for active operations
- Clicking status bar shows relevant panel/output

**Acceptance**: Status bar cleanly handles multiple simultaneous status updates

---

## Phase 6: Integration & Testing (P1)

### T029 Write error handling tests
**Files**: `packages/generacy-extension/src/utils/__tests__/errors.test.ts`
**Priority**: P1

Create comprehensive error handling tests:
- Test all enhanced error messages are actionable
- Test error recovery actions execute correctly
- Test error wrapping and context propagation
- Test error display with actions
- Mock VS Code window API for dialog testing

**Acceptance**: 90%+ code coverage for error utilities

---

### T030 [P] Write offline mode tests
**Files**: `packages/generacy-extension/src/utils/__tests__/network.test.ts`, `packages/generacy-extension/src/api/__tests__/cache.test.ts`
**Priority**: P1

Test offline mode functionality:
- Test network detection logic
- Test cache get/set/eviction
- Test retry logic with exponential backoff
- Mock navigator.onLine and fetch
- Test offline queue behavior

**Acceptance**: Offline mode works reliably with proper cache fallback

---

### T031 [P] Write progress indicator tests
**Files**: `packages/generacy-extension/src/ui/progress/__tests__/indicators.test.ts`
**Priority**: P1

Test progress indication:
- Test time-based threshold logic
- Test progress reporting and updates
- Test cancellation support
- Mock VS Code progress API

**Acceptance**: Progress indicators show for appropriate operation durations

---

### T032 Manual testing: Error scenarios
**Priority**: P1

Manually test common error scenarios:
- Invalid workflow file → Shows validation error with file/line
- Network offline → Shows offline mode, uses cache
- Authentication expired → Shows re-login prompt
- File not found → Shows browse/refresh actions
- Rate limit → Shows retry-after message

**Acceptance**: All common error scenarios show helpful, actionable messages

---

### T033 [P] Manual testing: Walkthrough flow
**Priority**: P2

Test walkthrough user experience:
- Fresh install → Walkthrough shows automatically
- Complete all steps → Progress tracked correctly
- Reopen via command → Works correctly
- Screenshots/media load properly

**Acceptance**: Walkthrough provides smooth first-run experience

---

### T034 [P] Manual testing: Keyboard shortcuts
**Priority**: P2

Test all keyboard shortcuts:
- Run workflow: `Cmd/Ctrl+Shift+R` → Runs current workflow
- Debug workflow: `Cmd/Ctrl+Shift+D` → Starts debugger
- Validate: `Cmd/Ctrl+Shift+V` → Shows validation results
- Publish: `Cmd/Ctrl+Shift+P` → Publishes to cloud (if authenticated)
- No conflicts with VS Code defaults

**Acceptance**: All shortcuts work in appropriate contexts without conflicts

---

## Dependencies & Execution Order

**Phase Boundaries** (Sequential):
- Phase 1 (Error Messages) must complete before Phase 6 (Testing can validate them)
- Phase 2 (Offline Mode) can partially overlap with Phase 1
- Phase 3 (Walkthrough) and Phase 4 (Shortcuts) are independent, can run anytime
- Phase 5 (Progress Indicators) should complete before Phase 6 (Testing)

**Parallel Opportunities**:

Within Phase 1:
- T002 (actions infrastructure) can run parallel with T003 (templates)
- T004-T007 (apply to modules) are independent, can run in parallel after T001-T003

Within Phase 2:
- T009 (retry logic) can run parallel with T008 (network detection)
- T012-T014 (offline UI) can run in parallel after T010-T011 complete

Within Phase 5:
- T024-T025 (tree view loading) can run in parallel after T023
- T027 (publish progress) can run parallel with T026 (runner progress)

Within Phase 6:
- T030-T031 (unit tests) can run in parallel
- T033-T034 (manual tests) can run in parallel

**Critical Path**:
T001 → T002 → T004-T007 → T029 (error handling)
T008 → T010 → T011 → T012-T014 → T030 (offline mode)
T022 → T023 → T026 → T031 (progress indicators)

**Estimated Effort**: 34 tasks, 4-5 hours scope (per issue metadata), ~8-10 minutes per task average

---

*Generated by speckit*
