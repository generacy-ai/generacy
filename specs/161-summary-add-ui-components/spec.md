# Feature Specification: Orchestration Dashboard UI Components

**Branch**: `161-summary-add-ui-components` | **Date**: 2026-02-22 | **Status**: Draft

## Summary

Add UI components to the Generacy VS Code extension and orchestrator API for monitoring and managing the agent orchestration system. This includes a dashboard view with work queue visualization, agent status cards, and an activity feed; work management controls for queue operations; and agent monitoring panels. The components integrate with the existing Fastify orchestrator API via REST endpoints and SSE for real-time updates, following the extension's established webview and tree data provider patterns.

## User Stories

### US1: View Orchestration Dashboard

**As a** development team lead,
**I want** a single dashboard view showing work queue status, agent health, and recent activity,
**So that** I can quickly assess the overall state of the orchestration system without switching between multiple views.

**Acceptance Criteria**:
- [ ] Dashboard webview panel opens via command palette (`generacy.openDashboard`) or sidebar icon
- [ ] Work queue summary shows counts for pending, in-progress, and completed items
- [ ] Agent pool summary shows counts for available, busy, and offline agents
- [ ] Recent activity feed shows the last 20 events (workflow starts, completions, failures, agent assignments)
- [ ] Dashboard data refreshes automatically via SSE subscription
- [ ] Dashboard displays a meaningful empty state when no data is available
- [ ] Loading and error states are handled gracefully

### US2: Manage Work Queue

**As a** development team lead,
**I want** to view, prioritize, reassign, and retry queued work items,
**So that** I can control the flow of work through the orchestration system when automated dispatch needs manual intervention.

**Acceptance Criteria**:
- [ ] Queued items are displayed in a tree view with status icons and priority indicators
- [ ] Items can be filtered by status (pending, in-progress, completed, failed), repository, and assignee
- [ ] Priority of a pending item can be adjusted (up/down) via context menu or inline action
- [ ] A pending or failed item can be manually dispatched to a specific available agent
- [ ] An in-progress item can be cancelled via context menu with confirmation
- [ ] A failed item can be retried via context menu
- [ ] Queue view updates in real-time as items change status

### US3: Monitor Agent Health and Assignments

**As a** development team lead,
**I want** to see each agent's status, current assignment, and recent performance metrics,
**So that** I can identify unhealthy or underperforming agents and take corrective action.

**Acceptance Criteria**:
- [ ] Agent list tree view shows all registered agents with status badge (available, busy, offline)
- [ ] Selecting an agent shows a detail panel with current assignment, uptime, and task completion count
- [ ] Agent log output is accessible via a command that opens the agent's recent logs in an output channel
- [ ] Offline agents are visually distinguished and sorted to the bottom of the list
- [ ] Agent status updates are received in real-time via SSE

### US4: Track Work Item Progress

**As a** developer,
**I want** to see the detailed progress of a specific work item including phase, logs, and PR status,
**So that** I can understand where work stands without checking GitHub directly.

**Acceptance Criteria**:
- [ ] Clicking a work item in the queue opens a detail webview panel
- [ ] Detail panel shows: title, description, assigned agent, current phase, elapsed time
- [ ] If a PR has been created, a link to the PR is displayed
- [ ] Phase progress indicator shows completed and remaining phases
- [ ] Log output from the assigned agent is streamable into an output channel

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Dashboard webview panel with queue summary, agent summary, and activity feed sections | P1 | Uses existing webview HTML template pattern from `getDashboardHtml()` |
| FR-002 | Work queue tree data provider with status/repo/assignee grouping modes | P1 | Extends existing `QueueTreeDataProvider` pattern in `packages/generacy-extension/src/views/cloud/queue/` |
| FR-003 | Agent list tree data provider showing all connected agents with status | P1 | New tree view registered in extension activation |
| FR-004 | SSE subscription for real-time dashboard, queue, and agent updates | P1 | Uses existing SSE infrastructure in `packages/orchestrator/src/sse/` |
| FR-005 | Queue item context menu actions: adjust priority, cancel, retry | P1 | REST calls to orchestrator API endpoints |
| FR-006 | Manual dispatch command to assign a work item to a specific agent | P2 | Requires `POST /workflows/:id/assign` endpoint or equivalent |
| FR-007 | Work item detail webview panel with phase progress and logs | P2 | Opens as a side panel when a queue item is selected |
| FR-008 | Agent detail panel showing current assignment, uptime, and task count | P2 | Inline display or webview panel |
| FR-009 | Agent log streaming via VS Code output channel | P2 | One output channel per agent, content from SSE or REST polling |
| FR-010 | Configurable polling interval as fallback when SSE is unavailable | P3 | Setting: `generacy.dashboard.pollInterval` (default 30s) |
| FR-011 | Dashboard auto-refresh toggle | P3 | User can pause/resume live updates |
| FR-012 | Notification toasts for critical events (agent offline, work item failed) | P3 | Uses VS Code `window.showWarningMessage` |

## API Requirements

The following orchestrator API endpoints are required. Existing endpoints are noted; new endpoints need implementation.

| Endpoint | Method | Status | Description |
|----------|--------|--------|-------------|
| `GET /workflows` | GET | Exists | List workflows with pagination and filtering |
| `GET /workflows/:id` | GET | Exists | Get workflow detail including phase status |
| `POST /workflows/:id/pause` | POST | Exists | Pause a workflow |
| `POST /workflows/:id/resume` | POST | Exists | Resume a paused workflow |
| `DELETE /workflows/:id` | DELETE | Exists | Cancel a workflow |
| `GET /queue` | GET | Exists | Get queue items with filters |
| `POST /queue/:id/respond` | POST | Exists | Respond to a decision |
| `GET /agents` | GET | Exists | List agents with status/type filter |
| `GET /agents/:id` | GET | Exists | Get agent detail |
| `GET /agents/stats` | GET | Exists | Agent statistics |
| `GET /events` | GET | Exists | SSE event stream |
| `PATCH /queue/:id/priority` | PATCH | **New** | Adjust queue item priority |
| `POST /workflows/:id/retry` | POST | **New** | Retry a failed workflow |
| `POST /workflows/:id/assign` | POST | **New** | Manually assign workflow to agent |
| `GET /agents/:id/logs` | GET | **New** | Stream agent log output |
| `GET /activity` | GET | **New** | Recent activity feed (aggregated events) |

## Technical Design

### Extension Components

```
packages/generacy-extension/src/views/cloud/
├── dashboard/
│   ├── webview.ts              # Dashboard HTML template (extend existing)
│   └── dashboard-provider.ts   # WebviewViewProvider for dashboard panel
├── queue/
│   ├── tree-provider.ts        # QueueTreeDataProvider (extend existing)
│   ├── queue-item.ts           # TreeItem for queue entries
│   └── detail-webview.ts       # Work item detail panel
├── agents/
│   ├── tree-provider.ts        # AgentTreeDataProvider (new)
│   ├── agent-item.ts           # TreeItem for agent entries
│   └── detail-webview.ts       # Agent detail panel
└── activity/
    └── activity-provider.ts    # Activity feed data provider
```

### State Management

- **Tree data providers** maintain local state and refresh on SSE events or polling intervals, consistent with existing `QueueTreeDataProvider` pattern.
- **API client singleton** (`packages/generacy-extension/src/api/client.ts`) handles all REST calls with retry logic.
- **SSE subscription manager** connects to `GET /events` and dispatches events to registered listeners (dashboard, queue, agent views).

### Webview Communication

Dashboard and detail webviews use the VS Code `postMessage` API for bidirectional communication between the extension host and webview content, following the existing pattern in the cloud dashboard.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Dashboard load time | < 2 seconds from command invocation to rendered content | Manual timing / automated test |
| SC-002 | Real-time update latency | < 3 seconds from orchestrator event to UI update | Measure SSE round-trip in integration test |
| SC-003 | Queue operations success rate | > 99% for priority change, cancel, retry actions | API response status tracking |
| SC-004 | Data accuracy | Dashboard counts match orchestrator API responses | Comparison test between dashboard display and direct API query |
| SC-005 | Error recovery | Dashboard recovers from SSE disconnection within 10 seconds | Simulate network interruption |

## Assumptions

- The orchestrator API server is running and accessible from the VS Code extension environment
- Authentication is already handled by the existing API client (API key / JWT)
- SSE infrastructure in the orchestrator is operational and emits events for workflow, queue, and agent state changes
- The existing `QueueTreeDataProvider` and cloud dashboard webview patterns are stable and suitable for extension
- Agents register themselves with the orchestrator and report heartbeats; the agent registry reflects current state
- Redis is available for the orchestrator to persist state (with in-memory fallback for development)

## Out of Scope

- **VS Code extension marketplace publishing** — deployment is handled separately
- **Custom web-based dashboard** — this feature targets the VS Code extension only, not a standalone web app
- **Agent provisioning or lifecycle management** — starting/stopping agents is managed outside Generacy
- **Detailed performance analytics or historical reporting** — only current/recent metrics are shown
- **Role-based access control for dashboard actions** — all authenticated users have the same permissions
- **Mobile or responsive layouts** — VS Code webviews target desktop viewport only
- **Orchestrator API implementation** — new endpoints listed in API Requirements are assumed to be delivered by a separate workstream; this spec covers the UI components that consume them
- **Automated alerting or paging** — notifications are local VS Code toasts only

## Dependencies

| Dependency | Owner | Status | Risk |
|------------|-------|--------|------|
| Orchestrator API (existing endpoints) | Orchestrator team | Available | Low |
| Orchestrator API (new endpoints: priority, retry, assign, logs, activity) | Orchestrator team | Not started | Medium — UI features blocked until endpoints exist |
| SSE event infrastructure | Orchestrator team | Available | Low |
| VS Code Extension API (webviews, tree views) | VS Code | Stable | Low |
| API client with auth | Generacy Extension | Available | Low |

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| New API endpoints delayed | UI features for priority, retry, assign, logs are blocked | Medium | Implement UI with graceful degradation; disable actions when endpoints are unavailable |
| SSE connection instability | Dashboard shows stale data | Low | Fallback to configurable polling interval; auto-reconnect with exponential backoff |
| Large queue / agent counts degrade performance | Tree views become slow to render | Low | Implement pagination in tree providers; limit activity feed to recent 50 items |
| Webview content security policy blocks resources | Dashboard fails to render | Low | Follow VS Code CSP best practices; use nonces for inline scripts |

---

*Generated by speckit*
