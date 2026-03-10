# Implementation Plan: 5.2 — Generacy VS Code Extension MVP

**Branch**: `250-5-2-generacy-vs` | **Date**: 2026-02-27 | **Status**: Draft

---

## Summary

The VS Code extension scaffolding in `packages/generacy-extension/` is **substantially implemented**. The core services — authentication (OAuth + token management), API client (HTTP + retry + validation), SSE subscription manager (channel routing + reconnection), queue tree provider, agent tree provider, orchestrator dashboard webview, job detail panel, log streaming, and notifications — all exist with production-quality implementations.

The remaining work falls into **three categories**:

1. **New functionality**: Project config detection (`.generacy/config.yaml` parsing), `waiting` queue status support, user profile API endpoint, project-scoped notification filtering
2. **Integration gaps**: Connecting the org-scoped SSE endpoint path (per Q1 clarification), wiring the `waiting` status into dashboard/notifications/tree views
3. **Polish and packaging**: `.vscodeignore` tuning, README marketplace content verification, build validation, test coverage for new code

**Estimated scope**: ~15 files modified, ~5 new files created, ~1,200 lines of new code.

---

## Technical Context

| Aspect | Detail |
|--------|--------|
| Language | TypeScript (strict mode, ES2022 target) |
| Runtime | Node.js (VS Code extension host) |
| Build | esbuild (CommonJS output, `dist/extension.js`) |
| Test | Vitest with V8 coverage |
| Package Manager | pnpm |
| VS Code Engine | `^1.108.0` |
| Key APIs | VS Code Extension API (SecretStorage, URI Handler, Webview, TreeView) |
| Validation | Zod schemas for all API responses |
| Patterns | Singleton services, Disposable cleanup, EventEmitter state changes |

### Key Dependencies (already in package.json)
- `vscode` (extension API)
- `zod` (runtime validation)
- `yaml` (YAML parsing — verify if present, may need to add)

---

## Architecture Overview

The extension follows a layered architecture that is already established:

```
Extension Entry (extension.ts)
├── Services Layer
│   ├── AuthService (singleton) — OAuth, token management, tier detection
│   ├── ProjectConfigService (NEW) — .generacy/config.yaml parsing
│   ├── SSESubscriptionManager (singleton) — real-time events
│   └── JobNotificationService — notification delivery
├── API Layer
│   ├── ApiClient (singleton) — HTTP with retry/interceptors
│   └── Endpoints (queue, orgs, agents, activity, user [NEW])
├── Views Layer
│   ├── Queue TreeProvider — sidebar job list
│   ├── Agent TreeProvider — sidebar agent list
│   ├── Orchestrator Dashboard — full webview panel
│   ├── Orchestrator Sidebar — compact summary webview
│   ├── Job Detail Panel — per-job webview
│   └── Log Channel — output channel with SSE streaming
├── Providers Layer
│   ├── StatusBarProvider — auth state + project name display
│   └── CloudJobStatusBarProvider — job count + flash notifications
└── Commands Layer
    └── Cloud commands — sign in/out, dashboard, job actions
```

### What's New (this implementation)

```
NEW: ProjectConfigService
  ├── Parses .generacy/config.yaml → { projectId, projectName, reposPrimary }
  ├── Zod schema validation
  ├── FileSystemWatcher for hot reload
  └── Status bar integration (project name display)

NEW: User Profile Endpoint
  └── GET /users/me → { id, username, orgs[], tier }

MODIFIED: QueueStatus type
  └── Add 'waiting' to union type + Zod schema

MODIFIED: Dashboard webview
  └── Add "Waiting for Input" summary card + list section

MODIFIED: Notification service
  └── Add 'waiting' event handling + project-scope filtering

MODIFIED: SSE Manager
  └── Update endpoint path to org-scoped format

MODIFIED: Status bar
  └── Show project name from config
```

---

## Implementation Phases

### Phase 1: Project Config Detection (US3)

**Goal**: Parse `.generacy/config.yaml`, validate with Zod, display project name in status bar, watch for changes.

#### Files to Create

**1. `src/services/project-config-service.ts`** (~200 lines)

```typescript
// Responsibilities:
// - Parse .generacy/config.yaml from first workspace folder
// - Validate against Zod schema (ProjectConfigSchema)
// - Emit change events when config changes
// - Provide getters: projectId, projectName, reposPrimary, orgId (if present)
// - FileSystemWatcher for .generacy/config.yaml
// - Graceful fallback when no config exists (isConfigured = false)

export interface ProjectConfig {
  project: {
    id: string;
    name: string;
  };
  repos?: {
    primary?: string;
  };
}

export class ProjectConfigService implements vscode.Disposable {
  private config: ProjectConfig | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<ProjectConfig | undefined>();
  readonly onDidChange = this._onDidChange.event;

  // Singleton, initialize on activation
  // Parse YAML, validate with Zod
  // Set up FileSystemWatcher for .generacy/config.yaml
  // Emit events on change
}
```

**Key decisions**:
- Use the `yaml` npm package for YAML parsing (add as dependency if not present)
- Watch pattern: `**/.generacy/config.yaml` in first workspace folder (single workspace per Q6)
- Graceful fallback: `isConfigured` flag, cloud views hidden when false
- Config stored in memory (not persisted — re-parsed on activation)

#### Files to Modify

**2. `src/providers/status-bar.ts`** — Add project name display

- Add a third status bar item (or extend existing) showing project name
- Subscribe to `ProjectConfigService.onDidChange` to update display
- Format: `$(project) MyProject` when config detected, hidden when not

**3. `src/extension.ts`** — Initialize ProjectConfigService

- Create and initialize `ProjectConfigService` during activation
- Pass to status bar provider
- Set context key `generacy.hasProjectConfig` for `when` clause gating
- Dispose on deactivation

**4. `src/constants.ts`** — Add new context keys

- Add `CONTEXT_KEYS.hasProjectConfig`
- Add `CONFIG_KEYS.projectConfig` (if needed)

#### Tests

**5. `src/services/__tests__/project-config-service.test.ts`** (~150 lines)

- Valid config parsing
- Missing config file (graceful fallback)
- Invalid config (Zod validation error → warning)
- Config change detection (mock FileSystemWatcher)

---

### Phase 2: `waiting` Queue Status (US4, US7)

**Goal**: Add `waiting` as a first-class queue status throughout the type system, dashboard, tree views, and notifications.

#### Files to Modify

**1. `src/api/types.ts`** — Extend QueueStatus

```typescript
// Before:
export type QueueStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// After:
export type QueueStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
```

- Update `QueueItemSchema` z.enum to include `'waiting'`
- Add optional `waitingFor?: string` field to `QueueItem` interface and schema
- Add `waiting` to any status-related display mappings

**2. `src/views/cloud/orchestrator/webview.ts`** — Add waiting to dashboard

- Add `waiting: number` to `QueueStats` interface
- Add "Waiting for Input" summary card in the stats grid
- Add "Waiting for Input" list section below the stats (similar to active jobs list)
- Show: issue reference, waiting label (`waitingFor`), time waiting, "View Job" link
- Style with warning color theme variable

**3. `src/views/cloud/orchestrator/panel.ts`** — Compute waiting stats

- When computing `queueStats` from queue items, count `status === 'waiting'` separately
- Forward waiting items to webview

**4. `src/views/cloud/orchestrator/sidebar-view.ts`** — Show waiting count

- Add waiting count to sidebar summary text
- Highlight waiting count if > 0

**5. `src/views/cloud/queue/provider.ts`** — Support waiting status in tree view

- Add `waiting` to the `byStatus` grouping
- Ensure `waiting` items appear with appropriate icon (e.g., `$(bell)` or `$(question)`)
- Group waiting items prominently when using default sort

**6. `src/views/cloud/queue/tree-item.ts`** — Waiting item display

- Add icon and color for `waiting` status
- Show `waitingFor` label as description text

**7. `src/services/job-notification-service.ts`** — Waiting notifications

- Subscribe to `queue:updated` events where status transitions to `waiting`
- Show `vscode.window.showWarningMessage` with "View Job" action
- Respect `generacy.notifications.enabled` setting
- Add `waiting` to the deduplication logic

#### Tests

- Update existing tests in `src/views/cloud/queue/__tests__/` for `waiting` status
- Update `src/services/__tests__/job-notification-service.test.ts` for waiting notifications

---

### Phase 3: User Profile & Org Resolution (US2, Q7)

**Goal**: Add `/users/me` endpoint, fetch user profile + org memberships after auth, derive orgId for API calls.

#### Files to Create

**1. `src/api/endpoints/user.ts`** (~80 lines)

```typescript
// GET /users/me → UserProfile
// Returns: { id, username, displayName, email, avatarUrl, tier, organizations: [{ id, name, role }] }

export interface UserOrg {
  id: string;
  name: string;
  role: string;
}

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
  tier: string;
  organizations: UserOrg[];
}

export async function getUserProfile(): Promise<UserProfile> { ... }
```

#### Files to Modify

**2. `src/api/auth.ts`** — Fetch profile after token exchange

- After successful `exchangeCodeForTokens()`, call `getUserProfile()` to get org memberships
- Store `organizationId` from the first (or primary) org in the profile
- If user has multiple orgs, use the org matching the project config's `project.id` (server resolves this)
- Update the `User` type to include `organizations` array

**3. `src/api/types.ts`** — Extend User type

- Add `organizations?: UserOrg[]` to `User` interface
- Add corresponding Zod schema fields

---

### Phase 4: SSE Endpoint & Project Scoping (Q1, Q9, Q10)

**Goal**: Update SSE connection to org-scoped endpoint, filter notifications and tree view by project.

#### Files to Modify

**1. `src/api/sse.ts`** — Update endpoint path

- Change connection URL from `{baseUrl}/events` to `{baseUrl}/api/orgs/{orgId}/orchestrator/events`
- Keep channel-based subscription (`?channels=...`) per Q1 (hybrid approach)
- Keep Bearer header auth per Q14
- `orgId` provided by AuthService after profile fetch

**2. `src/commands/cloud.ts` / `src/extension.ts`** — Pass orgId to SSE

- After auth state change, retrieve `orgId` from auth service
- Pass to SSE manager `connect()` call
- Disconnect SSE when auth state clears

**3. `src/services/job-notification-service.ts`** — Project-scoped filtering (Q9)

- Accept `ProjectConfigService` in constructor
- When handling `queue:updated` events, check if `queueItem.repository` or associated project matches `projectConfig.projectId`
- Skip notifications for non-matching jobs
- If no project config, show all notifications (fallback)

**4. `src/views/cloud/queue/provider.ts`** — Project-scoped default filter (Q10)

- Accept `ProjectConfigService` in constructor
- Default filter: show items matching current project
- "Show All Org Jobs" toggle to remove project filter

---

### Phase 5: Dashboard Polish & Waiting-for-Input UX (US4, US5)

**Goal**: Ensure the dashboard webview properly renders all spec requirements including waiting-for-input jobs.

#### Files to Modify

**1. `src/views/cloud/orchestrator/webview.ts`** — Dashboard HTML updates

- **Summary cards**: Active (running), Waiting, Completed (7d), Failed (7d)
  - Note: existing cards show Pending/Running/Completed/Failed. Change "Pending" → "Active" label, add "Waiting" card
- **Active jobs list**: Issue reference, repo, current phase, elapsed time
  - Verify this is rendered (existing implementation may already have this)
- **Waiting-for-input list**: Issue reference, wait label, time waiting, "View" link
  - New section — render from queue items with `status === 'waiting'`
- **Connection status indicator**: Connected / Reconnecting / Disconnected
  - Already exists in the webview. Verify it reflects SSE state accurately.

**2. `src/views/cloud/queue/detail-panel.ts`** — Job detail view validation

- Verify: phase progress timeline (FR-040) ✓ (already implemented)
- Verify: label badges (FR-041) — check if implemented, add if missing
- Verify: recent activity log (FR-042) ✓ (already implemented)
- Verify: branch/PR links (FR-043) ✓ (already implemented)
- Verify: real-time SSE updates (FR-044) ✓ (already implemented)

**3. `src/views/cloud/queue/detail-html.ts`** — Add label badges if missing

- Add `labels` field rendering as styled badge elements
- Style with VS Code theme colors

---

### Phase 6: Live Log Streaming Validation (US6)

**Goal**: Verify and fix the log streaming implementation against spec requirements.

The `JobLogChannel` in `src/views/cloud/log-viewer/log-channel.ts` is already implemented with:
- Historical log fetch via REST with cursor pagination ✓
- SSE-based live streaming ✓
- Zero-gap cursor handoff ✓
- Connection status ✓

#### Files to Modify (if needed)

**1. `src/views/cloud/log-viewer/log-channel.ts`** — Verify/fix

- Confirm auto-scroll behavior (Output Channel handles this natively)
- Confirm `Last-Event-ID` replay on reconnection
- Verify connection status indicator display
- Add `View Logs` action to queue tree items (context menu) if not present

**2. `src/views/cloud/queue/tree-item.ts`** — Ensure "View Logs" context action

- Verify `contextValue` includes appropriate value for "View Logs" context menu
- Check `package.json` `menus.view/item/context` for the log command binding

---

### Phase 7: Notifications Verification (US7)

**Goal**: Verify notification delivery for all terminal states + waiting, with project scoping.

The `JobNotificationService` is already implemented with:
- Completion/failure/cancellation notifications ✓
- Deduplication ✓
- Rate limiting ✓
- Focus batching ✓
- Configurable settings ✓

#### Files to Modify

**1. `src/services/job-notification-service.ts`** — Add waiting notification

- Handle `queue:updated` with `status === 'waiting'`
- Show `vscode.window.showWarningMessage` with summary (e.g., "Job X is waiting for clarification")
- "View Job" action button → opens job detail panel
- Integrate project-scope filtering from Phase 4

---

### Phase 8: Packaging & Build Verification (US1)

**Goal**: Ensure the extension builds, packages, and installs cleanly.

#### Tasks

1. **Verify build**: `pnpm build` produces `dist/extension.js` without errors
2. **Verify tests**: `pnpm test` passes (update/add tests for new code)
3. **Verify `.vscodeignore`**: Excludes test files, source maps (in prod), node_modules
4. **Verify `package.json` metadata**: Icon, publisher, categories, keywords, engines
5. **Verify README.md**: Marketplace-ready content, feature screenshots (placeholder OK)
6. **Package**: `vsce package` produces a valid `.vsix` file
7. **Install test**: Side-load `.vsix` into VS Code, verify activation and basic functionality
8. **Add `yaml` dependency**: If not already present, add `yaml` package for config parsing

---

## API Contracts

### New: GET /users/me

```yaml
# Fetches the current user's profile and org memberships
# Called after successful OAuth token exchange
GET /users/me
Authorization: Bearer <access_token>

Response 200:
  id: string
  username: string
  displayName: string
  email: string
  avatarUrl: string | null
  tier: "anonymous" | "free" | "organization"
  organizations:
    - id: string
      name: string
      role: "owner" | "admin" | "member"

Response 401:
  error: "unauthorized"
  message: "Invalid or expired token"
```

### Modified: SSE Endpoint (per Q1 hybrid approach)

```yaml
# Org-scoped SSE endpoint with channel-based subscription
GET /api/orgs/:orgId/orchestrator/events?channels=queue,workflows,agents,jobs
Authorization: Bearer <access_token>
Last-Event-ID: <ulid>  # Optional, for replay

Response: text/event-stream
Events:
  - connected: { connectionId: string }
  - reconnected: { missedEvents: number }
  - queue:item:added: { item: QueueItem }
  - queue:item:removed: { id: string }
  - queue:updated: { item: QueueItem }
  - workflow:progress: { jobId: string, progress: QueueItemProgressSummary }
  - workflow:phase:start: { jobId: string, phase: string }
  - workflow:phase:complete: { jobId: string, phase: string, duration: number }
  - workflow:step:complete: { jobId: string, step: string, status: string }
  - agent:connected: { agent: Agent }
  - agent:disconnected: { agentId: string }
  - agent:status: { agentId: string, status: string }
  - job:log: { jobId: string, content: string, stream: string, timestamp: string }
  - job:step-start: { jobId: string, step: string }
  - job:log:end: { jobId: string, status: string }
  - : heartbeat (comment, every 30s)

Error Responses:
  401: Unauthorized (invalid token)
  403: Not an org member
  429: Too many connections (max 5 per user)
```

### Existing Endpoints (no changes)

- `POST /auth/token` — Exchange OAuth code for tokens
- `POST /auth/refresh` — Refresh access token
- `POST /auth/logout` — Invalidate refresh token
- `GET /orchestrator-jobs/status` — Queue summary counts
- `GET /orchestrator-jobs/queue` — List jobs with filtering
- `GET /orchestrator-jobs/queue/:jobId` — Job detail
- `GET /orchestrator-jobs/queue/:jobId/logs` — Historical logs with cursor pagination

---

## Data Models

See [data-model.md](./data-model.md) for complete type definitions.

Key additions:
- `ProjectConfig` — Zod-validated schema for `.generacy/config.yaml`
- `UserProfile` / `UserOrg` — User profile with org memberships
- `QueueStatus` extended with `'waiting'`
- `QueueItem` extended with `waitingFor?: string`

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SSE endpoint model | Hybrid (Q1) | Org-scoped path + channel subscriptions. Leverages existing channel routing code while adding multi-tenant org scoping. |
| SSE event namespaces | Code convention `workflow:*`, `queue:*` (Q2) | Already integrated throughout tree providers, SSE routing, debounce logic. No reason to change working code. |
| Auth URL | `api.generacy.ai/auth/github?client=vscode` (Q3) | Direct API OAuth, no unnecessary redirect through main site. |
| Dashboard UI | Both sidebar + panel (Q4) | Standard VS Code pattern. Sidebar for quick glance, panel for detail. |
| Webview tech | Plain HTML/CSS/JS (Q5) | Established pattern in codebase, no build step needed, VS Code Webview UI Toolkit deprecated. |
| Multi-workspace | Single workspace only (Q6) | MVP scope. First workspace folder's config used. |
| Org resolution | User profile API (Q7) | JWT fragile if org changes; config file leaks in public repos. API is authoritative. |
| Log streaming | Hybrid REST + SSE (Q8) | REST for historical bulk, SSE for real-time. Cursor-based zero-gap handoff already implemented. |
| Notification scope | Project-scoped (Q9) | Filter by `project.id` from config. Org-wide would be noisy for teams. |
| Queue vs Dashboard | Unified (Q10) | Tree view = project-scoped jobs, Dashboard = org-wide overview. |
| Offline behavior | Stale data + indicator (Q11) | "Last updated: X min ago" with exponential backoff retry. |
| Packaging | Package-ready, no publish (Q12) | This issue produces `.vsix`. CI/CD issue #243 handles `vsce publish`. |
| 429 handling | Warn + fallback to polling (Q13) | User must close other windows. Polling provides degraded but functional experience. |
| SSE auth | Bearer header (Q14) | Node.js supports custom headers. More secure than query param token. |
| Waiting status | First-class `QueueStatus` value (Q15) | Distinct UX treatment, separate dashboard section, specific notifications. |
| YAML parsing | `yaml` npm package | Standard, well-maintained. Used for `.generacy/config.yaml` parsing. |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Backend API endpoints not ready (blocked by generacy-cloud#93) | All API calls go through `ApiClient` with Zod validation. Extension gracefully handles 404/500 from missing endpoints. Use mock data during development. |
| CI/CD pipeline not ready (blocked by #243) | Produce `.vsix` locally. Manual marketplace upload as fallback. |
| SSE endpoint path change breaks existing connections | SSE manager already has reconnection logic. New path is backwards-compatible (just a URL change in config). |
| `waiting` status not yet supported by backend | Extension handles unknown statuses gracefully (Zod `.passthrough()`). Waiting items simply won't appear until backend returns them. |
| Config YAML schema drift | Zod schema with `.passthrough()` for forward compatibility. Warn on validation errors, don't block activation. |
| Token refresh race conditions | Already handled — auth service uses mutex-like pattern with `refreshPromise` dedup. |
| Multiple VS Code windows competing for SSE | Server enforces 5-connection limit. Extension falls back to polling on 429 (Q13). |

---

## File Change Summary

### New Files (~5)
| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/services/project-config-service.ts` | Parse + watch `.generacy/config.yaml` | ~200 |
| `src/services/__tests__/project-config-service.test.ts` | Unit tests for config service | ~150 |
| `src/api/endpoints/user.ts` | `GET /users/me` endpoint | ~80 |
| `specs/250-5-2-generacy-vs/data-model.md` | Data model documentation | ~150 |
| `specs/250-5-2-generacy-vs/research.md` | Technical decisions documentation | ~100 |

### Modified Files (~12)
| File | Change | Lines (est.) |
|------|--------|-------------|
| `src/api/types.ts` | Add `waiting` to QueueStatus, `waitingFor` field, UserOrg types | ~30 |
| `src/api/sse.ts` | Update endpoint path to org-scoped | ~15 |
| `src/api/auth.ts` | Fetch user profile after token exchange | ~25 |
| `src/api/endpoints/user.ts` | New file (counted above) | — |
| `src/extension.ts` | Initialize ProjectConfigService, pass to dependents | ~30 |
| `src/constants.ts` | Add context keys for project config | ~5 |
| `src/providers/status-bar.ts` | Show project name from config | ~30 |
| `src/views/cloud/orchestrator/webview.ts` | Add waiting stats card + waiting jobs list | ~80 |
| `src/views/cloud/orchestrator/panel.ts` | Compute waiting stats, pass to webview | ~20 |
| `src/views/cloud/orchestrator/sidebar-view.ts` | Show waiting count in sidebar | ~15 |
| `src/views/cloud/queue/provider.ts` | Project-scope filter, waiting status grouping | ~40 |
| `src/views/cloud/queue/tree-item.ts` | Waiting status icon + description | ~15 |
| `src/services/job-notification-service.ts` | Waiting notifications + project-scope filtering | ~50 |
| `package.json` | Add `yaml` dependency (if needed) | ~2 |

**Total estimated new/changed lines**: ~1,200

---

## Testing Strategy

| Area | Approach |
|------|----------|
| Project config parsing | Unit test with mock workspace and YAML files |
| Waiting status rendering | Unit test tree items and webview HTML generation |
| Notification filtering | Unit test with mock SSE events and project config |
| Auth + profile fetch | Unit test with mocked API responses |
| SSE endpoint change | Integration test verifying URL construction |
| Build & Package | `pnpm build && vsce package` in CI |
| Manual smoke test | Side-load `.vsix`, verify activation, sign in, view dashboard |

---

## Implementation Order

```
Phase 1: Project Config Detection     ← Foundation for project scoping
Phase 2: Waiting Queue Status          ← Type system change, cascading UI updates
Phase 3: User Profile & Org Resolution ← Required for org-scoped SSE
Phase 4: SSE Endpoint & Project Scoping ← Connects auth, config, SSE together
Phase 5: Dashboard Polish              ← Webview UI updates for waiting + summary cards
Phase 6: Log Streaming Validation      ← Verify existing implementation
Phase 7: Notifications Verification    ← Wire waiting + project scope into notifications
Phase 8: Packaging & Build             ← Final verification and .vsix output
```

Phases 1-3 can be partially parallelized (independent foundations). Phases 4-7 depend on 1-3. Phase 8 is the final validation pass.
