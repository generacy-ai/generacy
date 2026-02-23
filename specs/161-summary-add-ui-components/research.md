# Technical Research: Agent Orchestration UI Components

**Feature**: 161-summary-add-ui-components

## 1. SSE Client Implementation in VS Code Extensions

### Problem
The extension needs to consume Server-Sent Events from the orchestrator's `GET /events` endpoint. VS Code extensions run in Electron's Node.js environment, which does not natively support the browser `EventSource` API.

### Options Evaluated

| Option | Pros | Cons |
|--------|------|------|
| **`eventsource` npm package** | Drop-in EventSource polyfill for Node.js; supports `Last-Event-ID`; well-maintained | Additional dependency |
| **Node.js `http` with manual SSE parsing** | No dependencies; full control | Must manually handle SSE protocol (event/data/id field parsing, reconnection, heartbeats) |
| **`@microsoft/fetch-event-source`** | Supports custom headers, POST SSE; used by some VS Code extensions | Larger API surface than needed; Microsoft-maintained but less active |

### Decision
Use Node.js `http`/`https` with manual SSE parsing. Rationale:
- The SSE protocol is simple (field: value\n lines separated by \n\n)
- Avoids adding npm dependencies to the extension
- Full control over reconnection logic, auth header injection, and connection lifecycle
- The orchestrator's SSE format is well-defined (event, id, data fields)

### Implementation Pattern

```typescript
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

class SSEClient {
  private request: http.ClientRequest | null = null;
  private buffer: string = '';

  connect(url: string, headers: Record<string, string>): void {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...headers,
        ...(this.lastEventId ? { 'Last-Event-ID': this.lastEventId } : {}),
      },
    };

    this.request = mod.request(options, (res) => {
      if (res.statusCode !== 200) {
        this.handleError(new Error(`SSE connection failed: ${res.statusCode}`));
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => this.processChunk(chunk));
      res.on('end', () => this.handleDisconnect());
      res.on('error', (err) => this.handleError(err));
    });

    this.request.on('error', (err) => this.handleError(err));
    this.request.end();
  }

  private processChunk(chunk: string): void {
    this.buffer += chunk;
    const events = this.buffer.split('\n\n');
    this.buffer = events.pop() ?? ''; // Last element is incomplete

    for (const eventStr of events) {
      if (eventStr.trim()) {
        this.parseEvent(eventStr);
      }
    }
  }

  private parseEvent(eventStr: string): void {
    let eventType = 'message';
    let data = '';
    let id = '';

    for (const line of eventStr.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith(':')) { /* comment/heartbeat, ignore */ }
    }

    if (id) this.lastEventId = id;
    if (data) {
      this.emit(eventType, { event: eventType, id, data: JSON.parse(data) });
    }
  }
}
```

### Reconnection Strategy
- Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
- Send `Last-Event-ID` header on reconnect for event replay
- Orchestrator buffers 100 events / 60s retention
- Reset backoff on successful connection
- Stop reconnecting on auth failure (401) or explicit disconnect

---

## 2. Webview Architecture: HTML Templates vs React

### Current State
All existing webviews use server-side HTML template strings:
- `OrgDashboardPanel` generates full HTML via `getDashboardHtml()`
- `viewQueueItemDetails()` generates static HTML
- No React/Svelte/Vue framework in the extension

### Decision
Continue with server-side HTML template strings. Rationale:
- Consistency with existing codebase
- No build pipeline needed for webview assets
- Dashboard content is primarily data display, not interactive forms
- VS Code CSS variables provide theming for free
- Bidirectional messaging via `postMessage` handles user actions

### Incremental Interactivity
For the dashboard's activity feed (which needs to update in real-time without full page re-render):
- Use `postMessage` from extension to webview with `sseEvent` type
- Webview script uses `document.getElementById()` to prepend new activity items
- No framework needed for this level of DOM manipulation

---

## 3. Tree View Performance with SSE Updates

### Problem
SSE events can arrive rapidly (especially during high activity). Naive tree refresh on every event would cause UI flickering and performance issues.

### Mitigation Strategy

1. **Debounced refresh**: Collect SSE events over a 500ms window, then fire a single tree refresh:
   ```typescript
   private refreshDebounceTimer: NodeJS.Timeout | undefined;

   private scheduleRefresh(): void {
     if (this.refreshDebounceTimer) return;
     this.refreshDebounceTimer = setTimeout(() => {
       this._onDidChangeTreeData.fire();
       this.refreshDebounceTimer = undefined;
     }, 500);
   }
   ```

2. **Targeted refresh**: For `queue:item:added` / `queue:item:removed`, update the in-memory array and refresh. For `queue:updated`, only refresh if the specific item's display-relevant fields changed (status, priority).

3. **Visibility check**: Don't process SSE events when the tree view is not visible (already implemented via `onDidChangeVisibility` pattern in `QueueTreeProvider`).

---

## 4. Work Item Detail Panel: Singleton with Pinning

### VS Code Preview Tab Analogy
VS Code has a native "preview mode" for editors where clicking a file replaces the preview tab unless you double-click (which "pins" it). The work item detail panel follows this pattern.

### Implementation

```
State Machine:

[No Panel] --click item--> [Preview Panel (item A)]
[Preview Panel (A)] --click item B--> [Preview Panel (B)]  // reuses
[Preview Panel (A)] --pin--> [Pinned Panel (A)]
[Pinned Panel (A)] --click item B--> [Pinned (A)] + [Preview (B)]  // new preview
```

Key details:
- `previewInstance` is a static class field (like `OrgDashboardPanel.instance`)
- `isPinned` flag on the instance
- Pin action: register a command `generacy.queue.pinDetail` that sets `isPinned = true` and clears `previewInstance`
- Panel title includes pin indicator: `"Queue: workflow-name"` → `"[Pinned] Queue: workflow-name"`
- On panel dispose: clear `previewInstance` if this was the preview

---

## 5. Notification Batching Algorithm

### Requirements (Q9)
- `"all"` mode: immediate toast per event
- `"summary"` mode: batch events over 10-second window, show aggregate
- `"none"` mode: silent

### Batching Logic for Summary Mode

```typescript
private pendingNotifications: Map<string, SSEClientEvent[]> = new Map();
// Key: event category ("agent_offline", "work_failed")

private flushBatch(): void {
  for (const [category, events] of this.pendingNotifications) {
    if (events.length === 1) {
      // Single event: show specific message
      vscode.window.showWarningMessage(`Agent "${events[0].data.agentId}" went offline`);
    } else {
      // Multiple events: show aggregated
      vscode.window.showWarningMessage(`${events.length} agents went offline`);
    }
  }
  this.pendingNotifications.clear();
}
```

Categories for aggregation:
- `agent_offline` → "N agents went offline"
- `work_failed` → "N work items failed"
- `agent_connected` → "N agents connected" (info, not warning)

---

## 6. Capability Detection for Unavailable Endpoints

### Problem
New orchestrator endpoints (`GET /agents/:id/logs`, `GET /activity`, `POST /queue/:id/assign`) may not be deployed when the extension update ships. The UI should degrade gracefully (Q8: show disabled with tooltip).

### Approach

1. **Lazy detection**: On first use of a capability, make the API call. If it returns 404, cache `capability.<endpoint> = false`.
2. **Cache TTL**: 5 minutes. After TTL, retry detection (endpoint may have been deployed).
3. **Context keys**: Set `generacy.capability.agentLogs`, `generacy.capability.activity`, `generacy.capability.assign` as VS Code context keys.
4. **`when` clauses**: Use in menu contributions: `"when": "generacy.capability.assign"` to hide/show context menu items.
5. **Tooltip**: For tree view inline buttons, show disabled state with description text.

This avoids a startup "capabilities endpoint" call and handles the common case where all endpoints are available with zero overhead.

---

## 7. Queue-to-Orchestrator API Alignment

### Extension Queue Types vs Orchestrator Queue Types

The extension has its own `QueueItem` type (for the cloud queue view) which is separate from the orchestrator's `DecisionQueueItem` (for human decision requests). They serve different purposes:

| Extension `QueueItem` | Orchestrator `DecisionQueueItem` |
|----------------------|----------------------------------|
| Tracks workflow execution in queue | Tracks human decisions needed |
| Status: pending/running/completed/failed/cancelled | Type: approval/choice/input/review |
| Priority: low/normal/high/urgent | Priority: blocking_now/blocking_soon/when_available |

The orchestrator also has a third queue concept: the dispatch queue (`QueueManager`) for GitHub issue processing, which uses numeric priority (timestamp-based FIFO).

The new UI components primarily enhance the extension's existing `QueueItem` model. The orchestrator's `DecisionQueueItem` is already served by the existing queue tree view. No type unification is needed.

---

## 8. Extension Activation Performance

### Concern
Adding SSE connection, new tree providers, and webview providers could slow extension activation.

### Mitigation
- **Lazy SSE**: Don't connect until user authenticates and at least one subscriber exists
- **Lazy tree providers**: Register tree data providers immediately (cheap), but don't start polling/SSE until the view is visible
- **Lazy webview**: `WebviewViewProvider.resolveWebviewView()` is only called when the view becomes visible
- **No new activation events**: The extension already activates on workspace file patterns; no additional triggers needed

---

## 9. Orchestrator URL Configuration

### Current State
- `generacy.cloudEndpoint` (default: `https://api.generacy.ai`) — used by `ApiClient` for cloud API
- `orchestratorUrl` — referenced in `handleSubmitJob()` as `http://localhost:3100` but not a formal config key

### Decision
Add `generacy.orchestratorUrl` as a formal configuration setting (default: `http://localhost:3100`). The SSE manager and new agent/activity API calls use this URL. The cloud API (`cloudEndpoint`) remains separate — it serves auth, org management, and workflow publishing, while the orchestrator serves workflow execution, queue, agents, and SSE.
