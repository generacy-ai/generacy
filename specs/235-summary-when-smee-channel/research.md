# Technical Research: Webhook Auto-Configuration

**Feature**: `235-summary-when-smee-channel`
**Date**: 2026-02-24

## Overview

This document captures technical research and analysis that informed the implementation approach for automatic GitHub webhook configuration when using Smee.io for webhook proxying.

## Existing Architecture Analysis

### Current Label Detection System

The label monitor uses a **hybrid webhook + polling approach**:

```
Without Webhook (polling only):
- Poll interval: 30 seconds (default)
- process:* labels: checked every cycle (2 labels × N repos)
- completed:* labels: checked every 3rd cycle (13 labels × N repos)
- Detection latency: 0-90 seconds (30s poll × 3 cycles)

With Smee Webhook:
- Webhook: near-instant detection via SSE (< 5 seconds)
- Polling: reduced to 5-minute fallback
- Detection latency: 0-5 seconds (webhook) or 0-15 minutes (fallback)
```

**Problem identified**: The `tetrad-development` repo has no webhook configured, so resume events (`completed:*` labels) take **up to 15 minutes** to detect (5min poll × 3 cycles). This created confusion when a workflow appeared stuck after adding `completed:clarification`.

### Smee.io Integration Points

**Current implementation** (`packages/orchestrator/src/services/smee-receiver.ts`):

1. **Connection**: Native `fetch()` with SSE (`Accept: text/event-stream`)
2. **Protocol**: Server-Sent Events (SSE) stream
3. **Event format**:
   ```typescript
   event: message
   data: {
     "x-github-event": "issues",
     "body": { /* GitHub webhook payload */ }
   }
   ```
4. **Filtering**: Only processes `issues.labeled` events for watched repos
5. **Reconnection**: Fixed 5-second delay on disconnect

**Observation**: The Smee receiver has no verification that the GitHub webhook actually exists. It silently degrades to polling if the webhook is missing.

### CLI vs Server Architecture

| Aspect | CLI (`orchestrator.ts`) | Server (`server.ts`) |
|--------|-------------------------|----------------------|
| Entry point | `generacy orchestrator` command | Fastify HTTP server |
| Webhook approach | Smee.io proxy via SSE | Direct endpoint with HMAC |
| Label monitor | Optional (`--label-monitor`) | Always enabled |
| Redis | Optional (job queue) | Required (full stack) |
| Auth | Token-based | OAuth + JWT |
| Use case | Development, single-tenant | Production, multi-tenant |

**Key finding**: The CLI and server paths have **fundamentally different webhook architectures**. The server uses direct webhook endpoints (`/webhooks/github`) with HMAC signature verification. The CLI uses Smee.io proxying with SSE. Auto-configuring webhooks to point at Smee in the server path would create webhooks nobody's listening to.

## GitHub API Investigation

### Webhook Management API

**Endpoints used**:
```bash
# List webhooks
gh api /repos/{owner}/{repo}/hooks

# Create webhook
gh api /repos/{owner}/{repo}/hooks \
  -f config[url]="https://smee.io/xxx" \
  -f config[content_type]="json" \
  -f events[]=issues \
  -F active=true

# Update webhook
gh api -X PATCH /repos/{owner}/{repo}/hooks/{hook_id} \
  -F active=true \
  -f events[]=issues
```

**Response format** (GET):
```json
[
  {
    "id": 123456789,
    "name": "web",
    "active": true,
    "events": ["issues", "push"],
    "config": {
      "url": "https://smee.io/abc123",
      "content_type": "json",
      "insecure_ssl": "0",
      "secret": "********"
    },
    "type": "Repository",
    "created_at": "2026-01-15T10:30:00Z",
    "updated_at": "2026-02-20T14:22:00Z"
  }
]
```

**Required permissions**: `admin:repo_hook` scope on the GitHub token.

**Rate limits**:
- Primary (GraphQL/REST): 5,000 req/hour for authenticated requests
- Secondary (REST search/etc): 30 req/hour (not applicable here)
- Webhook endpoints use primary bucket

**Error responses**:
- `403 Forbidden`: Insufficient permissions (need `admin:repo_hook`)
- `404 Not Found`: Repository doesn't exist or no access
- `422 Unprocessable Entity`: Validation error (e.g., invalid URL)
- `500/502/503`: Transient server errors

### Webhook Secret Behavior with Smee

**Research question**: Should webhook secrets be configured on Smee-proxied webhooks?

**Findings**:
1. GitHub signs webhook payloads with `X-Hub-Signature-256` header
2. Smee.io proxies events as raw SSE data — does **not** forward signature headers
3. The `SmeeWebhookReceiver` does **not** verify HMAC signatures (no header available)
4. Setting a secret on the webhook causes GitHub to sign payloads, but Smee strips signatures

**Conclusion**: Setting the secret is **harmless** (GitHub will sign, Smee will ignore). If the architecture evolves to bypass Smee (direct webhooks), HMAC verification is already configured. Recommendation: Always set secret if `WEBHOOK_SECRET` env var is available.

### Event Type Considerations

**Current Smee receiver filtering**:
```typescript
// Line 189 of smee-receiver.ts
if (!body || githubEvent !== 'issues') return;
```

**Only processes**: `issues.labeled` events

**GitHub webhook events available**:
- `issues`: Issue opened, closed, labeled, unlabeled, etc.
- `pull_request`: PR opened, closed, merged, etc.
- `pull_request_review`: PR review submitted, edited, dismissed
- `pull_request_review_comment`: Review comment created, edited, deleted

**Spec mentions**: PR feedback monitoring via `pull_request_review` and `pull_request_review_comment`, but the Smee receiver explicitly filters these out.

**Decision**: Auto-configured webhooks should subscribe **only to `["issues"]`** events (not all three). When PR feedback via Smee is implemented, update the webhook then. Subscribing to unused events wastes GitHub webhook delivery quota.

## URL Matching Strategy

### Comparison Approaches Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Exact string match** | Simple, fast | Misses case differences (`HTTP` vs `http`) | ❌ Rejected |
| **Case-insensitive string** | Simple, handles case | Trailing slash mismatch creates duplicates | ✅ **Chosen** |
| **Normalized URL parsing** | Robust against minor diffs | Complex, edge cases (query params, fragments) | ❌ Rejected |

**Rationale for case-insensitive string comparison**:
- Smee.io URLs are **machine-generated** and consistent: `https://smee.io/{channel_id}`
- Trailing slash scenario unlikely (Smee doesn't append `/`)
- Worst case: duplicate webhooks → both deliver same event → Redis dedup suppresses second
- Complexity cost > benefit for normalized parsing

**Implementation**:
```typescript
function matchesSmeeUrl(existingUrl: string, smeeUrl: string): boolean {
  return existingUrl.toLowerCase() === smeeUrl.toLowerCase();
}
```

## Error Handling Strategy

### Failure Scenarios

| Scenario | GitHub Response | Handling Strategy |
|----------|----------------|-------------------|
| **No permissions** | 403 Forbidden | Warn, continue to next repo |
| **Repo not found** | 404 Not Found | Warn, continue to next repo |
| **Invalid webhook URL** | 422 Unprocessable | Warn (likely config error), continue |
| **GitHub API down** | 500/502/503 | Warn, continue (best-effort) |
| **Rate limited** | 429 Too Many Requests | Warn, continue (no retry) |
| **Network timeout** | ETIMEDOUT | Warn, continue (no retry) |
| **JSON parse error** | N/A (local) | Warn, continue (API changed?) |

**Guiding principle**: Webhook setup is a **best-effort convenience**, not a critical path. The system has graceful degradation (polling). Failures should be **visible but non-blocking**.

### Retry vs. No Retry

**Considered**: Retry with exponential backoff for 429/500 errors

**Decided**: **No retries**

**Rationale**:
1. This runs **once at startup** (infrequent operation)
2. Transient errors (500, network) likely resolved by next startup/restart
3. Rate limiting (429) unlikely with <10 repos and low request volume
4. Retry logic adds complexity (backoff timing, max attempts, per-repo vs. global)
5. Benefit: Might save 1 manual retry after a flaky GitHub API call
6. Cost: 30+ lines of retry orchestration code
7. If GitHub is having 500s at startup, operator should investigate, not auto-retry

**Outcome**: Log warning, move to next repo. Operator can manually retry by restarting.

## Startup Sequence Analysis

### Current CLI Startup Flow

```
orchestrator.ts main action:
1. Parse CLI options + env vars
2. Validate port, timeout, credentials
3. Create logger adapter
4. Create job queue (Redis or in-memory)
5. Create orchestrator HTTP server
6. IF label monitor enabled:
   a. Parse MONITORED_REPOS
   b. Check for SMEE_CHANNEL_URL
   c. Create Redis connection for phase tracker
   d. Create PhaseTrackerService
   e. Create LabelMonitorBridge
   f. Create LabelMonitorService
   g. Create SmeeWebhookReceiver (if URL set)
7. Start HTTP server (server.listen())
8. Start label monitor:
   a. Start Smee receiver (if configured)
   b. Start polling
```

### Proposed Integration Point

**Insert webhook setup after step 6f** (monitor service created) and **before step 8a** (Smee receiver started):

```
6f. Create LabelMonitorService
6g. Create SmeeWebhookReceiver (if URL set)
    NEW: 6h. Run WebhookSetupService.ensureWebhooks()  <-- HERE
7. Start HTTP server (server.listen())
8a. Start Smee receiver (if configured)
```

**Rationale**:
1. **After monitor service**: Ensures `repositories` array is parsed and validated
2. **Before Smee receiver**: Ensures webhooks exist before we start listening for events
3. **Blocking**: Deterministic ordering, simple control flow
4. **No timeout needed**: Small repo count (<10), fast API calls (<1s per repo)

### Startup Time Impact Analysis

**Baseline** (no webhook setup): ~500ms (Redis connect, service init)

**Worst case** (10 repos, no webhooks):
- 10 × `GET /repos/{owner}/{repo}/hooks`: ~500ms (parallel possible)
- 10 × `POST /repos/{owner}/{repo}/hooks`: ~1000ms (parallel possible)
- Total: ~1500ms (1.5 seconds)

**Best case** (10 repos, webhooks exist):
- 10 × `GET /repos/{owner}/{repo}/hooks`: ~500ms
- 0 × POST (all skipped)
- Total: ~500ms

**Acceptable?** Yes. 1.5s worst-case startup latency for a daemon that runs continuously is negligible.

## Smee Reconnection Behavior

### Current Implementation

```typescript
// smee-receiver.ts, line 72-87
while (this.running && !signal.aborted) {
  try {
    await this.connect(signal);
  } catch (error) {
    if (signal.aborted) break;
    this.logger.warn(
      { err: String(error), reconnectMs: this.reconnectDelayMs },
      'Smee connection lost, reconnecting...',
    );
  }

  // Wait before reconnecting
  if (this.running && !signal.aborted) {
    await this.sleep(this.reconnectDelayMs, signal);  // Fixed 5s delay
  }
}
```

**Problem**: If smee.io is down for an extended period (e.g., 30 minutes), logs fill with `"Smee connection lost, reconnecting..."` every 5 seconds = **360 log entries**.

### Exponential Backoff Research

**Strategy**:
```typescript
const baseDelay = 5000;  // 5 seconds
const maxDelay = 300000; // 5 minutes
let attempt = 0;

while (running) {
  try {
    await connect();
    attempt = 0;  // Reset on success
  } catch (error) {
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    await sleep(delay);
    attempt++;
  }
}
```

**Backoff progression**:
- Attempt 0: 5s (immediate)
- Attempt 1: 10s
- Attempt 2: 20s
- Attempt 3: 40s
- Attempt 4: 80s (1m 20s)
- Attempt 5: 160s (2m 40s)
- Attempt 6+: 300s (5m, capped)

**Log volume reduction**:
- Current (30min outage): 360 log entries (every 5s)
- With backoff (30min outage): ~15 log entries (exponential spacing)
- **Reduction**: 96% fewer logs during extended outages

**Trade-off**: Reconnection after brief outage slightly slower (10s vs. 5s for second attempt), but polling provides < 5min fallback regardless.

## Configuration Management

### Current Pattern

**CLI command** reads most config from env vars directly:
```typescript
const redisUrl = options['redisUrl'] ?? process.env['REDIS_URL'];
const smeeChannelUrl = process.env['SMEE_CHANNEL_URL'];  // Line 230
```

**Config schema** (`MonitorConfigSchema`) is used by `server.ts` path via `loader.ts`.

### Options Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Add to schema** | Centralized config, typed | Touches schema/loader/types for CLI-only feature | ❌ Rejected |
| **Keep as env var** | Simple, consistent with CLI pattern | Duplicates `smeeChannelUrl` read logic | ✅ **Chosen** |
| **CLI option** | Explicit, overrideable | Verbose CLI args | ❌ Rejected |

**Decision**: Keep reading `SMEE_CHANNEL_URL` from `process.env` in CLI, pass as parameter to `WebhookSetupService`. No changes to config schema/loader.

**Rationale**:
1. CLI command already reads env vars directly (e.g., `REDIS_URL`, line 35)
2. `MonitorConfigSchema` is used by `server.ts` (via config loader), which doesn't use Smee
3. Adding to schema means:
   - Modify `schema.ts` (add `smeeChannelUrl?: z.string().url().optional()`)
   - Modify `loader.ts` (read from `SMEE_CHANNEL_URL` env var)
   - Modify `types/index.ts` (export new type)
   - Update `server.ts` to read from config (even though it won't use it)
4. Benefit: Centralized config
5. Cost: 4 file changes for something only CLI path consumes

**Outcome**: Pass `smeeChannelUrl` directly as parameter, avoid schema changes.

## Alternative Approaches Considered

### Alternative 1: Webhook Setup in Worker

**Approach**: Instead of CLI startup, auto-configure webhook the first time a worker processes an issue from a repo.

**Pros**:
- Lazy initialization (only create webhooks for repos that actually get used)
- Distributed setup (workers handle it, not CLI)

**Cons**:
- Race condition: multiple workers try to create webhook simultaneously
- First workflow run pays latency cost of webhook creation (~1s)
- Doesn't help with resume detection (completed:* labels on existing issues)
- More complex error handling (worker must handle API errors mid-workflow)

**Decision**: Rejected. Startup setup is simpler, more predictable, and ensures webhooks exist before any workflow runs.

### Alternative 2: Manual `generacy` CLI Command

**Approach**: Add `generacy orchestrator webhooks setup` command that operators run manually.

**Pros**:
- Explicit control over when webhooks are created
- No startup latency impact
- Easier to test in isolation

**Cons**:
- Requires operator to remember to run it
- Doesn't auto-update when `MONITORED_REPOS` changes
- Defeats the purpose of "auto"-configuration

**Decision**: Rejected. The spec explicitly says "auto-configure" on startup. Manual command could be added later as a utility for debugging/re-syncing.

### Alternative 3: Smee Client Library with Auto-Setup

**Approach**: Use the official `smee-client` npm package, which has webhook auto-setup built-in.

**Pros**:
- Mature library with webhook management
- Less code to maintain

**Cons**:
- Current implementation uses native `fetch()` SSE (no dependency)
- `smee-client` uses EventSource polyfill (adds 2 dependencies)
- Auto-setup in `smee-client` assumes single repo (doesn't support multi-repo)
- Would require rewriting existing `SmeeWebhookReceiver` service

**Decision**: Rejected. Current SSE implementation is simple, dependency-free, and working. Adding `smee-client` would require significant refactoring for marginal benefit.

## Lessons from Old `autodev` Tooling

The spec mentions: *"The old autodev tooling auto-configured webhooks using the GitHub credentials."*

**Research**: Reviewed old autodev implementation patterns:

1. **Used `@octokit/rest` library** for GitHub API calls
   - We're using `gh` CLI instead (already available, no new dependency)

2. **Webhook creation was synchronous at startup**
   - Same approach we're taking

3. **No error handling for permission issues**
   - Caused startup failures when token lacked `admin:repo_hook`
   - **Lesson learned**: Make it best-effort with warnings, not fatal errors

4. **Created webhooks for all repos in GitHub org (auto-discovery)**
   - Too broad for multi-tenant orchestrator
   - **Our approach**: Only create for explicitly listed `MONITORED_REPOS`

5. **No idempotency — would create duplicate webhooks on restart**
   - **Our approach**: Check for existing webhooks first, skip if present

## Security Considerations

### Webhook Secret Exposure

**Risk**: Webhook secret stored in GitHub webhook config

**Mitigation**: GitHub masks secrets in webhook details UI (`"secret": "********"`). API returns masked value, not plaintext.

**Impact**: Low. Secrets are stored encrypted in GitHub's database.

### Token Permissions

**Required scope**: `admin:repo_hook`

**Risk**: Broad permissions allow creating/deleting webhooks

**Mitigation**:
1. Use dedicated bot account with minimal permissions
2. Scope token to specific repos (fine-grained PATs)
3. Rotate token regularly (standard practice)

**Impact**: Medium. Over-privileged tokens are a general risk, not specific to this feature.

### Smee.io Man-in-the-Middle

**Risk**: Smee.io can see webhook payloads (issue data, labels, etc.)

**Mitigation**: None — this is inherent to using Smee proxy.

**Impact**: Low for public repos, Medium for private repos.

**Recommendation**: For production with private repos, use direct webhook endpoints (`server.ts` path) instead of Smee. Smee is primarily for development/testing.

## Performance Considerations

### GitHub API Rate Limits

**Analysis**:
- Authenticated requests: 5,000/hour
- Webhook endpoints: Primary bucket (shared with other API calls)
- Per-repo cost: 1 GET + 0-1 POST/PATCH = 1-2 requests
- For 10 repos: 10-20 requests total
- Frequency: Once per orchestrator restart

**Impact**: Negligible. 10-20 requests once per restart is <1% of hourly quota.

### Redis Phase Tracker

**Analysis**: Webhook deduplication relies on `PhaseTrackerService` with Redis backend.

**Current behavior**:
- Key format: `phase:{owner}:{repo}:{issue}:{phase}` → expires after 24h
- Webhook + poll both try to process same event → second is suppressed by dedup
- If Redis is down, dedup is disabled, duplicate events are processed

**Impact**: Low. Duplicate processing is idempotent (workflow engine handles it).

### Smee SSE Connection

**Analysis**: Native `fetch()` with SSE keeps persistent connection open.

**Resource usage**:
- 1 connection per orchestrator instance
- Minimal bandwidth (only delivers events for watched repos)
- Exponential backoff reduces reconnection attempts during outages

**Impact**: Negligible. Single SSE connection is standard for webhook proxies.

## Future Enhancements

### 1. Webhook Health Check Endpoint

Add `/api/webhooks/health` endpoint that reports:
- Which repos have webhooks configured
- Last webhook event received per repo
- Whether Smee connection is active

**Benefit**: Easier debugging of webhook issues

### 2. Webhook Sync Command

Add `generacy orchestrator webhooks sync` CLI command to manually trigger webhook setup.

**Benefit**: Re-sync after modifying `MONITORED_REPOS` without restarting

### 3. Direct Webhook Support in CLI

Add option to use direct webhooks (ngrok/cloudflare tunnel) instead of Smee.

**Benefit**: Lower latency, no third-party dependency

### 4. Webhook Event Filtering

Allow configuring which event types to subscribe to per repo.

**Benefit**: Reduce webhook delivery quota usage for large orgs

### 5. Multi-Tenant Webhook Isolation

Use webhook secrets to route events to different orchestrator instances.

**Benefit**: Support multiple teams on shared GitHub org

---

## References

- [GitHub Webhooks Documentation](https://docs.github.com/en/webhooks)
- [Smee.io Documentation](https://smee.io/)
- [Server-Sent Events (SSE) Spec](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [GitHub API Rate Limiting](https://docs.github.com/en/rest/overview/rate-limits-for-the-rest-api)

---

*Research compiled by Claude Code on 2026-02-24*
