# Implementation Plan: Agent Orchestration UI Components

**Feature**: 161-summary-add-ui-components
**Branch**: `161-summary-add-ui-components`
**Date**: 2026-02-22

## Summary

Add VS Code extension UI components for monitoring and managing the agent orchestration system. This includes an orchestration dashboard (sidebar summary + full editor panel), an agent tree view, SSE-based real-time updates, work item detail panels, and agent log streaming.

The implementation builds on existing patterns: `QueueTreeProvider` for tree views, `OrgDashboardPanel` for webview panels, `queueApi` for API endpoints, and the orchestrator's SSE infrastructure (`workflows`, `queue`, `agents` channels with 20 event types).

## Technical Context

| Aspect | Detail |
|--------|--------|
| **Language** | TypeScript |
| **Framework** | VS Code Extension API |
| **Package Manager** | pnpm |
| **Extension Root** | `packages/generacy-extension/` |
| **Orchestrator Root** | `packages/orchestrator/` |
| **API Client** | Singleton `ApiClient` with Zod validation (`api/client.ts`) |
| **Existing Patterns** | Polling tree providers, singleton webview panels, server-side HTML |
| **Backend SSE** | Fastify SSE endpoints at `GET /events`, channel-based routing |
| **Real-time** | SSE primary, polling fallback (per Q1 answer) |

## Architecture Overview

```
Extension Architecture (new components marked with *)

┌─────────────────────────────────────────────────────────────┐
│ VS Code Extension                                            │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                  │
│  │ QueueTreeProvider │  │*AgentTreeProvider │ ← Tree Views    │
│  │ (enhanced w/ SSE) │  │ (new, w/ SSE)    │                  │
│  └────────┬─────────┘  └────────┬─────────┘                  │
│           │                     │                             │
│  ┌────────┴─────────────────────┴─────────┐                  │
│  │        *SSESubscriptionManager          │ ← Shared SSE    │
│  │  (centralized EventSource connection)   │                  │
│  └────────┬────────────────────────────────┘                  │
│           │                                                   │
│  ┌────────┴─────────┐  ┌──────────────────┐                  │
│  │*OrchestratorPanel │  │*OrchestratorView │ ← Webviews      │
│  │ (editor tab)      │  │ (sidebar summary)│                  │
│  └──────────────────┘  └──────────────────┘                  │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                  │
│  │*WorkItemPanel     │  │*AgentLogChannel  │ ← Detail Views  │
│  │ (singleton+pin)   │  │ (output channel) │                  │
│  └──────────────────┘  └──────────────────┘                  │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                  │
│  │*agentsApi         │  │*activityApi      │ ← API Layer     │
│  │ (endpoints/       │  │ (endpoints/      │                  │
│  │  agents.ts)       │  │  activity.ts)    │                  │
│  └──────────────────┘  └──────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ Orchestrator API                                             │
│                                                              │
│  GET /agents          GET /agents/:id      GET /agents/stats │
│  GET /agents/:id/logs GET /activity                          │
│  GET /events?channels=workflows,queue,agents  (SSE)          │
│  POST /queue/:id/assign                                      │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Foundation — SSE Client & Agent Types
**Estimated scope**: ~8 files, ~600 LOC

Build the shared infrastructure that all subsequent phases depend on.

#### 1.1 Agent & Activity Types (`api/types.ts`)

Add new types and Zod schemas to the existing types file:

```typescript
// Agent types (mirror orchestrator's ConnectedAgent)
export type AgentConnectionStatus = 'connected' | 'idle' | 'busy' | 'disconnected';
export type AgentType = 'claude' | 'gpt4' | 'custom';
export type AgentDisplayStatus = 'available' | 'busy' | 'offline'; // UI grouping

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  status: AgentConnectionStatus;
  capabilities: string[];
  lastSeen: string;
  metadata: {
    version?: string;
    platform?: string;
    workflowId?: string;
  };
}

// Activity feed types
export type ActivityEventType =
  | 'workflow:started' | 'workflow:completed' | 'workflow:failed'
  | 'workflow:cancelled' | 'agent:connected' | 'agent:disconnected'
  | 'queue:item:added' | 'queue:item:removed';

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// Agent stats
export interface AgentStats {
  total: number;
  available: number;
  busy: number;
  offline: number;
}
```

**Files**:
- Edit: `packages/generacy-extension/src/api/types.ts` — add Agent, ActivityEvent, AgentStats types + Zod schemas

#### 1.2 Agent & Activity API Endpoints

Create new endpoint modules following the `queueApi` pattern:

**Files**:
- Create: `packages/generacy-extension/src/api/endpoints/agents.ts`
  - `getAgents(filters?)` → `GET /agents`
  - `getAgent(id)` → `GET /agents/:id`
  - `getAgentStats()` → `GET /agents/stats`
  - `getAgentLogs(id, params?)` → `GET /agents/:id/logs`
  - `assignWorkItem(queueItemId, agentId)` → `POST /queue/:id/assign`
- Create: `packages/generacy-extension/src/api/endpoints/activity.ts`
  - `getActivity(params?)` → `GET /activity` (last 50, paginated)

#### 1.3 SSE Subscription Manager

Centralized SSE client that any view can subscribe to. Uses the native `EventSource` API (available in VS Code's Electron runtime) or Node.js `http` for `GET /events`.

**Files**:
- Create: `packages/generacy-extension/src/api/sse.ts`

```typescript
// Key design decisions:
// - Single EventSource connection per extension instance
// - Channel-based subscription (views subscribe to 'queue', 'agents', etc.)
// - Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
// - Last-Event-ID support for reconnection replay
// - Disposable pattern for cleanup

export type SSEChannel = 'workflows' | 'queue' | 'agents';
export type SSEEventHandler = (event: SSEEvent) => void;

export class SSESubscriptionManager implements vscode.Disposable {
  private eventSource: EventSource | null = null;
  private subscribers: Map<string, Set<SSEEventHandler>>; // channel -> handlers
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000;
  private lastEventId: string | undefined;
  private connectionState: 'disconnected' | 'connecting' | 'connected' | 'error';

  // Singleton
  static getInstance(): SSESubscriptionManager;

  // Subscribe to a channel, returns disposable
  subscribe(channel: SSEChannel, handler: SSEEventHandler): vscode.Disposable;

  // Connection lifecycle
  connect(baseUrl: string, authToken: string): void;
  disconnect(): void;

  // State
  isConnected(): boolean;
  getConnectionState(): string;
}
```

**Integration**:
- SSE manager starts when user authenticates (listen to `authService.onDidChange`)
- Connects to `{orchestratorUrl}/events?channels=workflows,queue,agents`
- Passes auth token via query param or custom header (match orchestrator's auth scheme)

#### 1.4 Constants Updates (`constants.ts`)

Add new view IDs, command IDs, context keys, and tree item context values:

```typescript
// New VIEWS
agents: 'generacy.agents',

// New COMMANDS (add to CLOUD_COMMANDS or similar)
openDashboard: 'generacy.openDashboard',
refreshAgents: 'generacy.agents.refresh',
viewAgentLogs: 'generacy.agents.viewLogs',
assignWorkItem: 'generacy.queue.assign',
setPriority: 'generacy.queue.setPriority',

// New CONTEXT_KEYS
orchestratorConnected: 'generacy.orchestratorConnected',

// New TREE_ITEM_CONTEXT
agent: 'agent',
agentGroup: 'agentGroup',
```

**Files**:
- Edit: `packages/generacy-extension/src/constants.ts`

---

### Phase 2: Agent Tree View
**Estimated scope**: ~5 files, ~500 LOC

#### 2.1 Agent Tree Items (`views/cloud/agents/tree-item.ts`)

Tree item classes following the `QueueTreeItem` pattern:

- `AgentTreeItem` — individual agent with status icon, name, type badge, current assignment
- `AgentGroupItem` — status group header ("Available (3)", "Busy (2)", "Offline (1)")
- `AgentEmptyItem`, `AgentLoadingItem`, `AgentErrorItem` — state items
- Union type: `AgentExplorerItem`

Status icon mapping:
| Display Status | Backend Statuses | Icon |
|----------------|-----------------|------|
| Available | `connected`, `idle` | `$(check)` (green) |
| Busy | `busy` | `$(sync~spin)` (blue) |
| Offline | `disconnected` | `$(circle-slash)` (gray) |

Context menu items on `AgentTreeItem`:
- View Logs → opens output channel
- View Details → future (P3)

#### 2.2 Agent Tree Provider (`views/cloud/agents/provider.ts`)

```typescript
export type AgentViewMode = 'flat' | 'byStatus';

export class AgentTreeProvider
  implements vscode.TreeDataProvider<AgentExplorerItem>, vscode.Disposable {

  // Default view mode: byStatus (per Q10 answer)
  // SSE subscription for real-time agent status updates
  // Polling fallback (60s interval) for data integrity
  // Auth-reactive (starts/stops with auth state)
  // Visibility-aware (pause polling when hidden)
}
```

**SSE integration**: Subscribe to `agents` channel. On `agent:connected`, `agent:disconnected`, `agent:status` events, update the in-memory agent list and fire tree refresh.

**Polling**: Secondary mechanism — fetch `GET /agents` every 60s as integrity check. Compare with SSE-maintained state and reconcile.

**Status grouping logic** (per Q3 answer):
```typescript
function getDisplayStatus(status: AgentConnectionStatus): AgentDisplayStatus {
  switch (status) {
    case 'connected':
    case 'idle':
      return 'available';
    case 'busy':
      return 'busy';
    case 'disconnected':
      return 'offline';
  }
}
```

#### 2.3 Agent Actions (`views/cloud/agents/actions.ts`)

- `viewAgentLogs(agent)` — creates/reuses VS Code OutputChannel for the agent, fetches historical logs via `GET /agents/:id/logs`, subscribes to SSE `agents` channel filtered by agent ID for live log lines
- `registerAgentActions(context, provider)` — registers commands

**Files**:
- Create: `packages/generacy-extension/src/views/cloud/agents/tree-item.ts`
- Create: `packages/generacy-extension/src/views/cloud/agents/provider.ts`
- Create: `packages/generacy-extension/src/views/cloud/agents/actions.ts`
- Create: `packages/generacy-extension/src/views/cloud/agents/index.ts` (barrel export)

---

### Phase 3: Orchestration Dashboard
**Estimated scope**: ~6 files, ~800 LOC

#### 3.1 Sidebar Summary View (`views/cloud/orchestrator/sidebar-view.ts`)

Compact `WebviewViewProvider` registered in the sidebar showing:
- Connection status indicator (green/red dot + "Connected"/"Disconnected")
- Queue summary: "5 pending, 2 running, 1 failed"
- Agent summary: "3 available, 2 busy, 0 offline"
- "Open Dashboard" link/button

Registered via `vscode.window.registerWebviewViewProvider('generacy.orchestratorSummary', provider)`.

Data source: SSE events for real-time counts, REST fallback on initial load.

**Empty state** (per Q13): Contextual messages — "No work items in queue — add a `process:speckit-feature` label to a GitHub issue to get started." / "No agents connected — see docs to register agents."

#### 3.2 Dashboard Editor Panel (`views/cloud/orchestrator/panel.ts`)

Full editor-tab webview following the `OrgDashboardPanel` singleton pattern (per Q2 answer — C: both sidebar + panel):

**Layout** (three sections):
1. **Queue Summary** — counts by status (pending/running/completed/failed), priority distribution
2. **Agent Summary** — cards per agent with status, type, current assignment, last seen
3. **Activity Feed** — last 50 events, reverse chronological, human-readable messages

**Data loading** (per Q6 answer — C: hybrid):
- Initial load: `GET /queue/stats` + `GET /agents/stats` + `GET /activity?limit=50`
- Real-time: SSE events update counts and prepend to activity feed
- Activity feed capped at 50 items in the webview (oldest dropped)

**Message protocol**:
```typescript
// Webview → Extension
type DashboardWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openQueueItem'; id: string }
  | { type: 'openAgent'; id: string }
  | { type: 'openCommand'; command: string };

// Extension → Webview
type DashboardExtensionMessage =
  | { type: 'update'; data: DashboardData }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'error'; message: string }
  | { type: 'sseEvent'; event: SSEEvent }  // for incremental updates
  | { type: 'connectionStatus'; connected: boolean };
```

**HTML generation**: Server-side template strings (matching existing pattern — no React). VS Code CSS variables for theming. Nonce-based CSP.

#### 3.3 Dashboard Webview HTML (`views/cloud/orchestrator/webview.ts`)

HTML template function `getDashboardHtml(webview, extensionUri, data)` generating the three-section layout with:
- CSS Grid/Flexbox layout
- Status badges with color coding
- Activity feed with timestamp formatting
- Click handlers posting messages back to extension
- Auto-scroll for activity feed

**Files**:
- Create: `packages/generacy-extension/src/views/cloud/orchestrator/sidebar-view.ts`
- Create: `packages/generacy-extension/src/views/cloud/orchestrator/panel.ts`
- Create: `packages/generacy-extension/src/views/cloud/orchestrator/webview.ts`
- Create: `packages/generacy-extension/src/views/cloud/orchestrator/index.ts`

---

### Phase 4: Enhanced Queue Actions & Work Item Detail
**Estimated scope**: ~4 files, ~400 LOC

#### 4.1 Queue SSE Integration

Modify `QueueTreeProvider` to opt into the shared `SSESubscriptionManager`:

```typescript
// In QueueTreeProvider constructor:
const sseManager = SSESubscriptionManager.getInstance();
this.disposables.push(
  sseManager.subscribe('queue', (event) => {
    switch (event.event) {
      case 'queue:item:added':
        // Add item to local list, fire tree refresh
        break;
      case 'queue:item:removed':
        // Remove item from local list, fire tree refresh
        break;
      case 'queue:updated':
        // Update item in local list, fire tree refresh if changed
        break;
    }
  })
);
// Keep polling as secondary integrity check (per Q1 answer)
```

#### 4.2 Manual Dispatch / Assignment

Add "Assign to Agent..." context menu action on pending queue items:

```typescript
async function assignWorkItem(item: QueueTreeItem, provider: QueueTreeProvider): Promise<void> {
  // Fetch available agents
  const agents = await agentsApi.getAgents({ status: 'idle' });

  // Show quick pick
  const selected = await vscode.window.showQuickPick(
    agents.items.map(a => ({ label: a.name, description: a.type, detail: a.id })),
    { placeHolder: 'Select an agent to assign this work item to' }
  );

  if (selected) {
    await agentsApi.assignWorkItem(item.queueItem.id, selected.detail);
    provider.refresh();
  }
}
```

#### 4.3 Set Priority Quick Pick (per Q4 answer — C: both)

Add "Set Priority..." context menu option alongside existing up/down buttons:

```typescript
async function setPriority(item: QueueTreeItem, provider: QueueTreeProvider): Promise<void> {
  const priorities: QueuePriority[] = ['low', 'normal', 'high', 'urgent'];
  const selected = await vscode.window.showQuickPick(
    priorities.map(p => ({
      label: p.charAt(0).toUpperCase() + p.slice(1),
      description: p === item.queueItem.priority ? '(current)' : undefined,
      value: p,
    })),
    { placeHolder: 'Set priority level' }
  );

  if (selected && selected.value !== item.queueItem.priority) {
    await queueApi.updatePriority(item.queueItem.id, selected.value);
    provider.refresh();
  }
}
```

#### 4.4 Work Item Detail Panel (per Q5 answer — C: singleton with pinning)

Refactor `viewQueueItemDetails()` to use singleton-with-pin pattern:

```typescript
export class WorkItemDetailPanel {
  private static previewInstance: WorkItemDetailPanel | undefined;
  private isPinned: boolean = false;

  static showPreview(item: QueueItem, extensionUri: vscode.Uri): void {
    // If existing unpinned preview, reuse it
    if (this.previewInstance && !this.previewInstance.isPinned) {
      this.previewInstance.updateContent(item);
      this.previewInstance.panel.reveal();
      return;
    }
    // Otherwise create new
    this.previewInstance = new WorkItemDetailPanel(item, extensionUri);
  }

  pin(): void {
    this.isPinned = true;
    WorkItemDetailPanel.previewInstance = undefined; // Next selection opens new
    // Update title bar icon
  }
}
```

Panel features:
- Status/priority badges
- Timeline (queued → started → completed)
- Error details section
- Assigned agent info
- Pin button in title bar
- Refresh on SSE queue events

**Files**:
- Edit: `packages/generacy-extension/src/views/cloud/queue/provider.ts` — add SSE subscription
- Edit: `packages/generacy-extension/src/views/cloud/queue/actions.ts` — add assign, setPriority, refactor details panel
- Create: `packages/generacy-extension/src/views/cloud/queue/detail-panel.ts` — WorkItemDetailPanel

---

### Phase 5: Agent Log Streaming
**Estimated scope**: ~2 files, ~200 LOC

#### 5.1 Agent Log Output Channel

Per Q7 answer (A: REST batch + SSE stream):

```typescript
class AgentLogChannel implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;
  private sseDisposable: vscode.Disposable | undefined;

  constructor(agent: Agent) {
    this.outputChannel = vscode.window.createOutputChannel(`Agent: ${agent.name}`);
  }

  async open(): Promise<void> {
    // 1. Fetch historical logs
    const logs = await agentsApi.getAgentLogs(this.agentId, { limit: 200 });
    for (const line of logs.lines) {
      this.outputChannel.appendLine(line);
    }

    // 2. Subscribe to SSE for live lines
    const sseManager = SSESubscriptionManager.getInstance();
    this.sseDisposable = sseManager.subscribe('agents', (event) => {
      if (event.event === 'agent:status' && event.data.agentId === this.agentId) {
        // Append log lines from event metadata if present
      }
    });

    this.outputChannel.show();
  }

  dispose(): void {
    this.sseDisposable?.dispose();
    this.outputChannel.dispose();
  }
}
```

**Files**:
- Create: `packages/generacy-extension/src/views/cloud/agents/log-channel.ts`

---

### Phase 6: Notifications & Configuration
**Estimated scope**: ~3 files, ~250 LOC

#### 6.1 Notification Manager

Per Q9 answer (C: user-configurable with `generacy.dashboard.notifications`):

```typescript
type NotificationLevel = 'all' | 'summary' | 'none';

class NotificationManager implements vscode.Disposable {
  private batchTimer: NodeJS.Timeout | undefined;
  private pendingNotifications: SSEEvent[] = [];
  private batchWindowMs = 10000; // 10 seconds

  constructor() {
    // Subscribe to SSE for critical events
    // Respect user's notification preference
  }

  private handleEvent(event: SSEEvent): void {
    const level = getConfig().get<NotificationLevel>('dashboard.notifications', 'summary');

    if (level === 'none') return;

    if (level === 'all') {
      this.showImmediate(event);
      return;
    }

    // 'summary' mode: batch
    this.pendingNotifications.push(event);
    this.scheduleBatch();
  }

  private scheduleBatch(): void {
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.flushBatch();
      this.batchTimer = undefined;
    }, this.batchWindowMs);
  }
}
```

#### 6.2 Configuration Settings

New settings to add to `package.json`:

```json
{
  "generacy.dashboard.pollInterval": {
    "type": "number",
    "default": 30000,
    "minimum": 5000,
    "maximum": 300000,
    "description": "Polling interval in ms for dashboard data (fallback when SSE unavailable)"
  },
  "generacy.dashboard.notifications": {
    "type": "string",
    "enum": ["all", "summary", "none"],
    "default": "summary",
    "description": "Notification level for orchestration events"
  },
  "generacy.orchestratorUrl": {
    "type": "string",
    "default": "http://localhost:3100",
    "description": "URL of the orchestrator API"
  }
}
```

#### 6.3 Graceful Degradation (per Q8 answer — B: show disabled with tooltip)

Capability detection on first API call — if endpoint returns 404, cache the capability as unavailable and disable the corresponding UI action with tooltip:

```typescript
class CapabilityChecker {
  private capabilities: Map<string, boolean> = new Map();

  async isAvailable(endpoint: string): Promise<boolean> {
    if (this.capabilities.has(endpoint)) {
      return this.capabilities.get(endpoint)!;
    }
    // Try OPTIONS or a lightweight GET, cache result
  }
}
```

Tree items check capability before showing enabled/disabled state. Context menu items use `when` clause with context key `generacy.capability.<feature>`.

**Files**:
- Create: `packages/generacy-extension/src/utils/notifications.ts`
- Create: `packages/generacy-extension/src/utils/capabilities.ts`
- Edit: `packages/generacy-extension/package.json` — add configuration settings

---

### Phase 7: Package.json Contributions & Wiring
**Estimated scope**: ~2 files, ~300 LOC (JSON + extension.ts wiring)

#### 7.1 New Package.json Contributions (per Q15 — explicit checklist)

**Views** (in `generacy` container):
```json
{
  "id": "generacy.agents",
  "name": "Agents",
  "when": "generacy.isAuthenticated"
},
{
  "id": "generacy.orchestratorSummary",
  "name": "Orchestrator",
  "type": "webview",
  "when": "generacy.isAuthenticated"
}
```

**Commands**:
| Command ID | Title | Icon |
|------------|-------|------|
| `generacy.openDashboard` | Open Orchestration Dashboard | `$(dashboard)` |
| `generacy.agents.refresh` | Refresh Agents | `$(refresh)` |
| `generacy.agents.viewLogs` | View Agent Logs | `$(output)` |
| `generacy.agents.viewByStatus` | Group by Status | `$(group-by-ref-type)` |
| `generacy.agents.viewFlat` | Flat View | `$(list-flat)` |
| `generacy.queue.assign` | Assign to Agent... | `$(person-add)` |
| `generacy.queue.setPriority` | Set Priority... | `$(arrow-both)` |
| `generacy.queue.pinDetail` | Pin Detail Panel | `$(pin)` |

**Menus**:

`view/title` contributions:
- `generacy.agents` title bar: refresh, viewByStatus/viewFlat toggle
- `generacy.orchestratorSummary` title bar: openDashboard, refresh

`view/item/context` contributions:
- `agentItem` context: viewLogs
- `queueItem` context: assign, setPriority (in addition to existing cancel/retry/priorityUp/priorityDown)

**Configuration** (under `generacy`):
- `dashboard.pollInterval` (number, default 30000)
- `dashboard.notifications` (enum: all/summary/none, default summary)
- `orchestratorUrl` (string, default http://localhost:3100)

#### 7.2 Extension Activation Wiring (`extension.ts`)

In the cloud initialization section of `activate()`:

```typescript
// After existing cloud setup...

// Initialize SSE manager
const sseManager = SSESubscriptionManager.getInstance();
// Connect when authenticated
authService.onDidChange((event) => {
  if (event.newState.isAuthenticated) {
    const orchestratorUrl = getConfig().get('orchestratorUrl', 'http://localhost:3100');
    sseManager.connect(orchestratorUrl, authService.getAccessToken());
  } else {
    sseManager.disconnect();
  }
});

// Create agent tree provider
const agentProvider = createAgentTreeProvider(context);

// Register orchestrator sidebar view
const orchestratorSidebarProvider = new OrchestratorSidebarViewProvider(context.extensionUri);
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider('generacy.orchestratorSummary', orchestratorSidebarProvider)
);

// Register dashboard command
context.subscriptions.push(
  vscode.commands.registerCommand('generacy.openDashboard', () => {
    OrchestratorDashboardPanel.createOrShow(context.extensionUri);
  })
);

// Initialize notification manager
const notificationManager = new NotificationManager();
context.subscriptions.push(notificationManager);
```

**Files**:
- Edit: `packages/generacy-extension/package.json` — all contributions
- Edit: `packages/generacy-extension/src/extension.ts` — wiring

---

## New API Endpoints Required (Orchestrator Side)

These endpoints need to be added to the orchestrator. See `contracts/` for OpenAPI specs.

| Endpoint | Method | Description | Priority |
|----------|--------|-------------|----------|
| `GET /agents/:id/logs` | GET | Historical agent logs (paginated) | P2 |
| `GET /activity` | GET | Activity feed (last N events) | P2 |
| `POST /queue/:id/assign` | POST | Manual dispatch to specific agent | P2 |
| `GET /queue/stats` | GET | Queue summary counts | P1 (exists) |
| `GET /agents/stats` | GET | Agent summary counts | P1 (exists) |

Note: `GET /agents`, `GET /agents/:id`, `GET /agents/stats`, `GET /queue/stats` already exist in the orchestrator.

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SSE client architecture | Shared `SSESubscriptionManager` singleton (Q1-C) | Single connection shared across all views; orchestrator already has channel-based routing |
| Dashboard placement | Both sidebar summary + editor panel (Q2-C) | Sidebar for quick glance, panel for full experience; follows existing `OrgDashboardPanel` pattern |
| Agent status mapping | Three groups: Available/Busy/Offline (Q3-C) | `connected`+`idle` = Available; clean UX with precise status in detail view |
| Priority adjustment | Inline up/down + absolute picker (Q4-C) | Four-level enum makes step-through fast; quick-pick for direct access |
| Detail panel lifecycle | Singleton with pinning (Q5-C) | Matches VS Code preview tab pattern; prevents tab clutter |
| Activity feed source | Hybrid REST + SSE (Q6-C) | REST for historical, SSE for real-time; persistence across restarts |
| Agent log streaming | REST batch + SSE stream (Q7-A) | Standard log viewer pattern; history + live tail |
| Unavailable endpoints | Show disabled with tooltip (Q8-B) | Progressive disclosure; users see coming features |
| Notifications | User-configurable: all/summary/none (Q9-C) | 10s batch window for summary mode; respects user autonomy |
| Default grouping | Both views default to byStatus (Q10-C) | Most actionable; consistent across views |
| Cancel semantics | Cancel workflow only (Q11-A) | Event-driven; queue updates as side effect |
| Confirmation dialogs | Cancel only (Q12-A) | Only destructive action; avoids confirmation fatigue |
| Empty state | Guided setup per section (Q13-B) | Helps onboarding; contextual messages with links |
| Pagination | "Load More" tree node (Q14-A) | Standard VS Code tree pattern; existing `pageSize=50` |
| Package.json | Explicit contribution list (Q15-A) | Prevents silent missing-feature bugs |

## Data Models

See [data-model.md](./data-model.md) for complete type definitions and Zod schemas.

## API Contracts

See [contracts/orchestrator-api.yaml](./contracts/orchestrator-api.yaml) for OpenAPI specs of new endpoints.

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| New API endpoints not ready | Features unavailable | Capability detection (Q8-B): show disabled with tooltip. SSE and existing endpoints work independently |
| SSE connection instability | Stale data in UI | Auto-reconnect with backoff + polling fallback on all views; `Last-Event-ID` for replay |
| Large agent/queue counts | Performance degradation | Pagination (50 items + "Load More"); tree refresh debouncing; SSE event deduplication |
| Extension size bloat | Slower activation | Lazy initialization of orchestrator views (only when authenticated); code splitting via dynamic imports |
| Orchestrator URL misconfiguration | Connection failures | Clear error state in sidebar summary view; link to settings; health check on connect |
| EventSource not available | SSE won't work | Fallback to Node.js `http` request with manual SSE parsing (Electron supports EventSource but some environments may not) |

## File Summary

### New Files (14)

| File | Description |
|------|-------------|
| `api/sse.ts` | SSESubscriptionManager singleton |
| `api/endpoints/agents.ts` | Agent API client |
| `api/endpoints/activity.ts` | Activity feed API client |
| `views/cloud/agents/tree-item.ts` | Agent tree item classes |
| `views/cloud/agents/provider.ts` | AgentTreeProvider |
| `views/cloud/agents/actions.ts` | Agent action commands |
| `views/cloud/agents/log-channel.ts` | Agent log output channel |
| `views/cloud/agents/index.ts` | Barrel export |
| `views/cloud/orchestrator/sidebar-view.ts` | Sidebar summary WebviewViewProvider |
| `views/cloud/orchestrator/panel.ts` | Dashboard editor panel |
| `views/cloud/orchestrator/webview.ts` | Dashboard HTML generation |
| `views/cloud/orchestrator/index.ts` | Barrel export |
| `utils/notifications.ts` | Notification manager |
| `utils/capabilities.ts` | Endpoint capability checker |

### Modified Files (4)

| File | Changes |
|------|---------|
| `api/types.ts` | Add Agent, AgentStats, ActivityEvent types + Zod schemas |
| `constants.ts` | Add new view IDs, command IDs, context keys, tree item contexts |
| `package.json` | Add views, commands, menus, configuration contributions |
| `extension.ts` | Wire up SSE manager, agent tree, orchestrator views, notifications |
| `views/cloud/queue/provider.ts` | Add SSE subscription for real-time queue updates |
| `views/cloud/queue/actions.ts` | Add assign, setPriority; refactor details to use WorkItemDetailPanel |

### Spec Artifacts

| File | Description |
|------|-------------|
| `specs/161-summary-add-ui-components/data-model.md` | Complete type definitions |
| `specs/161-summary-add-ui-components/research.md` | Technical decisions documentation |
| `specs/161-summary-add-ui-components/contracts/orchestrator-api.yaml` | OpenAPI spec for new endpoints |
