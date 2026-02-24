# Implementation Plan: Webhook Auto-Configuration for Smee

**Feature**: Auto-configure GitHub webhooks for monitored repositories when `SMEE_CHANNEL_URL` is set
**Branch**: `235-summary-when-smee-channel`
**Date**: 2026-02-24

## Summary

This feature adds automatic webhook configuration to the orchestrator CLI command. When `SMEE_CHANNEL_URL` is configured, the orchestrator will verify and auto-create GitHub webhooks for all monitored repositories on startup, eliminating the need for manual webhook configuration and ensuring near-instant label detection via Smee instead of relying on 15-minute polling fallback.

## Technical Context

**Language**: TypeScript
**Runtime**: Node.js 18+
**Primary Package**: `@generacy-ai/orchestrator`
**Key Dependencies**:
- `@generacy-ai/workflow-engine` (for `executeCommand` utility)
- `gh` CLI (for GitHub API access)
- `smee-client` (existing, for webhook proxying)
- `zod` (for type validation)

**Scope**: CLI only (`packages/generacy/src/cli/commands/orchestrator.ts`)
The `server.ts` Fastify path is **out of scope** per clarification Q1 — it uses direct webhook endpoints with HMAC verification, not Smee proxying.

## Architecture Overview

### Component Structure

```
packages/orchestrator/src/services/
├── webhook-setup-service.ts        # NEW: Orchestrates webhook verification/creation
└── smee-receiver.ts                # MODIFIED: Add exponential backoff reconnect

packages/generacy/src/cli/commands/
└── orchestrator.ts                 # MODIFIED: Integrate webhook setup on startup
```

### Data Flow

```
Startup Sequence (CLI path):
1. Parse CLI options and env vars
2. Create job queue (Redis or in-memory)
3. Setup label monitor if enabled
   └─> NEW: If SMEE_CHANNEL_URL set:
       a. Call WebhookSetupService.ensureWebhooks()
          ├─> For each repo in MONITORED_REPOS:
          │   ├─> gh api GET /repos/{owner}/{repo}/hooks
          │   ├─> Check if webhook exists for Smee URL
          │   ├─> If missing: POST /repos/{owner}/{repo}/hooks
          │   ├─> If inactive: PATCH to reactivate + merge events
          │   └─> Log result (created/skipped/failed)
          └─> Returns summary
       b. Start Smee receiver (with new exponential backoff)
       c. Start label monitor polling (reduced interval)
4. Start orchestrator HTTP server
5. Begin label monitoring
```

### Service Interface

```typescript
// WebhookSetupService
interface WebhookSetupService {
  ensureWebhooks(
    smeeChannelUrl: string,
    repositories: RepositoryConfig[]
  ): Promise<WebhookSetupSummary>;
}

interface WebhookSetupSummary {
  total: number;
  created: number;
  skipped: number;
  reactivated: number;
  failed: number;
  results: WebhookSetupResult[];
}

interface WebhookSetupResult {
  owner: string;
  repo: string;
  action: 'created' | 'skipped' | 'reactivated' | 'failed';
  webhookId?: number;
  error?: string;
}

// Minimal GitHub webhook types (only fields we need)
interface GitHubWebhook {
  id: number;
  active: boolean;
  config: {
    url: string;
  };
  events: string[];
}
```

## Implementation Phases

### Phase 1: Core Service Implementation

**Goal**: Create the `WebhookSetupService` with webhook verification and creation logic.

**Files**:
- `packages/orchestrator/src/services/webhook-setup-service.ts` (NEW)
- `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts` (NEW)
- `packages/orchestrator/src/services/index.ts` (MODIFIED: export new service)

**Tasks**:
1. **Create `WebhookSetupService` class**:
   - Constructor accepts pino-style logger
   - Main method: `ensureWebhooks(smeeChannelUrl, repositories)`
   - Private helper: `ensureWebhookForRepo(owner, repo, smeeChannelUrl)`
   - Private helper: `listRepoWebhooks(owner, repo)` — calls `gh api GET /repos/{owner}/{repo}/hooks`
   - Private helper: `createRepoWebhook(owner, repo, smeeChannelUrl)` — calls `gh api POST` with config
   - Private helper: `updateRepoWebhook(owner, repo, webhookId, updates)` — calls `gh api PATCH`

2. **Implement webhook matching logic**:
   - Case-insensitive URL comparison (Q6 answer A)
   - Match on `config.url` field only
   - No URL normalization (keep it simple)

3. **Implement reactivation with event merge** (Q5 answer C):
   - When reactivating inactive webhook, PATCH events to include `"issues"`
   - Merge existing events: `[...new Set([...existingEvents, "issues"])]`
   - Single PATCH call updates both `active: true` and `events`

4. **Implement warning on event mismatch** (Q16 answer B):
   - If existing webhook is active but events ≠ `["issues"]`, log warning
   - Example: `"Existing webhook has events [push] but expected [issues] — events not updated"`
   - No update performed (just visibility)

5. **Error handling** (Q7 + Q10):
   - Catch per-repo errors (403, 404, 500, network errors)
   - Log warning with `{ owner, repo, error }` and continue
   - Return `action: 'failed'` result with error message
   - No retries (Q10 answer A)
   - Graceful degradation: system falls back to polling

6. **Logging**:
   - Use pino-style: `logger.info({ owner, repo, action, webhookId }, msg)`
   - Log levels:
     - `info`: Created, skipped, reactivated webhooks
     - `warn`: Permission errors (403/404), event mismatches, non-Smee URLs
     - `error`: Unexpected API errors

7. **Smee URL validation warning** (Q18 answer C):
   - Check if URL starts with `https://smee.io/`
   - If not, log warning: `"SMEE_CHANNEL_URL does not point to smee.io — ensure this URL is correct"`
   - Continue with auto-config (support self-hosted proxies)

**Types** (minimal, Q3 answer A):
```typescript
interface GitHubWebhook {
  id: number;
  active: boolean;
  config: { url: string };
  events: string[];
}
```

**Testing**:
- Unit tests with mocked `executeCommand` for `gh api` calls
- Test cases:
  - No webhooks → create new
  - Matching webhook active → skip
  - Matching webhook inactive → reactivate + merge events
  - Permission error (403) → warn and continue
  - Non-smee URL → warn but proceed
  - Event mismatch → warn but don't update
  - Network error → fail gracefully

### Phase 2: Smee Receiver Exponential Backoff

**Goal**: Improve Smee reconnection behavior to reduce log noise during extended outages.

**Files**:
- `packages/orchestrator/src/services/smee-receiver.ts` (MODIFIED)
- `packages/orchestrator/src/services/__tests__/smee-receiver.test.ts` (MODIFIED if tests exist)

**Tasks**:
1. **Add exponential backoff state**:
   - Track `reconnectAttempt` counter
   - Calculate delay: `Math.min(reconnectDelayMs * Math.pow(2, attempt), MAX_BACKOFF_MS)`
   - Max backoff: 5 minutes (300,000 ms)
   - Reset attempt counter on successful connection

2. **Update reconnection loop**:
   ```typescript
   const baseDelay = 5000;
   const maxDelay = 300000;
   let attempt = 0;

   while (this.running && !signal.aborted) {
     try {
       await this.connect(signal);
       attempt = 0; // Reset on success
     } catch (error) {
       if (signal.aborted) break;
       const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
       this.logger.warn(
         { err: String(error), reconnectMs: delay, attempt },
         'Smee connection lost, reconnecting...',
       );
       attempt++;
       await this.sleep(delay, signal);
     }
   }
   ```

3. **Update constructor options**:
   - Rename `reconnectDelayMs` → `baseReconnectDelayMs` for clarity
   - Default: 5000 ms
   - Document exponential backoff behavior

**Testing**:
- Verify backoff progression: 5s → 10s → 20s → 40s → 80s → 160s → 300s (capped)
- Verify reset after successful connection

### Phase 3: CLI Integration

**Goal**: Wire `WebhookSetupService` into the CLI orchestrator command startup sequence.

**Files**:
- `packages/generacy/src/cli/commands/orchestrator.ts` (MODIFIED)

**Tasks**:
1. **Update `setupLabelMonitor` function** (lines 193-314):
   - After creating `monitor` service (line 286), add webhook setup:
   ```typescript
   // Auto-configure webhooks if Smee is enabled
   if (useSmee) {
     const { WebhookSetupService } = await import('@generacy-ai/orchestrator');
     const webhookSetup = new WebhookSetupService(monitorLogger);

     try {
       const summary = await webhookSetup.ensureWebhooks(smeeChannelUrl, repositories);
       logger.info(
         {
           total: summary.total,
           created: summary.created,
           skipped: summary.skipped,
           reactivated: summary.reactivated,
           failed: summary.failed,
         },
         'Webhook auto-configuration complete',
       );
     } catch (error) {
       logger.warn(
         { error: String(error) },
         'Webhook auto-configuration failed (falling back to polling)',
       );
     }
   }
   ```

2. **Startup ordering** (Q7 answer A):
   - Webhook setup runs **after** monitor service creation
   - Webhook setup runs **before** Smee receiver start (line 157-161)
   - Blocking with no timeout (MONITORED_REPOS is small, bounded list)
   - Per-repo errors don't block the whole sequence

3. **No config schema changes** (Q4 answer B):
   - Continue reading `SMEE_CHANNEL_URL` from `process.env` directly (line 230)
   - Pass as parameter to `WebhookSetupService`
   - No changes to `MonitorConfigSchema` or `loader.ts`

**Testing**:
- Manual verification: Start CLI with `SMEE_CHANNEL_URL` set
- Check logs for webhook creation/skip messages
- Verify Smee receiver starts after webhook setup
- Verify graceful degradation when setup fails

### Phase 4: Documentation and Types

**Goal**: Update exports and add inline documentation.

**Files**:
- `packages/orchestrator/src/services/index.ts` (MODIFIED)
- `packages/orchestrator/src/types/index.ts` (MODIFIED: add webhook types)

**Tasks**:
1. **Export new service**:
   ```typescript
   export { WebhookSetupService } from './webhook-setup-service.js';
   export type {
     WebhookSetupSummary,
     WebhookSetupResult,
   } from './webhook-setup-service.js';
   ```

2. **Add webhook types to `types/index.ts`**:
   ```typescript
   export interface GitHubWebhook {
     id: number;
     active: boolean;
     config: { url: string };
     events: string[];
   }
   ```

3. **JSDoc comments**:
   - Add comprehensive JSDoc to `WebhookSetupService` public methods
   - Document error handling behavior
   - Document graceful degradation strategy

## Key Technical Decisions

### Decision 1: CLI-Only Scope
**Rationale**: Per Q1 clarification, `server.ts` uses direct webhook endpoints with HMAC verification (fundamentally different from Smee proxying). Adding webhook auto-config there would create webhooks pointing to a Smee URL nobody's listening on. Keep scope tight to the CLI path where Smee actually runs.

### Decision 2: Direct `gh api` Calls (No GitHubClient Extension)
**Rationale**: Per Q2 clarification, webhook management is an orchestrator concern, not workflow-engine. Adding methods to `GitHubClient` interface forces all implementations to support webhooks, even when irrelevant to workflow execution. Use `executeCommand` utility to call `gh api` directly, keeping webhook logic self-contained in orchestrator package.

### Decision 3: Minimal Webhook Types
**Rationale**: Per Q3 clarification, define only fields needed for matching/reactivation (`id`, `active`, `config.url`, `events`). Simpler to maintain, sufficient for the feature, not building a general-purpose GitHub SDK.

### Decision 4: Keep as Env Var (No Config Schema)
**Rationale**: Per Q4 clarification, `SMEE_CHANNEL_URL` is already read from `process.env` in CLI. The `MonitorConfigSchema` is primarily used by `server.ts` / config loader, which doesn't use Smee. Avoid touching schema/loader/types for something only CLI consumes. Pass as parameter instead.

### Decision 5: Reactivate + Merge Events
**Rationale**: Per Q5 clarification, when reactivating an inactive webhook, also ensure `"issues"` event is included. Merge with existing events to avoid clobbering manual configuration. Prevents silent failure where webhook is active but doesn't deliver label events.

### Decision 6: Case-Insensitive String Comparison
**Rationale**: Per Q6 clarification, Smee URLs are machine-generated and consistent. Normalized URL parsing adds complexity for edge cases unlikely in practice. If trailing slash mismatch causes duplicate webhook, worst case is two webhooks to same channel (harmless, obvious to debug).

### Decision 7: Blocking Startup with No Timeout
**Rationale**: Per Q7 clarification, `MONITORED_REPOS` is small (<10 repos). GitHub API calls are fast (sub-second). Per-repo error handling means failures don't stall the sequence. Deterministic ordering (setup → Smee starts) is simpler than async with timeout. The cost of waiting 1-2 seconds at startup is negligible.

### Decision 8: Pino-Style Logger
**Rationale**: Per Q8 clarification, all orchestrator services use Pino-style logging (`logger.info(obj, msg)`). The CLI's `monitorLogger` adapter already translates this to CLI logger format. Consistency across services > simplicity.

### Decision 9: Unit Tests with Mocked Commands
**Rationale**: Per Q9 clarification, mock `executeCommand` / `gh api` calls and test main code paths (create, skip, reactivate, permission error, network error). Integration tests against real GitHub API are brittle. Existing test patterns in `packages/orchestrator/tests/unit/services/` provide clear examples.

### Decision 10: Treat All Errors as Best-Effort Warnings
**Rationale**: Per Q10 clarification, webhook setup is a startup convenience, not critical path. System degrades gracefully to polling regardless. Retry logic with backoff adds complexity for minimal benefit. Log warning, move on. If GitHub is having 500s at startup, likely resolved by next restart.

### Decision 11: Exponential Backoff for Smee Reconnect
**Rationale**: Per Q15 clarification, infinite retry with fixed 5s delay fills logs during extended Smee outages. Exponential backoff (5s → 10s → 20s → ... → capped at 5min) reduces noise while still retrying. Polling covers the gap. Minor improvement that pays for itself in log readability.

### Decision 12: Warn on Event Mismatch
**Rationale**: Per Q16 clarification, silent skip when existing webhook has wrong events risks confusing failure mode. Warning log like `"Existing webhook has events [push] but expected [issues]"` costs nothing, saves debugging time. No update performed (just visibility).

### Decision 13: Warn on Non-Smee URLs
**Rationale**: Per Q18 clarification, accept any URL to support self-hosted smee-client proxies or alternatives (webhook.site for debugging). Log warning if domain isn't `smee.io` to catch typos. Catches misconfigurations without blocking legitimate use cases.

## API Contracts

### GitHub API Endpoints Used

```yaml
# List repository webhooks
GET /repos/{owner}/{repo}/hooks
Response:
  - id: number
    active: boolean
    events: string[]
    config:
      url: string

# Create webhook
POST /repos/{owner}/{repo}/hooks
Body:
  config:
    url: string
    content_type: "json"
    secret?: string
  events: ["issues"]
  active: true
Response:
  id: number

# Update webhook
PATCH /repos/{owner}/{repo}/hooks/{hook_id}
Body:
  active?: boolean
  events?: string[]
```

### Service Interface

```typescript
class WebhookSetupService {
  constructor(logger: Logger);

  /**
   * Ensure webhooks exist for all repositories.
   * Creates missing webhooks, reactivates inactive ones, and merges events.
   * Errors per-repo are logged and don't block the overall process.
   */
  async ensureWebhooks(
    smeeChannelUrl: string,
    repositories: RepositoryConfig[]
  ): Promise<WebhookSetupSummary>;
}
```

## Data Models

### Minimal GitHub Webhook Type

```typescript
/**
 * Minimal GitHub webhook response type.
 * Only includes fields needed for matching and reactivation.
 */
interface GitHubWebhook {
  /** Webhook ID */
  id: number;
  /** Whether webhook is active */
  active: boolean;
  /** Webhook configuration */
  config: {
    /** Target URL */
    url: string;
  };
  /** Event types webhook subscribes to */
  events: string[];
}
```

### Webhook Setup Result Types

```typescript
interface WebhookSetupSummary {
  /** Total repositories checked */
  total: number;
  /** Webhooks created */
  created: number;
  /** Webhooks skipped (already exist) */
  skipped: number;
  /** Webhooks reactivated */
  reactivated: number;
  /** Repositories that failed */
  failed: number;
  /** Per-repository results */
  results: WebhookSetupResult[];
}

interface WebhookSetupResult {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Action taken */
  action: 'created' | 'skipped' | 'reactivated' | 'failed';
  /** Webhook ID (if applicable) */
  webhookId?: number;
  /** Error message (if action === 'failed') */
  error?: string;
}
```

## Risk Mitigation

### Risk 1: GitHub API Rate Limiting
**Impact**: High (blocks all webhook setup)
**Likelihood**: Low (startup operations are infrequent)
**Mitigation**:
- Per-repo error handling ensures partial success
- Graceful degradation to polling
- 429 errors logged as warnings, no special retry logic
- Documented in logs: "Webhook setup failed (falling back to polling)"

### Risk 2: Insufficient GitHub Token Permissions
**Impact**: Medium (webhooks can't be created)
**Likelihood**: Medium (requires `admin:repo_hook` scope)
**Mitigation**:
- 403/404 errors logged as warnings, not fatal
- Log message includes: "Insufficient permissions (admin:repo_hook required)"
- System degrades gracefully to polling
- Clear error message guides operator to fix token scopes

### Risk 3: Duplicate Webhooks from URL Mismatch
**Impact**: Low (duplicate delivery, dedup handles it)
**Likelihood**: Low (smee URLs are consistent)
**Mitigation**:
- Case-insensitive URL comparison catches most mismatches
- Dedup in `processLabelEvent()` prevents double-processing
- Worst case: two webhooks deliver same event → Redis dedup suppresses second
- Obvious in logs / webhook settings

### Risk 4: Smee.io Outage Extends Startup Time
**Impact**: Low (brief startup delay)
**Likelihood**: Low (smee.io is stable)
**Mitigation**:
- Webhook setup runs before Smee receiver starts (deterministic ordering)
- Fast per-repo failure (gh CLI has built-in timeouts)
- No artificial timeout added (keeps logic simple)
- If smee.io is down, webhook creation succeeds but receiver fails → polling takes over

### Risk 5: Breaking Changes to `gh api` Output Format
**Impact**: Medium (parsing fails)
**Likelihood**: Low (GitHub API is stable)
**Mitigation**:
- Minimal type definitions reduce surface area for breakage
- JSON parsing errors caught per-repo, logged as warnings
- If parsing fails, action: 'failed', system continues
- Future: Add integration test against live GitHub API (out of scope for now)

### Risk 6: Log Noise from Repeated Smee Reconnections
**Impact**: Low (log spam)
**Likelihood**: Medium (during Smee outages)
**Mitigation**:
- Exponential backoff (Phase 2) reduces log frequency
- 5s → 10s → 20s → ... → 5min (capped)
- Log level: `warn` (not `error`) — operational, not critical
- Polling continues regardless (no functional impact)

## Success Criteria

### Functional Requirements

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-001 | Verify existing webhooks on startup | For each repo in `MONITORED_REPOS`, check `GET /repos/{owner}/{repo}/hooks` for matching Smee URL |
| FR-002 | Create missing webhooks | If no matching webhook, `POST /repos/{owner}/{repo}/hooks` with Smee URL, `events: ["issues"]`, `active: true` |
| FR-003 | Reactivate inactive webhooks | If matching webhook exists but `active: false`, `PATCH` to set `active: true` and merge `"issues"` into events |
| FR-004 | Graceful permission errors | 403/404 errors logged as warnings, don't block startup, system falls back to polling |
| FR-005 | Log structured results | Each repo result logged with `{ owner, repo, action, webhookId? }` at `info` level |
| FR-006 | Warn on event mismatch | If existing webhook has different events, log warning but don't update |
| FR-007 | Warn on non-Smee URLs | If `SMEE_CHANNEL_URL` doesn't start with `https://smee.io/`, log warning |
| FR-008 | Exponential backoff | Smee reconnection uses exponential backoff (5s → 10s → 20s → ... → 5min cap) |

### Non-Functional Requirements

| ID | Requirement | Target | Measurement |
|----|-------------|--------|-------------|
| NFR-001 | Startup time impact | < 3 seconds for 10 repos | Manual timing with `time` command |
| NFR-002 | Error isolation | Webhook setup failures don't block orchestrator startup | Log verification |
| NFR-003 | Log clarity | Structured logs with `owner`, `repo`, `action` fields | Log inspection |
| NFR-004 | Test coverage | Unit tests for create/skip/reactivate/error paths | Jest coverage report |

## Testing Strategy

### Unit Tests (Phase 1 & 2)

**File**: `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`

Test cases:
1. **No webhooks exist** → creates new webhook, returns `action: 'created'`
2. **Matching webhook active** → skips, returns `action: 'skipped'`
3. **Matching webhook inactive** → reactivates + merges events, returns `action: 'reactivated'`
4. **Permission error (403)** → logs warning, returns `action: 'failed'` with error message
5. **Non-Smee URL** → logs warning, proceeds with creation
6. **Event mismatch** → logs warning, skips update, returns `action: 'skipped'`
7. **Network error (500)** → logs warning, returns `action: 'failed'`
8. **Multiple repos** → processes all, returns summary with aggregate counts

**File**: `packages/orchestrator/src/services/__tests__/smee-receiver.test.ts` (if exists, else skip)

Test cases:
1. **Connection failure** → exponential backoff progression (5s → 10s → 20s)
2. **Successful reconnection** → resets backoff attempt counter
3. **Max backoff cap** → doesn't exceed 5 minutes

Mock strategy:
- Mock `executeCommand` from `@generacy-ai/workflow-engine`
- Return canned JSON responses for `gh api` calls
- Assert correct arguments passed to `executeCommand`

### Integration Testing (Manual, Phase 3)

1. **Start CLI with Smee** (new webhook):
   ```bash
   export SMEE_CHANNEL_URL=https://smee.io/test123
   export MONITORED_REPOS=owner/repo1
   pnpm exec generacy orchestrator --label-monitor
   ```
   - Verify log: `"Webhook auto-configuration complete"` with `created: 1`
   - Check GitHub settings: webhook exists at `https://smee.io/test123`, events `["issues"]`

2. **Start CLI with existing webhook**:
   - Re-run above command
   - Verify log: `created: 0, skipped: 1`

3. **Start CLI with inactive webhook**:
   - Manually disable webhook in GitHub settings
   - Re-run command
   - Verify log: `reactivated: 1`
   - Check GitHub: webhook is active again

4. **Start CLI with insufficient permissions**:
   - Use token without `admin:repo_hook` scope
   - Verify log: `failed: 1` with "Insufficient permissions" warning
   - Verify orchestrator continues startup

5. **Start CLI with non-Smee URL**:
   ```bash
   export SMEE_CHANNEL_URL=https://webhook.site/test
   ```
   - Verify log: warning about non-smee.io URL
   - Verify webhook created anyway

## Implementation Timeline

| Phase | Tasks | Estimated Effort | Dependencies |
|-------|-------|------------------|--------------|
| Phase 1 | Core service + tests | 4-6 hours | None |
| Phase 2 | Smee backoff | 1-2 hours | None |
| Phase 3 | CLI integration | 1-2 hours | Phase 1 |
| Phase 4 | Docs + exports | 30 minutes | Phase 1-3 |
| **Total** | | **~8 hours** | |

## Rollout Plan

1. **Merge to develop branch**
2. **Deploy to staging environment**
3. **Manual verification**:
   - Start orchestrator with new `SMEE_CHANNEL_URL`
   - Verify webhooks created
   - Add label to test issue, verify < 5s detection
4. **Production deployment**:
   - Update orchestrator deployment config with `SMEE_CHANNEL_URL`
   - Restart orchestrator
   - Monitor logs for successful webhook setup
   - Verify label detection latency reduced from 15min → < 5s

## Rollback Plan

If issues arise:
1. **Remove `SMEE_CHANNEL_URL` env var** → orchestrator reverts to polling-only mode
2. **Manually delete auto-created webhooks** in GitHub repo settings (if desired)
3. **Revert feature branch** merge if code issues detected

No data loss risk — webhook auto-config is idempotent and non-destructive.

## Out of Scope

Per specification and clarifications:

1. **`server.ts` integration** — uses direct webhooks, not Smee (Q1)
2. **GitHubClient interface extension** — webhook methods stay in orchestrator (Q2)
3. **Config schema changes** — keep `SMEE_CHANNEL_URL` as env var (Q4)
4. **Webhook secret for Smee** — set if available, but not enforced (Q12)
5. **PR feedback events via Smee** — only `issues` events for now (Q13)
6. **Redis initialization ordering** — CLI has no Redis dependency (Q14)
7. **Smee receiver max retries** — exponential backoff, no max limit (Q15)
8. **Integration tests for server.ts** — CLI-only scope (Q17)
9. **Strict Smee URL validation** — warn but allow alternatives (Q18)

## Open Questions

None — all clarification questions have been answered.

---

*Generated by Claude Code on 2026-02-24*
