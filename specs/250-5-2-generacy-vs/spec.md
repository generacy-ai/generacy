# Feature Specification: 5.2 — Generacy VS Code Extension MVP

**Branch**: `250-5-2-generacy-vs` | **Date**: 2026-02-27 | **Status**: Draft

## Summary

Build and publish the Generacy VS Code extension MVP (`generacy-extension` package). The extension provides developers with an integrated experience for authentication, project detection, orchestration monitoring, live job log streaming, and notifications — all within VS Code. The MVP focuses on the **read-only orchestration dashboard** and **auth flow**, deferring local workflow editing/debugging and cloud publishing to future iterations.

The extension scaffolding already exists in `packages/generacy-extension/` with `package.json` defining 50+ commands, view containers, debugger configuration, and settings. This issue completes the MVP subset: auth, project detection, dashboard, job detail, log streaming, and notifications.

### References

- [generacy-vscode-extension-spec.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/generacy-vscode-extension-spec.md) — Full extension specification
- [onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 5.2 in Epic 5

### Execution

**Phase:** 4
**Blocked by:**
- [ ] generacy-ai/generacy-cloud#93 — API endpoints for project management
- [ ] generacy-ai/generacy#243 — CI/CD for generacy repo

---

## User Stories

### US1: Extension Installation

**As a** developer,
**I want** to install the Generacy extension from the VS Code Marketplace,
**So that** I can access Generacy features without leaving my editor.

**Acceptance Criteria**:
- [ ] Extension appears on the VS Code Marketplace as `generacy-ai.generacy-extension`
- [ ] Extension activates when workspace contains `.generacy/**/*.yaml` or `.generacy/**/*.yml`
- [ ] Activity bar icon appears with the Generacy logo
- [ ] Extension loads without errors on VS Code `^1.108.0`

### US2: Authentication via GitHub

**As a** developer,
**I want** to sign in with my GitHub account via generacy.ai,
**So that** I can access my organization's orchestration data.

**Acceptance Criteria**:
- [ ] `Generacy: Sign In` command opens browser to `https://generacy.ai/auth/vscode`
- [ ] Browser redirects to `vscode://generacy-ai.generacy-extension/auth/callback` after GitHub OAuth
- [ ] Extension receives the authorization code and exchanges it for tokens via `POST /auth/token`
- [ ] Access token and refresh token are stored in VS Code SecretStorage (never in plaintext)
- [ ] CSRF protection via random `state` parameter verified on callback
- [ ] Status bar shows signed-in username after successful auth
- [ ] `Generacy: Sign Out` command clears stored tokens and resets auth state
- [ ] Token refresh occurs automatically 5 minutes before expiry
- [ ] Auth state persists across VS Code restarts (session restore from SecretStorage)
- [ ] 60-second timeout if callback never arrives, with user-friendly error

### US3: Project Detection

**As a** developer working in a Generacy-enabled project,
**I want** the extension to detect my project configuration automatically,
**So that** orchestration views are scoped to my project without manual setup.

**Acceptance Criteria**:
- [ ] Extension detects `.generacy/config.yaml` in workspace root on activation
- [ ] Parses `project.id`, `project.name`, and `repos.primary` from config
- [ ] Status bar shows project name when config is detected
- [ ] Extension watches for config file changes and reloads automatically
- [ ] Graceful fallback when no config exists (local-only mode, cloud views hidden)

### US4: Orchestration Dashboard

**As a** developer,
**I want** to see a read-only dashboard of my organization's orchestration queue,
**So that** I can monitor the status of all jobs without switching to a browser.

**Acceptance Criteria**:
- [ ] `Generacy: Show Orchestration Dashboard` command opens the dashboard webview
- [ ] Dashboard shows summary cards: Active, Waiting, Completed (7d), Failed (7d)
- [ ] Active jobs list shows: issue reference, repo, current phase, elapsed time
- [ ] Waiting-for-input list shows: issue reference, wait label, time waiting, link to view
- [ ] Dashboard auto-refreshes via SSE connection to `GET /api/orgs/:orgId/orchestrator/events`
- [ ] Falls back to polling at configurable interval (`generacy.dashboard.pollInterval`, default 30s) when SSE unavailable
- [ ] Dashboard requires authentication; shows sign-in prompt when unauthenticated
- [ ] Dashboard is read-only (no job control actions in MVP)

### US5: Job Detail View

**As a** developer,
**I want** to click on a job in the dashboard to see its full detail,
**So that** I can understand the progress and context of a specific job.

**Acceptance Criteria**:
- [ ] Clicking a job in the dashboard opens its detail view
- [ ] Detail view shows: phase progress timeline, current labels, recent activity log
- [ ] Shows associated branch name and PR link (if applicable)
- [ ] Shows issue reference with link to open in browser
- [ ] Data fetched from `GET /orchestrator-jobs/queue/:jobId`
- [ ] Detail view updates in real-time via SSE events for the specific job

### US6: Live Log Streaming

**As a** developer,
**I want** to view live logs for an active job,
**So that** I can follow the agent's progress in real time.

**Acceptance Criteria**:
- [ ] `View Logs` action available on active jobs in the queue tree view and job detail view
- [ ] Log viewer displays timestamped log entries in a scrollable panel
- [ ] Logs stream in real-time via SSE (`job:phase_changed`, `job:completed`, `job:failed` events)
- [ ] Auto-scroll to bottom when new entries arrive (with option to pause auto-scroll)
- [ ] Log viewer shows connection status indicator (connected / reconnecting / disconnected)
- [ ] Supports reconnection with `Last-Event-ID` header to replay missed events

### US7: Notifications

**As a** developer,
**I want** to receive VS Code notifications when jobs complete, fail, or need input,
**So that** I can respond promptly without constantly watching the dashboard.

**Acceptance Criteria**:
- [ ] Toast notification appears when a job completes successfully
- [ ] Toast notification appears when a job fails (with error summary)
- [ ] Toast notification appears when a job is waiting for input (e.g., `waiting-for:clarification`)
- [ ] Notifications are actionable: "View Job" button opens the job detail view
- [ ] Notification preferences configurable via `generacy.notifications.*` settings
- [ ] Notifications can be fully disabled via `generacy.notifications.enabled: false`

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| **Extension Scaffolding** | | | |
| FR-001 | Activity bar view container with Generacy icon | P1 | Already defined in package.json |
| FR-002 | Tree views: Workflows, Queue, Agents, Orchestrator | P1 | Queue and Orchestrator views gated by `generacy.isAuthenticated` context |
| FR-003 | Status bar item showing auth state and project name | P1 | Shows username when signed in, project name from config |
| FR-004 | Command palette entries for all MVP commands | P1 | Sign In, Sign Out, Show Dashboard, View Job, Refresh |
| FR-005 | Extension activation on `.generacy/**/*.yaml` workspace detection | P1 | Defined in `activationEvents` |
| **Authentication** | | | |
| FR-010 | OAuth flow: open browser to `https://generacy.ai/auth/vscode` | P1 | Include `redirect_uri` and random `state` param |
| FR-011 | URI handler for `vscode://generacy-ai.generacy-extension/auth/callback` | P1 | Validates state, extracts code |
| FR-012 | Token exchange via `POST /auth/token` with authorization code | P1 | Returns `access_token`, `refresh_token`, `expires_in`, `user` |
| FR-013 | Token storage in VS Code SecretStorage | P1 | Access token, refresh token stored separately |
| FR-014 | Automatic token refresh before expiry | P1 | Refresh 5 min before expiry; on-demand refresh if < 1 min remaining |
| FR-015 | Auth state change events (`onDidChange` emitter) | P1 | Notifies views to show/hide based on auth state |
| FR-016 | Auth tier detection (Anonymous, Free, Organization) | P2 | Cloud features require `Organization` tier |
| FR-017 | Session persistence across VS Code restarts | P1 | Restore from SecretStorage + globalState on activation |
| **Project Detection** | | | |
| FR-020 | Parse `.generacy/config.yaml` on activation | P1 | Extract `project.id`, `project.name`, `repos.primary` |
| FR-021 | FileSystemWatcher for config file changes | P2 | Re-parse on save |
| FR-022 | Config schema validation using Zod | P2 | Warn user of invalid config |
| **Orchestration Dashboard** | | | |
| FR-030 | Webview-based dashboard panel | P1 | HTML/CSS/JS rendered in VS Code webview |
| FR-031 | Summary cards with job counts by status | P1 | Active, Waiting, Completed (7d), Failed (7d) |
| FR-032 | Active jobs list with phase and elapsed time | P1 | Data from `GET /orchestrator-jobs/queue?status=active` |
| FR-033 | Waiting-for-input list with label and age | P1 | Data from `GET /orchestrator-jobs/queue?status=waiting` |
| FR-034 | SSE connection for real-time updates | P1 | Connect to `GET /api/orgs/:orgId/orchestrator/events?token=...` |
| FR-035 | Polling fallback when SSE unavailable | P2 | Configurable interval, default 30s |
| FR-036 | Connection status indicator in dashboard | P2 | Connected / Reconnecting / Disconnected |
| FR-037 | SSE reconnection with `Last-Event-ID` replay | P1 | Server replays missed events from buffer (100 events, 5-min TTL) |
| **Job Detail View** | | | |
| FR-040 | Phase progress timeline visualization | P1 | Show completed/active/pending phases with durations |
| FR-041 | Label badges display | P2 | Show current issue labels as styled badges |
| FR-042 | Recent activity log | P1 | Timestamped entries of job actions |
| FR-043 | Branch and PR links | P2 | Click to open in browser via `vscode.env.openExternal` |
| FR-044 | Real-time updates via SSE | P1 | Update on `job:phase_changed`, `job:completed`, `job:failed` |
| **Live Log Streaming** | | | |
| FR-050 | Log viewer panel with timestamped entries | P1 | Rendered in webview or output channel |
| FR-051 | SSE-based log streaming | P1 | Subscribe to job-specific events |
| FR-052 | Auto-scroll with pause toggle | P2 | User can lock scroll position |
| FR-053 | Connection status indicator | P2 | Visual indicator of stream health |
| **Notifications** | | | |
| FR-060 | Job completion notification | P1 | `vscode.window.showInformationMessage` with "View Job" action |
| FR-061 | Job failure notification | P1 | `vscode.window.showErrorMessage` with "View Job" action |
| FR-062 | Waiting-for-input notification | P1 | `vscode.window.showWarningMessage` with "View Job" action |
| FR-063 | Configurable notification levels | P2 | `generacy.notifications.enabled`, `.onComplete`, `.onError` settings |
| **SSE Integration** | | | |
| FR-070 | SSE auth via query parameter token | P1 | EventSource API doesn't support custom headers |
| FR-071 | Handle SSE event types: `job:created`, `job:phase_changed`, `job:completed`, `job:failed`, `job:cancelled`, `job:retried` | P1 | Map to dashboard updates and notifications |
| FR-072 | Heartbeat handling (30s interval) | P1 | Detect stale connections, auto-reconnect |
| FR-073 | Max 5 SSE connections per user enforced server-side | P1 | Handle 429 gracefully with user message |

---

## Technical Design

### Architecture Overview

```
┌───────────────────────────────────────────────────────────┐
│  VS Code Extension (generacy-extension)                   │
│                                                           │
│  ┌─────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │  Auth    │  │  Config      │  │  SSE Client      │    │
│  │  Service │  │  Service     │  │  (EventSource)   │    │
│  └────┬─────┘  └──────┬───────┘  └────────┬─────────┘    │
│       │               │                    │              │
│  ┌────▼─────┐  ┌──────▼───────┐  ┌────────▼─────────┐   │
│  │  Status  │  │  Workflow    │  │  Dashboard       │   │
│  │  Bar     │  │  Explorer    │  │  Webview         │   │
│  └──────────┘  └──────────────┘  └────────┬─────────┘   │
│                                           │              │
│                                  ┌────────▼─────────┐   │
│                                  │  Notification    │   │
│                                  │  Service         │   │
│                                  └──────────────────┘   │
└───────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌──────────────────────────────┐
│  generacy.ai    │  │  generacy-cloud API          │
│  /auth/vscode   │  │                              │
│  (OAuth start)  │  │  POST /auth/token            │
│                 │  │  POST /auth/refresh           │
│                 │  │  GET  /orchestrator-jobs/*     │
│                 │  │  GET  /orgs/:id/orch/events   │
└─────────────────┘  └──────────────────────────────┘
```

### Auth Flow Sequence

```
Developer          VS Code Extension         Browser          generacy.ai        generacy-cloud API
    │                      │                     │                  │                      │
    │  Cmd: Sign In        │                     │                  │                      │
    │─────────────────────>│                     │                  │                      │
    │                      │  Generate state     │                  │                      │
    │                      │  Store in memory     │                  │                      │
    │                      │                     │                  │                      │
    │                      │  openExternal()     │                  │                      │
    │                      │────────────────────>│                  │                      │
    │                      │                     │  /auth/vscode    │                      │
    │                      │                     │─────────────────>│                      │
    │                      │                     │                  │  GitHub OAuth         │
    │                      │                     │<────────────────>│                      │
    │                      │                     │                  │                      │
    │                      │  URI callback       │  redirect to     │                      │
    │                      │<────────────────────│  vscode://...    │                      │
    │                      │                     │                  │                      │
    │                      │  Validate state     │                  │                      │
    │                      │  Extract code       │                  │                      │
    │                      │                     │                  │                      │
    │                      │  POST /auth/token   │                  │                      │
    │                      │─────────────────────────────────────────────────────────────>│
    │                      │                     │                  │                      │
    │                      │  { access_token,    │                  │                      │
    │                      │    refresh_token,   │                  │                      │
    │                      │    user }           │                  │                      │
    │                      │<─────────────────────────────────────────────────────────────│
    │                      │                     │                  │                      │
    │                      │  Store in           │                  │                      │
    │                      │  SecretStorage      │                  │                      │
    │                      │                     │                  │                      │
    │  Status bar updated  │                     │                  │                      │
    │<─────────────────────│                     │                  │                      │
```

### SSE Event Flow

```
Extension                       generacy-cloud API                Redis
    │                                  │                            │
    │  GET /orgs/:id/orch/events       │                            │
    │  ?token=...                      │                            │
    │  Last-Event-ID: <ulid>           │                            │
    │─────────────────────────────────>│                            │
    │                                  │  Verify token              │
    │                                  │  Check org membership      │
    │                                  │  Check connection limit    │
    │                                  │                            │
    │  event: connected                │                            │
    │  data: { connectionId }          │                            │
    │<─────────────────────────────────│                            │
    │                                  │                            │
    │  (replay missed events)          │  getSince(lastEventId)     │
    │<─────────────────────────────────│                            │
    │                                  │                            │
    │  : heartbeat (every 30s)         │                            │
    │<─────────────────────────────────│                            │
    │                                  │                            │
    │                                  │  SUBSCRIBE                 │
    │                                  │  orchestrator:events:{org} │
    │                                  │─────────────────────────>  │
    │                                  │                            │
    │                                  │  PUBLISH event             │
    │                                  │<─────────────────────────  │
    │  event: job:phase_changed        │                            │
    │  id: <ulid>                      │                            │
    │  data: { jobId, phase, ... }     │                            │
    │<─────────────────────────────────│                            │
```

### Key API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /auth/token` | POST | Exchange OAuth code for tokens |
| `POST /auth/refresh` | POST | Refresh access token |
| `POST /auth/logout` | POST | Invalidate refresh token |
| `GET /orchestrator-jobs/status` | GET | Queue summary counts |
| `GET /orchestrator-jobs/queue` | GET | List jobs with filtering |
| `GET /orchestrator-jobs/queue/:jobId` | GET | Job detail with activity |
| `GET /api/orgs/:orgId/orchestrator/events` | GET | SSE stream for real-time updates |

### SSE Event Types Handled

| Event | Action |
|-------|--------|
| `connected` | Set connection status to "connected" |
| `reconnected` | Update UI, log missed event count |
| `job:created` | Add job to active list, increment counter |
| `job:phase_changed` | Update job phase in dashboard and detail view |
| `job:completed` | Move to completed, trigger notification |
| `job:failed` | Move to failed, trigger error notification |
| `job:cancelled` | Remove from active list |
| `job:retried` | Move back to active list |

---

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Extension installs from Marketplace | Extension listed and installable | Manual verification on Marketplace |
| SC-002 | Auth flow success rate | >95% of auth attempts complete successfully | Telemetry on auth start vs. auth complete events |
| SC-003 | Extension activation time | <2 seconds from workspace open to ready | Measure time from `activate()` to first view rendered |
| SC-004 | SSE connection stability | <5% dropped connections per hour | Monitor reconnection events |
| SC-005 | Dashboard data freshness | <5 second delay from server event to UI update | Compare SSE event timestamp to render timestamp |
| SC-006 | Token refresh reliability | Zero auth-expired errors during active sessions | Monitor token refresh failures |
| SC-007 | Notification delivery | 100% of job completion/failure events produce notifications (when enabled) | Compare SSE events received to notifications shown |

---

## Assumptions

- The `generacy.ai/auth/vscode` web page exists and handles the GitHub OAuth redirect, ultimately redirecting to the `vscode://` URI scheme with an authorization code
- The `POST /auth/token` endpoint in generacy-cloud accepts authorization codes from the VS Code OAuth flow and returns JWT tokens
- The SSE endpoints in generacy-cloud (`/api/orgs/:orgId/orchestrator/events`) are deployed and functional before extension release
- The orchestrator jobs API (`/orchestrator-jobs/queue`, `/orchestrator-jobs/status`) returns data in the schema expected by the extension
- VS Code `^1.108.0` supports the URI handler and SecretStorage APIs used by this extension
- The CI/CD pipeline for the generacy monorepo (issue #243) is in place to build and publish the extension to the VS Code Marketplace
- Users have a GitHub account and a Generacy organization to access cloud features
- The extension publisher account `generacy-ai` is registered on the VS Code Marketplace

---

## Out of Scope

- **Local workflow editing and debugging** — The workflow editor, runner, and debugger with breakpoints are defined in the full spec but deferred to a future iteration
- **Cloud workflow publishing** — Publishing local workflows to cloud, version comparison, and rollback are post-MVP
- **Integration management** — Configuring GitHub, Jira, and Slack integrations is done via the web UI, not the extension MVP
- **Job control actions** — Retry, cancel, assign, and priority changes on jobs are deferred; the MVP dashboard is read-only
- **Agent management** — The Agents tree view is registered but not populated in MVP
- **Billing management** — Handled by the generacy.ai web UI
- **Humancy decision queues** — Deferred to post-MVP per the full extension spec
- **Custom workflow templates** — Creating workflows from templates is post-MVP
- **Telemetry implementation** — The `generacy.telemetry.enabled` setting is defined but telemetry collection is not implemented in MVP
- **Sound notifications** — The `generacy.notifications.sound` setting is reserved for future use

---

*Generated by speckit*
