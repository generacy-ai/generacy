# Technical Research: 5.2 — Generacy VS Code Extension MVP

## Codebase Assessment

### Implementation Status

The extension scaffolding at `packages/generacy-extension/` is far more than scaffolding — it contains **production-quality implementations** of the core MVP features. A detailed file-by-file audit reveals:

| Component | Status | Key Files |
|-----------|--------|-----------|
| Extension activation & init | Complete | `src/extension.ts` |
| Auth (OAuth + token mgmt) | Complete | `src/api/auth.ts` |
| API client (HTTP + retry) | Complete | `src/api/client.ts` |
| SSE subscription manager | Complete | `src/api/sse.ts` |
| Queue tree provider | Complete | `src/views/cloud/queue/provider.ts` |
| Agent tree provider | Complete | `src/views/cloud/agents/provider.ts` |
| Orchestrator dashboard (panel) | Complete | `src/views/cloud/orchestrator/panel.ts` + `webview.ts` |
| Orchestrator sidebar summary | Complete | `src/views/cloud/orchestrator/sidebar-view.ts` |
| Job detail panel | Complete | `src/views/cloud/queue/detail-panel.ts` + `detail-html.ts` |
| Log streaming (REST + SSE) | Complete | `src/views/cloud/log-viewer/log-channel.ts` |
| Notification service | Complete | `src/services/job-notification-service.ts` |
| Status bar (auth + jobs) | Complete | `src/providers/status-bar.ts` |
| Cloud commands | Complete | `src/commands/cloud.ts` |
| Marketplace metadata | Complete | `package.json`, `README.md`, `.vscodeignore` |
| **Project config detection** | **Missing** | — |
| **`waiting` queue status** | **Missing** | — |
| **User profile endpoint** | **Missing** | — |
| **Project-scoped filtering** | **Missing** | — |

### Architecture Patterns

The codebase follows consistent patterns:

1. **Singleton services**: `AuthService.getInstance()`, `ApiClient.getInstance()`, `SSESubscriptionManager.getInstance()`, `ConfigurationManager.getInstance()`
2. **Disposable cleanup**: All services implement `vscode.Disposable`, registered in `context.subscriptions`
3. **EventEmitter state changes**: `_onDidChange` pattern for reactive UI updates
4. **Zod validation**: All API responses validated at runtime
5. **Debounced SSE updates**: 200ms debounce on tree provider refreshes from rapid SSE events

### Key Finding: SSE Implementation

The SSE client is **not** the browser `EventSource` API. It's a custom Node.js HTTP-based implementation (`src/api/sse.ts`) that:
- Uses `http.request()` / `https.request()` directly
- Parses SSE protocol manually (field extraction, double-newline delimiters)
- Supports `Authorization: Bearer` headers (not possible with browser EventSource)
- Supports `Last-Event-ID` header for replay
- Implements exponential backoff reconnection (1s → 30s)

This is important because it means:
- Bearer header auth works (Q14 resolved)
- Channel-based subscription via query params works alongside header auth
- The existing implementation is correct for the Node.js extension host environment

### Key Finding: Notification Service Sophistication

The `JobNotificationService` is more sophisticated than the spec requires:
- **Event deduplication**: Bounded set of 100 seen IDs with FIFO eviction
- **Rate limiting**: 3+ notifications in 10s → single summary notification
- **Focus batching**: Queues notifications when VS Code is unfocused, delivers on refocus
- **continueOnError inference**: 5-second window to detect step failures that don't produce terminal events
- **Data enrichment**: Fetches `JobProgress` for PR URL and failed step details

This exceeds the spec's requirements. The main gap is adding `waiting` status handling and project-scope filtering.

---

## Dependency Analysis

### YAML Parsing

Need to verify if `yaml` package is in `package.json`:

```bash
# Check for yaml dependency
grep '"yaml"' packages/generacy-extension/package.json
```

If not present, add `yaml` (https://www.npmjs.com/package/yaml) — the standard YAML parser for Node.js. Alternative: `js-yaml`, but `yaml` is more modern and supports YAML 1.2.

### No New Major Dependencies

The implementation requires no new frameworks or major dependencies beyond potentially `yaml`. All functionality is built on:
- VS Code Extension API (built-in)
- Zod (already installed)
- Node.js `http`/`https` (built-in)

---

## Clarification Decision Log

Documenting each clarification answer and its implementation impact:

### Q1: SSE Endpoint Model → Hybrid
**Impact**: Change SSE manager `connect()` URL construction from `{baseUrl}/events` to `{baseUrl}/api/orgs/{orgId}/orchestrator/events?channels=...`. The `orgId` is sourced from the user profile API response. ~5 lines changed in `sse.ts`.

### Q2: Event Namespaces → Code Convention
**Impact**: No code changes. The existing `workflow:*`, `queue:*`, `agent:*` namespaces are preserved. Spec documentation should be updated to reflect actual event names.

### Q3: Auth URL → API Direct
**Impact**: Already implemented correctly. `auth.ts` uses `{cloudEndpoint}/auth/github`. No changes needed, just verify `?client=vscode` query param is included.

### Q4: Dashboard UI → Both Sidebar + Panel
**Impact**: Already implemented. `orchestrator/sidebar-view.ts` (sidebar) and `orchestrator/panel.ts` (full panel) both exist and work. The sidebar has an "Open Dashboard" button. No structural changes needed.

### Q5: Webview Tech → Plain HTML/CSS/JS
**Impact**: Already the established pattern. No changes to rendering approach.

### Q6: Multi-Workspace → Single Only
**Impact**: `ProjectConfigService` will use `vscode.workspace.workspaceFolders?.[0]` only.

### Q7: Org Resolution → User Profile API
**Impact**: New `GET /users/me` endpoint. Auth service calls it after token exchange to get org memberships. Stored alongside user data in global state.

### Q8: Log Streaming → Hybrid REST + SSE
**Impact**: Already implemented in `log-channel.ts`. Historical fetch + cursor-based SSE handoff is the existing pattern.

### Q9: Notification Scope → Project-Scoped
**Impact**: `JobNotificationService` constructor accepts `ProjectConfigService`. Filter `queue:updated` events by matching project. ~20 lines added.

### Q10: Queue vs Dashboard → Unified
**Impact**: Queue tree provider defaults to project-scoped filter. Minor change to default filter options. ~10 lines.

### Q11: Offline Behavior → Stale Data
**Impact**: Already handled by SSE reconnection logic. Status bar can show "Last updated" timestamp. ~15 lines in status bar provider.

### Q12: Packaging → Package-Ready
**Impact**: Verify existing metadata. Add `yaml` dep if missing. Run `vsce package` to produce `.vsix`.

### Q13: 429 Handling → Warn + Poll Fallback
**Impact**: Add 429 status code check in SSE `connect()` error handler. Show warning message, fall back to polling. ~15 lines in `sse.ts`.

### Q14: SSE Auth → Bearer Header
**Impact**: Already implemented. No changes needed.

### Q15: Waiting Status → First-Class
**Impact**: Add `'waiting'` to type union (+Zod), `waitingFor?: string` to `QueueItem`, update dashboard stats, tree item icons, notification handling. ~150 lines across 8 files.
