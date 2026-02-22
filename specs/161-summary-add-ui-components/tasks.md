# Tasks: Agent Orchestration UI Components

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
  - **[Dashboard]**: Orchestration dashboard views
  - **[Agents]**: Agent monitoring tree view
  - **[Queue]**: Enhanced queue management
  - **[Infra]**: Shared infrastructure (SSE, types, config)

---

## Phase 1: Foundation — Types, API Endpoints & SSE Client

Builds the shared infrastructure all subsequent phases depend on.

### T001 [Infra] Add Agent, Activity & Stats types and Zod schemas
**File**: `packages/generacy-extension/src/api/types.ts`
- Add `AgentConnectionStatus` type (`'connected' | 'idle' | 'busy' | 'disconnected'`)
- Add `AgentType` type (`'claude' | 'gpt4' | 'custom'`)
- Add `AgentDisplayStatus` type (`'available' | 'busy' | 'offline'`)
- Add `Agent` interface with id, name, type, status, capabilities, lastSeen, metadata
- Add `AgentSchema` Zod schema matching `Agent` interface
- Add `AgentListResponse` and `AgentListResponseSchema` (paginated, following `QueueListResponseSchema` pattern)
- Add `AgentStats` interface (total, available, busy, offline) and `AgentStatsSchema`
- Add `ActivityEventType` union type (workflow:started/completed/failed/cancelled, agent:connected/disconnected, queue:item:added/removed)
- Add `ActivityEvent` interface (id, type, message, timestamp, metadata) and `ActivityEventSchema`
- Add `ActivityListResponse` and `ActivityListResponseSchema`
- Add `AgentLogLine` and `AgentLogsResponse` types with Zod schemas
- Add `SSEEvent` interface (id, event, channel, data, timestamp) and `SSEEventSchema`

### T002 [Infra] Add constants for new views, commands, context keys
**File**: `packages/generacy-extension/src/constants.ts`
- Add to `VIEWS`: `agents: 'generacy.agents'`, `orchestratorSummary: 'generacy.orchestratorSummary'`
- Add to `COMMANDS` (or `CLOUD_COMMANDS`): `openDashboard`, `refreshAgents`, `viewAgentLogs`, `viewAgentsByStatus`, `viewAgentsFlat`, `assignWorkItem`, `setPriority`, `pinDetail`
- Add to `CONTEXT_KEYS`: `orchestratorConnected: 'generacy.orchestratorConnected'`
- Add to `TREE_ITEM_CONTEXT`: `agent: 'agent'`, `agentGroup: 'agentGroup'`

### T003 [P] [Infra] Create agents API endpoint module
**File**: `packages/generacy-extension/src/api/endpoints/agents.ts`
- Follow `queueApi` object pattern from `endpoints/queue.ts`
- Implement `getAgents(filters?)` → `GET /agents` with pagination and status filter
- Implement `getAgent(id)` → `GET /agents/:id`
- Implement `getAgentStats()` → `GET /agents/stats`
- Implement `getAgentLogs(id, params?)` → `GET /agents/:id/logs` with limit/offset params
- Implement `assignWorkItem(queueItemId, agentId)` → `POST /queue/:id/assign`
- Use `getApiClient()` singleton and `getValidated`/`postValidated` with Zod schemas
- Export `agentsApi` object and `getAgentsApi()` helper function

### T004 [P] [Infra] Create activity API endpoint module
**File**: `packages/generacy-extension/src/api/endpoints/activity.ts`
- Follow `queueApi` object pattern
- Implement `getActivity(params?)` → `GET /activity` with limit (default 50), offset, type filter
- Use `ActivityListResponseSchema` for validation
- Export `activityApi` object and `getActivityApi()` helper function

### T005 [Infra] Create SSE Subscription Manager
**File**: `packages/generacy-extension/src/api/sse.ts`
- Implement `SSESubscriptionManager` class implementing `vscode.Disposable`
- Singleton pattern with `static getInstance()` and private constructor
- Define `SSEChannel` type (`'workflows' | 'queue' | 'agents'`)
- Define `SSEEventHandler` callback type
- Implement `connect(baseUrl, authToken)` — opens EventSource to `{baseUrl}/events?channels=workflows,queue,agents`
- Implement `disconnect()` — closes EventSource, clears subscribers
- Implement `subscribe(channel, handler)` → returns `vscode.Disposable` for cleanup
- Channel-based event routing: parse incoming SSE events, dispatch to matching channel subscribers
- Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s) on connection loss
- Track `lastEventId` and send `Last-Event-ID` header on reconnect for replay
- Track `connectionState` ('disconnected' | 'connecting' | 'connected' | 'error')
- Expose `isConnected()` and `getConnectionState()` methods
- Fire `onDidChangeConnectionState` event for views to react
- Handle Node.js `http` fallback if `EventSource` not available in environment
- Proper cleanup of all timers and connections in `dispose()`

---

## Phase 2: Agent Tree View

### T006 [Agents] Create agent tree item classes
**File**: `packages/generacy-extension/src/views/cloud/agents/tree-item.ts`
- Create `AgentTreeItem` extending `vscode.TreeItem`
  - Constructor takes `Agent`, sets label to agent name
  - Set `contextValue` to `'agent-{displayStatus}'` for conditional menus
  - Map status to icon: available → `$(check)` green, busy → `$(sync~spin)` blue, offline → `$(circle-slash)` gray
  - Set description to agent type + current assignment if busy
  - Set tooltip with full agent details (name, type, status, capabilities, lastSeen)
  - Set unique `id` to agent ID
- Create `AgentGroupItem` extending `vscode.TreeItem`
  - Constructor takes display status label + count (e.g., "Available (3)")
  - Set `contextValue` to `'agentGroup'`
  - Collapsible state: `Expanded` for available/busy, `Collapsed` for offline
- Create `AgentEmptyItem` — "No agents connected" with guided setup message
- Create `AgentLoadingItem` — "Loading agents..." with spin icon
- Create `AgentErrorItem` — "Failed to load agents" with error icon, stores error
- Define union type `AgentExplorerItem`
- Add `isAgentTreeItem()` type guard
- Implement `getDisplayStatus(status: AgentConnectionStatus): AgentDisplayStatus` helper

### T007 [Agents] Create agent tree data provider
**File**: `packages/generacy-extension/src/views/cloud/agents/provider.ts`
- Create `AgentTreeProvider` implementing `TreeDataProvider<AgentExplorerItem>` and `Disposable`
- Define `AgentViewMode` type (`'flat' | 'byStatus'`), default to `'byStatus'`
- Implement `getTreeItem(element)` — return element directly
- Implement `getChildren(element?)`:
  - Root level (byStatus mode): return `AgentGroupItem` nodes for each status with count
  - Root level (flat mode): return all `AgentTreeItem` nodes sorted by status then name
  - Under `AgentGroupItem`: return `AgentTreeItem` nodes filtered by that status
  - Handle loading/error/empty states
- Maintain in-memory `agents: Agent[]` array
- SSE subscription: subscribe to `'agents'` channel via `SSESubscriptionManager`
  - Handle `agent:connected` — add/update agent in list, refresh tree
  - Handle `agent:disconnected` — update agent status, refresh tree
  - Handle `agent:status` — update agent status/assignment, refresh tree
- Polling fallback: fetch `GET /agents` every 60s as integrity check, reconcile with SSE state
- Auth-reactive: start/stop polling and SSE based on `authService.onDidChange`
- Visibility-aware: pause polling when tree view not visible (`onDidChangeVisibility`)
- Implement `setViewMode(mode)` with tree data change event
- Implement `refresh()` that re-fetches from API
- Create factory function `createAgentTreeProvider(context)` that:
  - Instantiates provider
  - Creates tree view via `vscode.window.createTreeView(VIEWS.agents, ...)`
  - Registers refresh command
  - Registers view mode toggle commands
  - Pushes all disposables to `context.subscriptions`

### T008 [Agents] Create agent action commands
**File**: `packages/generacy-extension/src/views/cloud/agents/actions.ts`
- Implement `viewAgentLogs(agent)` — delegates to `AgentLogChannel` (Phase 5, stub for now)
- Implement `registerAgentActions(context, provider)`:
  - Register `generacy.agents.viewLogs` command
  - Register `generacy.agents.viewByStatus` command (sets provider view mode)
  - Register `generacy.agents.viewFlat` command (sets provider view mode)
  - Validate tree item selection before acting

### T009 [P] [Agents] Create barrel export for agents module
**File**: `packages/generacy-extension/src/views/cloud/agents/index.ts`
- Re-export provider, factory function, types from `provider.ts`
- Re-export tree item types and type guards from `tree-item.ts`
- Re-export action registration from `actions.ts`

---

## Phase 3: Orchestration Dashboard

### T010 [Dashboard] Create dashboard webview HTML template
**File**: `packages/generacy-extension/src/views/cloud/orchestrator/webview.ts`
- Implement `getDashboardHtml(webview, extensionUri, data)` template function
- Generate nonce for CSP
- Set Content-Security-Policy meta tag with nonce
- Use VS Code CSS variables (`--vscode-*`) for theming
- **Queue Summary section**: status counts (pending/running/completed/failed) as colored badges, priority distribution bar
- **Agent Summary section**: card per agent with status dot, name, type badge, current assignment, last seen relative time
- **Activity Feed section**: reverse-chronological list of last 50 events, each with icon, message, relative timestamp
- Empty state messages per section (per Q13): guided setup with contextual hints
- Click handlers: `postMessage` to extension for `openQueueItem`, `openAgent`, `refresh`
- JavaScript for incremental SSE event handling: listen for `sseEvent` messages, update counts and prepend activity items
- Auto-scroll activity feed on new items (only if scrolled to top)
- CSS Grid/Flexbox responsive layout
- Implement `getSidebarHtml(webview, extensionUri, data)` for compact sidebar variant
  - Connection status indicator (green/red dot)
  - Queue summary line: "5 pending, 2 running, 1 failed"
  - Agent summary line: "3 available, 2 busy, 0 offline"
  - "Open Dashboard" button

### T011 [Dashboard] Create sidebar summary WebviewViewProvider
**File**: `packages/generacy-extension/src/views/cloud/orchestrator/sidebar-view.ts`
- Create `OrchestratorSidebarViewProvider` implementing `vscode.WebviewViewProvider`
- Implement `resolveWebviewView(webviewView, context, token)`:
  - Configure webview options (enableScripts, localResourceRoots)
  - Set initial HTML with loading state
  - Listen for `'ready'` message from webview, then load data
- Data loading:
  - Fetch `GET /queue/stats` + `GET /agents/stats` on initial load
  - Subscribe to SSE (`queue` + `agents` channels) for real-time count updates
  - Post `connectionStatus` messages to webview when SSE state changes
- Handle webview messages:
  - `'ready'` → fetch and send initial data
  - `'refresh'` → re-fetch all data
  - `'openDashboard'` → execute `generacy.openDashboard` command
- Implement `Disposable` for SSE subscription cleanup
- Visibility-aware: only process SSE events when webview is visible

### T012 [Dashboard] Create dashboard editor panel
**File**: `packages/generacy-extension/src/views/cloud/orchestrator/panel.ts`
- Create `OrchestratorDashboardPanel` following `OrgDashboardPanel` singleton pattern
- Static `createOrShow(extensionUri)`:
  - If instance exists, reveal existing panel
  - Otherwise create new `WebviewPanel` with `retainContextWhenHidden: true`
- Constructor:
  - Set up webview content with loading HTML
  - Listen for messages from webview
  - Listen for disposal (clear singleton reference)
  - Listen for visibility changes (pause/resume SSE processing)
  - Set auto-refresh interval (60s) as polling fallback
- Data loading (hybrid REST + SSE per Q6):
  - Initial: parallel fetch `GET /queue/stats` + `GET /agents/stats` + `GET /activity?limit=50`
  - SSE: subscribe to all 3 channels, forward events to webview as `sseEvent` messages
  - Webview JavaScript handles incremental updates from SSE events
- Message handling:
  - `'ready'` → send initial data
  - `'refresh'` → re-fetch all data
  - `'openQueueItem'` → open work item detail panel
  - `'openAgent'` → reveal agent in tree view
  - `'openCommand'` → execute VS Code command
- Define `DashboardData` type (queueStats, agentStats, activity list, connectionStatus)
- Define message protocol types (DashboardWebviewMessage, DashboardExtensionMessage)

### T013 [P] [Dashboard] Create barrel export for orchestrator module
**File**: `packages/generacy-extension/src/views/cloud/orchestrator/index.ts`
- Re-export `OrchestratorSidebarViewProvider` from `sidebar-view.ts`
- Re-export `OrchestratorDashboardPanel`, `showOrchestratorDashboard` from `panel.ts`
- Re-export HTML template functions from `webview.ts`

---

## Phase 4: Enhanced Queue Actions & Work Item Detail

### T014 [Queue] Add SSE subscription to QueueTreeProvider
**File**: `packages/generacy-extension/src/views/cloud/queue/provider.ts`
- Import `SSESubscriptionManager` from `api/sse.ts`
- In constructor, subscribe to `'queue'` channel
- Handle `queue:item:added` — add item to local `queueItems` array, fire tree refresh
- Handle `queue:item:removed` — remove item from local array, fire tree refresh
- Handle `queue:updated` — find and update item in local array, fire tree refresh if status/priority changed
- Keep existing polling as secondary integrity check
- Add debouncing to tree refresh (coalesce rapid SSE events within 200ms)
- Push SSE subscription disposable to `this.disposables`

### T015 [Queue] Add assign and setPriority actions
**File**: `packages/generacy-extension/src/views/cloud/queue/actions.ts`
- Implement `assignWorkItem(item, provider)`:
  - Fetch available agents via `agentsApi.getAgents({ status: 'idle' })`
  - Show `vscode.window.showQuickPick` with agent name, type, and id
  - Call `agentsApi.assignWorkItem(queueItemId, agentId)` on selection
  - Refresh provider on success
  - Show error message on failure
- Implement `setPriority(item, provider)`:
  - Show quick pick with all 4 priority levels, mark current with "(current)"
  - Call `queueApi.updatePriority(itemId, newPriority)` on selection
  - Refresh provider on success
- Register both commands in `registerQueueActions()`:
  - `generacy.queue.assign` → `assignWorkItem`
  - `generacy.queue.setPriority` → `setPriority`

### T016 [Queue] Create WorkItemDetailPanel with singleton + pinning
**File**: `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts`
- Create `WorkItemDetailPanel` class
- Static `previewInstance` for singleton behavior
- `isPinned` flag per instance
- Static `showPreview(item, extensionUri)`:
  - If unpinned preview exists, reuse panel and update content
  - If no preview or existing is pinned, create new panel
- `pin()` method: sets `isPinned = true`, clears `previewInstance` so next selection opens new
- Webview content:
  - Status badge with color coding
  - Priority badge
  - Timeline section: queued → started → completed/failed timestamps
  - Error details section (collapsible, shown when status is failed)
  - Assigned agent info with link to agent in tree view
  - Full metadata display
- Pin button in panel title bar actions
- SSE subscription to `'queue'` channel — refresh panel when the displayed item's status changes
- Handle panel disposal (clear singleton ref, dispose SSE subscription)
- Register `generacy.queue.pinDetail` command
- Refactor existing `viewQueueItemDetails()` in `actions.ts` to delegate to `WorkItemDetailPanel.showPreview()`

---

## Phase 5: Agent Log Streaming

### T017 [Agents] Create AgentLogChannel for log viewing and streaming
**File**: `packages/generacy-extension/src/views/cloud/agents/log-channel.ts`
- Create `AgentLogChannel` class implementing `vscode.Disposable`
- Static map of active channels by agent ID (reuse existing channel for same agent)
- Constructor: create `vscode.window.createOutputChannel(`Agent: ${agent.name}`)`
- Implement `open()`:
  - Fetch historical logs via `agentsApi.getAgentLogs(agentId, { limit: 200 })`
  - Append each line to output channel
  - Subscribe to SSE `'agents'` channel, filter by agent ID
  - On matching events with log data, append new lines
  - Show the output channel
- Handle errors gracefully: show error in output channel if API fails
- Implement `dispose()`: dispose SSE subscription, dispose output channel, remove from static map
- Export static `openAgentLogs(agent)` convenience function
- Update `viewAgentLogs` in `agents/actions.ts` to use `AgentLogChannel.openAgentLogs()`

---

## Phase 6: Notifications & Configuration

### T018 [P] [Infra] Create notification manager
**File**: `packages/generacy-extension/src/utils/notifications.ts`
- Create `NotificationManager` class implementing `vscode.Disposable`
- Read notification level from config: `generacy.dashboard.notifications` (all/summary/none)
- Subscribe to SSE (all channels) via `SSESubscriptionManager`
- `'all'` mode: show `vscode.window.showInformationMessage` immediately for each event
  - Use appropriate message level (warning for failures, info for completions)
- `'summary'` mode: batch events in 10s window
  - Accumulate events in `pendingNotifications` array
  - On flush: show single notification summarizing events (e.g., "3 workflows completed, 1 failed")
  - Include "Open Dashboard" action button in notification
- `'none'` mode: suppress all notifications
- Listen for config changes to update behavior at runtime
- Proper cleanup of timers and SSE subscription in `dispose()`

### T019 [P] [Infra] Create capability checker for graceful degradation
**File**: `packages/generacy-extension/src/utils/capabilities.ts`
- Create `CapabilityChecker` class (singleton)
- Maintain `Map<string, boolean>` of endpoint availability
- Implement `isAvailable(endpoint)`:
  - Return cached result if known
  - Otherwise attempt lightweight probe (OPTIONS or GET with limit=0)
  - Cache result (404 = unavailable, 2xx = available)
  - Cache TTL: 5 minutes (re-probe after TTL expires)
- Implement `onFirstCallResult(endpoint, statusCode)` — for lazy detection from actual API calls
- Set VS Code context keys `generacy.capability.<feature>` for `when` clause bindings
- Export singleton getter `getCapabilityChecker()`

### T020 [P] [Infra] Add configuration settings to package.json
**File**: `packages/generacy-extension/package.json`
- Add to `contributes.configuration.properties`:
  - `generacy.dashboard.pollInterval`: number, default 30000, min 5000, max 300000, description for polling interval
  - `generacy.dashboard.notifications`: enum [all, summary, none], default "summary", description for notification level
  - `generacy.orchestratorUrl`: string, default "http://localhost:3100", description for orchestrator URL

---

## Phase 7: Package.json Contributions & Extension Wiring

### T021 [Infra] Add view contributions to package.json
**File**: `packages/generacy-extension/package.json`
- Add to `contributes.views.generacy` array:
  - `{ "id": "generacy.agents", "name": "Agents", "contextualTitle": "Agent Pool", "when": "generacy.isAuthenticated" }`
  - `{ "id": "generacy.orchestratorSummary", "name": "Orchestrator", "type": "webview", "when": "generacy.isAuthenticated" }`

### T022 [Infra] Add command contributions to package.json
**File**: `packages/generacy-extension/package.json`
- Add to `contributes.commands` array:
  - `generacy.openDashboard` — "Open Orchestration Dashboard", category "Generacy", icon `$(dashboard)`
  - `generacy.agents.refresh` — "Refresh Agents", category "Generacy", icon `$(refresh)`
  - `generacy.agents.viewLogs` — "View Agent Logs", category "Generacy", icon `$(output)`
  - `generacy.agents.viewByStatus` — "Group by Status", category "Generacy", icon `$(group-by-ref-type)`
  - `generacy.agents.viewFlat` — "Flat View", category "Generacy", icon `$(list-flat)`
  - `generacy.queue.assign` — "Assign to Agent...", category "Generacy", icon `$(person-add)`
  - `generacy.queue.setPriority` — "Set Priority...", category "Generacy", icon `$(arrow-both)`
  - `generacy.queue.pinDetail` — "Pin Detail Panel", category "Generacy", icon `$(pin)`

### T023 [Infra] Add menu contributions to package.json
**File**: `packages/generacy-extension/package.json`
- Add to `contributes.menus`:
  - **view/title** for `generacy.agents`:
    - `generacy.agents.refresh` in `navigation` group
    - `generacy.agents.viewByStatus` in `navigation` group, `when: "generacy.agents.viewMode != 'byStatus'"`
    - `generacy.agents.viewFlat` in `navigation` group, `when: "generacy.agents.viewMode != 'flat'"`
  - **view/title** for `generacy.orchestratorSummary`:
    - `generacy.openDashboard` in `navigation` group
  - **view/item/context** for agent items:
    - `generacy.agents.viewLogs`, `when: "viewItem =~ /^agent-/"`
  - **view/item/context** for queue items (add to existing):
    - `generacy.queue.assign`, `when: "viewItem =~ /^queueItem-pending/"`, group `inline`
    - `generacy.queue.setPriority`, `when: "viewItem =~ /^queueItem-/"`, group `2_priority`

### T024 [Infra] Wire up all new components in extension.ts
**File**: `packages/generacy-extension/src/extension.ts`
- Import SSESubscriptionManager, AgentTreeProvider factory, OrchestratorSidebarViewProvider, OrchestratorDashboardPanel, NotificationManager
- In cloud initialization section (after existing auth setup):
  - Initialize SSE manager singleton
  - Connect SSE on auth state change (authenticated → connect with orchestratorUrl + token, unauthenticated → disconnect)
  - Call `createAgentTreeProvider(context)` to register agent tree view
  - Instantiate and register `OrchestratorSidebarViewProvider` via `registerWebviewViewProvider`
  - Register `generacy.openDashboard` command → `OrchestratorDashboardPanel.createOrShow()`
  - Instantiate `NotificationManager` and push to `context.subscriptions`
- Set `generacy.orchestratorConnected` context key based on SSE connection state

---

## Phase 8: Testing & Verification

### T025 [P] Verify TypeScript compilation
**Files**: All new and modified files
- Run `pnpm build` in `packages/generacy-extension/`
- Fix any type errors in new files
- Fix any import resolution issues
- Ensure no circular dependencies between new modules

### T026 [P] Verify extension activation
- Start the extension in development mode
- Confirm no activation errors in Extension Host output
- Confirm new views appear in sidebar when authenticated
- Confirm new commands appear in command palette
- Confirm new context menu items appear on agent and queue tree items

### T027 Manual integration testing with orchestrator
- Start orchestrator locally at configured URL
- Verify SSE connection establishes on authentication
- Verify agent tree populates with connected agents
- Verify agent status updates in real-time via SSE
- Verify dashboard panel opens and shows queue/agent/activity data
- Verify sidebar summary shows correct counts
- Verify assign-to-agent action works on pending queue items
- Verify set-priority action updates queue items
- Verify work item detail panel opens, pins, and refreshes
- Verify agent log channel shows historical + live logs
- Verify notifications fire according to configuration level
- Verify graceful degradation when orchestrator endpoints return 404
- Verify SSE auto-reconnect on connection loss

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phases 2, 3, 4, 5, 6 (all depend on types, API endpoints, SSE manager)
- Phase 2 must complete before Phase 5 (agent log channel uses agent tree items/actions)
- Phases 2 + 3 must complete before Phase 7 (wiring depends on all providers being created)
- Phase 4 depends on Phase 1 (SSE integration for queue)
- Phase 6 can start after Phase 1 (only depends on SSE manager + config)
- Phase 7 depends on Phases 2, 3, 4, 5, 6 (wires everything together)
- Phase 8 depends on Phase 7 (testing requires full wiring)

**Parallel opportunities within phases**:
- Phase 1: T003 and T004 can run in parallel (independent endpoint modules). T001 and T002 must complete first.
- Phase 2: T009 can run in parallel with T006-T008. T006 must complete before T007. T007 before T008.
- Phase 3: T010 must complete before T011 and T012. T013 can run in parallel with T011/T012.
- Phase 4: T014, T015, T016 can run in parallel (different files).
- Phase 5: T017 depends on T008 (actions.ts stub).
- Phase 6: T018, T019, T020 can all run in parallel.
- Phase 7: T021, T022, T023 can run in parallel (all package.json but different sections). T024 depends on all prior phases.
- Phase 8: T025 and T026 can run in parallel.

**Critical path**:
T001 → T002 → T005 → T006 → T007 → T008 → T010 → T012 → T024 → T025 → T027

**Estimated total scope**: ~18 new/modified files, ~2,750 LOC
