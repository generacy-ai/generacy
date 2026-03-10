# Clarification Questions

## Status: Resolved

## Questions

### Q1: SSE Endpoint Mismatch Between Spec and Code
**Context**: The spec describes the SSE endpoint as `GET /api/orgs/:orgId/orchestrator/events` with token-based auth via query parameter (`?token=...`), but the existing `SSESubscriptionManager` in `src/api/sse.ts` connects to `{baseUrl}/events` with `Authorization: Bearer` header and channel-based subscription (`?channels=workflows,queue,agents,jobs`). These are fundamentally different connection models — the spec is org-scoped with token-in-URL, while the code is channel-scoped with header auth.
**Question**: Which SSE connection model should the MVP use?
**Options**:
- A) Spec model: Single org-scoped endpoint `/api/orgs/:orgId/orchestrator/events` with `?token=` query param auth (EventSource API compatible)
- B) Code model: Channel-based endpoint `{orchestratorUrl}/events?channels=...` with `Authorization: Bearer` header (Node.js http-based, already implemented)
- C) Hybrid: Use the code's channel-based architecture but connect to the spec's org-scoped endpoint path with query param auth for compatibility
**Answer**: **C (Hybrid)** — Use the code's channel-based subscription architecture (already implemented, more flexible) but update the endpoint path to be org-scoped (`/api/orgs/:orgId/orchestrator/events?channels=...`). The channel model allows selective subscription (e.g., only `queue` and `jobs` for the sidebar, all channels for the full dashboard). Org-scoping is necessary for multi-tenancy in generacy-cloud. Bearer header auth (not query param) since we're in Node.js — see Q14.

### Q2: SSE Event Type Namespace Mismatch
**Context**: The spec defines SSE event types with `job:` prefix (e.g., `job:created`, `job:phase_changed`, `job:completed`, `job:failed`, `job:cancelled`, `job:retried`), while the existing type system in `src/api/types.ts` defines events with `workflow:` and `queue:` prefixes (e.g., `workflow:started`, `workflow:completed`, `queue:item:added`). The SSE channel routing in `sse.ts` infers channels from event prefixes — `job:*` events would route to the `jobs` channel, but `workflow:*` routes to `workflows`. These need to be aligned for the event dispatching to work correctly.
**Question**: Which event type namespace should the MVP use for orchestrator job events?
**Options**:
- A) Spec convention: `job:created`, `job:phase_changed`, `job:completed`, `job:failed`, etc. (route to `jobs` channel)
- B) Code convention: `workflow:started`, `workflow:completed`, `workflow:failed`, etc. (route to `workflows` channel)
- C) Use both: Map spec events to code events at the SSE subscription layer (translation adapter)
**Answer**: **B (Code convention)** — The existing `workflow:*`, `queue:*` namespaces are already integrated throughout the tree providers, SSE routing, and debounce logic. They're more granular and descriptive than the spec's `job:*` events. The spec was aspirational; the code is functional. Update the spec to match the code, not the other way around.

### Q3: Auth URL Path Discrepancy
**Context**: The spec says the Sign In command should open `https://generacy.ai/auth/vscode`, but the existing `AuthService.login()` implementation builds the URL as `{cloudEndpoint}/auth/github` (where `cloudEndpoint` defaults to `https://api.generacy.ai`). These are different hosts (`generacy.ai` vs `api.generacy.ai`) and different paths (`/auth/vscode` vs `/auth/github`). The choice affects whether the OAuth initiation goes through the main website or directly to the API.
**Question**: Which URL should the Sign In command open for the OAuth flow?
**Options**:
- A) `https://generacy.ai/auth/vscode` — Main website handles OAuth initiation with a VS Code-specific landing page
- B) `https://api.generacy.ai/auth/github` — API server handles OAuth directly (current code implementation)
- C) Configurable via `generacy.cloudEndpoint` setting with `/auth/vscode` path (allows dev/staging flexibility)
**Answer**: **B (API server) with path adjustment** — Use `https://api.generacy.ai/auth/github?client=vscode`. The API server handles OAuth directly — having generacy.ai redirect to the API adds an unnecessary hop. The `?client=vscode` parameter tells the server to use the `vscode://` callback URI scheme. This aligns with the buildout plan section 2.2 which puts all auth in generacy-cloud's API. The plan's reference to `generacy.ai/auth/vscode` was a UX simplification in the spec, not an architectural mandate.

### Q4: Dashboard Implementation Approach
**Context**: The spec describes the dashboard as a webview panel opened via `Generacy: Show Orchestration Dashboard` command. The existing code has two separate dashboard/orchestrator locations: `src/views/cloud/dashboard/` (with `panel.ts` + `webview.ts`) and `src/views/cloud/orchestrator/` (with `panel.ts` + `webview.ts` + `sidebar-view.ts`). It's unclear if the MVP dashboard should be the full-panel webview, the sidebar webview, or both — and which of these existing scaffolds to use.
**Question**: How should the orchestration dashboard be presented in the VS Code UI?
**Options**:
- A) Editor panel only: The `Show Dashboard` command opens a webview panel in the editor area (like a document tab), sidebar shows a summary tree view
- B) Sidebar only: Dashboard is embedded in the activity bar sidebar under `generacy.orchestratorSummary` view, no separate panel
- C) Both: Sidebar shows a compact summary (tree view with counts), clicking "Open Full Dashboard" opens the detailed webview panel in the editor area
**Answer**: **C (Both)** — Sidebar shows a compact summary (connection status, job counts, waiting-for-input alerts). Clicking "Open Full Dashboard" opens the detailed webview panel in the editor area. This follows standard VS Code patterns (like Git's sidebar summary + full Source Control view) and leverages both existing scaffolds (`orchestrator/sidebar-view.ts` for the sidebar, `orchestrator/panel.ts` for the full view).

### Q5: Dashboard Webview Technology
**Context**: The dashboard webview needs to render summary cards, job lists, and real-time updates. The spec doesn't specify the rendering approach. Options range from plain HTML/CSS (simplest, no bundling needed), to using a lightweight framework. VS Code webviews are sandboxed iframes, so the technology choice affects complexity, bundle size, and maintainability.
**Question**: What technology should be used for the dashboard webview content?
**Options**:
- A) Plain HTML/CSS/JS: Template strings in TypeScript generating HTML, vanilla JS event handling (simplest, no build step for webview)
- B) Preact/lightweight framework: Small framework bundled into the webview for component-based rendering (better for complex UIs)
- C) VS Code Webview UI Toolkit: Microsoft's `@vscode/webview-ui-toolkit` web components for native VS Code look-and-feel
**Answer**: **A (Plain HTML/CSS/JS)** — This is already the established pattern in both existing webviews (`dashboard/webview.ts` and `orchestrator/webview.ts`). It requires no additional build step, keeps the extension lightweight, and is sufficient for the MVP's read-only dashboard. Note: the VS Code Webview UI Toolkit (option C) was deprecated by Microsoft. If UI complexity grows post-MVP, migrate to Preact then.

### Q6: Multi-Workspace and Multi-Org Support
**Context**: The spec assumes a single workspace with a single `.generacy/config.yaml` containing one `project.id`. However, VS Code supports multi-root workspaces, and a user might belong to multiple organizations. The spec doesn't address: what happens in a multi-root workspace with multiple `.generacy/config.yaml` files, or how to select which org's dashboard to show if the user belongs to multiple orgs.
**Question**: How should the MVP handle multi-workspace and multi-org scenarios?
**Options**:
- A) Single workspace only: Use the first workspace folder's config, ignore others. If user has multiple orgs, use the org from the config file
- B) Workspace picker: Show a quick-pick if multiple configs are found, but only one active project at a time
- C) Multi-workspace support: Show all detected projects, allow switching between them via status bar
**Answer**: **A (Single workspace only)** — MVP scope. Use the first workspace folder's `.generacy/config.yaml`. Org is derived from auth (see Q7). Multi-root workspace support is a post-MVP enhancement — the buildout plan section 5.2 explicitly scopes to "User can authenticate and see orchestration status," not multi-project management.

### Q7: Config File Schema and Fields
**Context**: The spec references `.generacy/config.yaml` with fields `project.id`, `project.name`, and `repos.primary`, but the existing code's `ExtensionConfig` in `src/utils/config.ts` uses VS Code settings (not YAML config parsing). There's no Zod schema or parser for the project config file. The exact schema of `.generacy/config.yaml` isn't defined — are there additional fields beyond the three mentioned? Is the orgId in the config or derived from the auth token?
**Question**: Where does the organization ID come from for API calls?
**Options**:
- A) From the config file: `.generacy/config.yaml` includes an `org.id` field alongside `project.id`
- B) From auth token: The JWT access token contains the user's org ID, no org info needed in config
- C) From user profile API: After auth, call a `/me` or `/user/profile` endpoint that returns the user's org membership
**Answer**: **C (From user profile API)** — After GitHub OAuth, call a `/me` or `/user/profile` endpoint that returns the user's org memberships. The `.generacy/config.yaml` contains `project.id` (as defined in buildout plan section 4.2) which maps to an org server-side. Putting `org.id` in the config file is problematic — it's committed to git and visible in public repos, and different users on the same project may belong to different orgs. The JWT token (option B) works but is fragile if org membership changes without re-auth.

### Q8: Log Streaming Implementation
**Context**: The spec says live logs should stream via SSE events (`job:phase_changed`, `job:completed`, `job:failed`), but these are high-level lifecycle events, not granular log lines. The existing code has `JobLogLine` types with `content`, `stream` (stdout/stderr), and `timestamp` fields, plus a `GET /queue/:id/logs` endpoint with cursor-based pagination. It's unclear whether log lines stream through the same org-level SSE connection or through a separate job-specific SSE endpoint.
**Question**: How should live log lines be streamed to the extension?
**Options**:
- A) Same SSE connection: Log lines are delivered as events on the existing org-level SSE stream (e.g., `job:log` event type)
- B) Separate SSE endpoint: A dedicated `GET /orchestrator-jobs/queue/:jobId/logs/stream` endpoint for per-job log streaming
- C) Hybrid: Initial log fetch via REST (`GET /queue/:id/logs` with cursor), then transition to SSE for new lines using the cursor for zero-gap handoff
**Answer**: **C (Hybrid)** — Initial fetch via REST (`GET /queue/:id/logs` with cursor-based pagination) to load log history, then transition to SSE for new lines using the cursor for zero-gap handoff. REST handles bulk historical data, SSE handles real-time streaming. The existing `JobLogLine` types and cursor pagination are already implemented. The SSE event would be `job:log` on the org-level stream with a `jobId` field for filtering.

### Q9: Notification Deduplication and Scope
**Context**: The spec says notifications should fire for job completions, failures, and waiting-for-input events. Since the SSE stream carries org-wide events, the user will receive notifications for all jobs in their org, not just their own. For large teams, this could be noisy. The spec mentions configurable settings (`generacy.notifications.*`) but doesn't specify whether notifications should be filtered by project, assignee, or other criteria.
**Question**: Should notifications be scoped/filtered, and if so, by what criteria?
**Options**:
- A) All org events: Notify for every job in the org (simplest, matches spec literally)
- B) Project-scoped: Only notify for jobs matching the current workspace's `project.id` from config
- C) Configurable filter: Add a `generacy.notifications.scope` setting with options like "all", "my-project", "assigned-to-me"
**Answer**: **B (Project-scoped)** — Only notify for jobs matching the current workspace's `project.id` from config. Org-wide notifications would be noisy for teams. This matches the extension's workspace-centric UX — you're working on a specific project, you want notifications for that project. The `generacy.notifications.enabled` setting already exists; no need for additional scope configuration in MVP.

### Q10: Queue Tree View vs Dashboard Relationship
**Context**: The package.json defines both a `generacy.queue` tree view (in the sidebar) and the webview-based dashboard. The spec describes the dashboard with summary cards and job lists, while the code has a separate `QueueTreeProvider` with its own tree items. It's unclear whether these are independent views of the same data, or if the sidebar queue view is the primary view and the dashboard is supplementary.
**Question**: What is the relationship between the sidebar Queue tree view and the Dashboard webview?
**Options**:
- A) Queue tree view is primary: Sidebar shows the full job queue as a tree, dashboard is a supplementary summary view
- B) Dashboard is primary: Dashboard is the main interaction surface, sidebar queue tree is a compact quick-reference
- C) Unified: Queue tree view shows only "my project" jobs, dashboard shows org-wide overview with summary cards
**Answer**: **C (Unified)** — Queue tree view shows project-scoped jobs (filtered by current workspace's `project.id`), dashboard shows org-wide overview with summary cards. This gives developers a focused sidebar view for their immediate work, with the ability to see the broader picture in the full dashboard. The existing `QueueTreeProvider` already supports filter options — just default to filtering by project.

### Q11: Offline/Disconnected Behavior
**Context**: The spec mentions SSE reconnection and polling fallback, but doesn't address what happens when the user is completely offline or the API is unreachable. Should the extension show cached data from the last successful fetch? Should it periodically retry? What visual indicator shows the user that data is stale?
**Question**: How should the extension behave when the API is unreachable?
**Options**:
- A) Empty state: Show "Unable to connect" message in views, clear all data, retry on manual refresh only
- B) Stale data: Show last fetched data with a "Last updated: X min ago" indicator, auto-retry in background with exponential backoff
- C) Graceful degradation: Show cached data with a prominent "Offline" banner, auto-retry with backoff, allow switching to local-only mode
**Answer**: **B (Stale data)** — Show last fetched data with a "Last updated: X min ago" indicator in the status bar. Auto-retry with exponential backoff (already implemented in SSE reconnection). No need for a full "local-only mode" in MVP — the extension is read-only for orchestration, so stale data with a clear staleness indicator is sufficient.

### Q12: Extension Packaging and Publishing
**Context**: The spec assumes CI/CD from issue #243 handles publishing to the VS Code Marketplace, but the scope of this issue needs clarity. Should this issue include the `vsce package` configuration, marketplace metadata (icon, README, changelog, categories, tags), and the `.vscodeignore` file? Or is that covered by the CI/CD issue?
**Question**: What marketplace packaging artifacts should this issue produce?
**Options**:
- A) Code only: Implement the extension features; packaging/publishing is entirely issue #243's responsibility
- B) Package-ready: Include marketplace metadata (icon, README, categories, `.vscodeignore`), produce a `.vsix` file, but don't publish
- C) Full publish: Configure marketplace metadata and include `vsce publish` in the build script
**Answer**: **B (Package-ready)** — This issue should produce marketplace metadata (icon, README, categories, `.vscodeignore`) and a `.vsix` artifact. The CI/CD pipeline (issue #243) handles the actual `vsce publish` step. Clean separation — 5.2 owns the extension content, #243 owns the automation.

### Q13: Error Handling for 429 Rate Limits on SSE
**Context**: The spec mentions "Max 5 SSE connections per user enforced server-side" and says to "Handle 429 gracefully with user message." However, it doesn't specify what the user experience should be. Should the extension keep retrying? Show a one-time warning? Prevent further connection attempts? Should it attempt to close other connections first?
**Question**: What should happen when the SSE connection receives a 429 (too many connections)?
**Options**:
- A) Warn and stop: Show a warning message "Too many connections — close Generacy in other VS Code windows" and do not retry SSE (fall back to polling)
- B) Warn and retry: Show a warning, wait with longer backoff (e.g., 60s), then retry assuming another connection may have closed
- C) Smart management: Show a warning with an action button "Disconnect other sessions" that calls an API to close stale connections, then retry
**Answer**: **A (Warn and stop, fall back to polling)** — Show a warning: "Too many active connections — close Generacy in other VS Code windows" and fall back to the existing polling mechanism (`dashboard.pollInterval` setting, default 30s). Don't retry SSE automatically — the user needs to close another window first. The polling fallback is already implemented and provides a functional (if less real-time) experience.

### Q14: Token Passing for SSE Connection
**Context**: The spec says SSE auth uses query parameter token (`?token=...`) because the EventSource API doesn't support custom headers. However, the existing `SSESubscriptionManager` uses `Authorization: Bearer` header with Node.js `http`/`https` modules (not the browser EventSource API). Since VS Code extensions run in Node.js, they can set custom headers on SSE connections. Using tokens in query params has security implications (URL logging, browser history).
**Question**: Should the SSE connection use query parameter or header-based authentication?
**Options**:
- A) Query parameter: `?token=...` as spec says, for consistency with the server implementation even though headers are possible
- B) Bearer header: `Authorization: Bearer <token>` as the code already implements (more secure, Node.js supports it)
- C) Support both: Try header first, fall back to query parameter if the server returns 401
**Answer**: **B (Bearer header)** — The code already implements this, Node.js supports custom headers on HTTP connections, and it's more secure (no token in URL logs, proxy logs, or browser history). The spec's rationale for query params (EventSource API limitation) doesn't apply because VS Code runs in Node.js, not a browser. Update the spec to reflect the Node.js reality.

### Q15: Waiting-for-Input Job State
**Context**: The spec references jobs in a "waiting" state (US4, US7) with a `waiting-for:clarification` label, but the existing `QueueStatus` type only has `pending | running | completed | failed | cancelled` — there is no `waiting` status. The spec's dashboard shows a "Waiting-for-input" list queried via `GET /orchestrator-jobs/queue?status=waiting`. This requires either a new status value or treating "waiting" as a sub-state of "running."
**Question**: How should "waiting for input" jobs be represented?
**Options**:
- A) New status: Add `waiting` as a new `QueueStatus` value in the type system and API
- B) Sub-state of running: Keep `status=running` but add a `waitingFor?: string` field on `QueueItem`, filter client-side
- C) Label-based: Jobs remain `running` but have a `waiting-for:*` label; query with `GET /orchestrator-jobs/queue?label=waiting-for:*`
**Answer**: **A (New status)** — Add `waiting` as a first-class `QueueStatus` value. It's a distinct state with meaningfully different UX treatment: shown in a separate "Waiting for Input" section in the dashboard, triggers specific notifications, and requires human action to resolve. Treating it as a sub-state of `running` would require client-side filtering everywhere, and label-based queries couple the UI to the GitHub label system. A proper status value is cleaner.
