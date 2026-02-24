# Feature Specification: Auto-Configure GitHub Webhooks for Smee on Orchestrator Startup

**Branch**: `235-summary-when-smee-channel` | **Date**: 2026-02-24 | **Status**: Draft

## Summary

When `SMEE_CHANNEL_URL` is configured, the orchestrator should automatically verify and configure GitHub webhooks for all monitored repositories on startup. Currently, webhooks must be manually configured per-repo, and missing webhooks silently degrade to 5-minute fallback polling for label detection. This causes inconsistent resume latency across repos — some repos detect `completed:*` labels near-instantly via Smee, while others wait up to 5 minutes (or 15 minutes if Smee is not configured at all, where `COMPLETED_CHECK_INTERVAL=3` multiplies the 30s base poll).

## Context

The label monitor uses a hybrid webhook + polling approach:
- **With Smee webhook**: Near-instant detection of label events via SSE stream from smee.io
- **Without webhook (polling only)**: `completed:*` labels checked every 3rd poll cycle (~90 seconds at default 30s interval, or ~15 minutes at 5-minute fallback)

The `SmeeWebhookReceiver` class already exists and is fully implemented (`packages/orchestrator/src/services/smee-receiver.ts`). When active, it connects to a smee.io channel via SSE, receives forwarded GitHub webhook payloads, and feeds `issues.labeled` events into the `LabelMonitorService`. The CLI orchestrator command (`packages/generacy/src/cli/commands/orchestrator.ts`) already wires up the Smee receiver when `SMEE_CHANNEL_URL` is set and reduces polling to a 5-minute fallback interval.

**The missing piece**: For Smee to receive webhook events for a repository, a GitHub webhook must be configured on that repo pointing to the Smee channel URL. Today, this is manual. The old autodev tooling auto-configured these webhooks. The new orchestrator should do the same.

### Architecture Impact

```
GitHub Repo ──webhook──> smee.io ──SSE──> SmeeWebhookReceiver ──> LabelMonitorService
                                                                        ↑
GitHub Repo ──REST API──────────────────polling────────────────────────────┘
```

This feature adds a new `WebhookSetupService` that runs between config loading and Smee receiver startup to ensure the webhook→smee.io link exists for every monitored repo.

## User Stories

### US1: Automatic Webhook Configuration

**As an** orchestrator operator,
**I want** webhooks to be automatically configured for all monitored repos when Smee is enabled,
**So that** I don't have to manually set up webhooks for each repository and risk silent degradation to slow polling.

**Acceptance Criteria**:
- [ ] On startup with `SMEE_CHANNEL_URL` set, the orchestrator checks each repo in `MONITORED_REPOS` for an existing Smee webhook
- [ ] Missing webhooks are automatically created with the correct Smee channel URL
- [ ] Already-configured webhooks are left unchanged (no duplicate webhooks)
- [ ] A summary log line reports the result for each repo (created / already exists / failed)

### US2: Graceful Degradation on Insufficient Permissions

**As an** orchestrator operator with a limited-scope `GH_TOKEN`,
**I want** the orchestrator to log a warning and continue if webhook creation fails due to insufficient permissions,
**So that** the system still functions via polling even when the token lacks `admin:repo_hook` scope.

**Acceptance Criteria**:
- [ ] A 403/404 from the GitHub API when listing or creating hooks is logged as a warning, not a fatal error
- [ ] The orchestrator continues startup normally (Smee receiver still starts for repos that already have webhooks)
- [ ] The log message clearly states the required scope (`admin:repo_hook`) for the operator to fix

### US3: Idempotent Startup

**As an** orchestrator operator restarting the service,
**I want** repeated startups to not create duplicate webhooks,
**So that** each repo has exactly one Smee webhook regardless of how many times the orchestrator restarts.

**Acceptance Criteria**:
- [ ] The service matches existing webhooks by comparing `config.url` against `SMEE_CHANNEL_URL`
- [ ] If a matching webhook exists (even if inactive), no new webhook is created
- [ ] If an existing webhook is found but inactive, it is re-activated

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create a `WebhookSetupService` that verifies/creates GitHub webhooks for Smee | P1 | New service in `packages/orchestrator/src/services/` |
| FR-002 | On startup, when `SMEE_CHANNEL_URL` is set, call `GET /repos/{owner}/{repo}/hooks` for each repo in `MONITORED_REPOS` | P1 | Uses GitHub REST API via `gh api` or direct fetch with `GH_TOKEN` |
| FR-003 | Check if a webhook already exists with `config.url` matching the Smee channel URL | P1 | Match is case-insensitive on the URL |
| FR-004 | If no matching webhook exists, create one via `POST /repos/{owner}/{repo}/hooks` | P1 | Payload: `{ config: { url, content_type: "json" }, events: ["issues"], active: true }` |
| FR-005 | If a matching webhook exists but is inactive, reactivate it via `PATCH /repos/{owner}/{repo}/hooks/{id}` | P2 | Set `active: true` |
| FR-006 | Log result per repo: `created`, `already-exists`, `reactivated`, or `failed` with reason | P1 | Structured log with `{ owner, repo, action, webhookId? }` |
| FR-007 | On 403/404 errors (insufficient permissions), log warning and continue | P1 | Must not block startup or crash |
| FR-008 | Run webhook setup after config loading but before Smee receiver starts | P1 | Ensures webhooks exist before SSE connection begins |
| FR-009 | Add `SMEE_CHANNEL_URL` to the orchestrator config schema (`MonitorConfigSchema`) | P2 | Optional string field, loaded from env var |
| FR-010 | Extend `GitHubClient` interface with `listRepoWebhooks`, `createRepoWebhook`, and `updateRepoWebhook` methods | P1 | Add to interface and `GhCliGitHubClient` implementation |
| FR-011 | Skip webhook setup entirely when `SMEE_CHANNEL_URL` is not set | P1 | No API calls, no warnings — silent no-op |
| FR-012 | Process repos concurrently with concurrency limit (reuse `maxConcurrentPolls` or similar) | P3 | Prevents hitting rate limits on orgs with many repos |

## Technical Design

### New Service: `WebhookSetupService`

**Location**: `packages/orchestrator/src/services/webhook-setup-service.ts`

```typescript
interface WebhookSetupResult {
  owner: string;
  repo: string;
  action: 'created' | 'already-exists' | 'reactivated' | 'failed';
  webhookId?: number;
  error?: string;
}

class WebhookSetupService {
  constructor(logger, createClient: GitHubClientFactory);

  async ensureWebhooks(
    repositories: RepositoryConfig[],
    smeeChannelUrl: string,
  ): Promise<WebhookSetupResult[]>;
}
```

### GitHub API Calls

The service needs three GitHub REST API endpoints not currently in the `GitHubClient` interface:

1. **List hooks**: `GET /repos/{owner}/{repo}/hooks` — requires `admin:repo_hook` scope
2. **Create hook**: `POST /repos/{owner}/{repo}/hooks` — requires `admin:repo_hook` scope
3. **Update hook**: `PATCH /repos/{owner}/{repo}/hooks/{id}` — requires `admin:repo_hook` scope

These should be added to the `GitHubClient` interface and implemented in `GhCliGitHubClient` using `gh api`.

### Integration Point

In `server.ts`, add webhook setup between label sync and Smee receiver initialization:

```typescript
// After label sync, before monitor service creation
if (config.monitor.smeeChannelUrl && config.repositories.length > 0) {
  const webhookSetup = new WebhookSetupService(server.log, createGitHubClient);
  const results = await webhookSetup.ensureWebhooks(
    config.repositories,
    config.monitor.smeeChannelUrl,
  );
  // Log summary
}
```

Similarly in the CLI orchestrator command (`orchestrator.ts`), run webhook setup before creating the `SmeeWebhookReceiver`.

### Event Configuration

Webhooks should subscribe to `["issues"]` events only. This covers:
- `issues.labeled` — the only event the Smee receiver processes

The `pull_request_review` and `pull_request_review_comment` events used by the PR feedback monitor have their own separate webhook configuration and are out of scope for this feature.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Webhook auto-creation success rate | 100% for repos where token has `admin:repo_hook` scope | Check startup logs for `created` vs `failed` actions |
| SC-002 | Resume event latency (with Smee) | < 5 seconds from label application to queue enqueue | Compare label timestamp to enqueue timestamp in logs |
| SC-003 | Idempotency | 0 duplicate webhooks after 10 consecutive restarts | Count webhooks per repo via GitHub API |
| SC-004 | Graceful degradation | Orchestrator starts successfully even with insufficient token scope | Startup completes, polling active, warning logged |

## Assumptions

- The `GH_TOKEN` used by the orchestrator has `admin:repo_hook` scope for all monitored repositories (or the operator accepts polling fallback for repos where it doesn't)
- The smee.io channel URL is stable and does not change between deployments (if it changes, old webhooks should ideally be cleaned up, but this is out of scope)
- The GitHub REST API rate limit is sufficient for the additional `GET /hooks` call per repo on startup (typically 1 call per repo, bounded by `MONITORED_REPOS` size which is small — 2-3 repos today)
- Existing webhook routes (`/webhooks/github`) and the Smee receiver are not affected by this change — they continue to work independently

## Out of Scope

- **Webhook cleanup/removal**: Old or orphaned webhooks are not removed. If the Smee channel URL changes, old webhooks remain (manual cleanup required).
- **PR review webhooks**: The `PrFeedbackMonitorService` uses a separate webhook endpoint (`/webhooks/github/pr-review`) with different events. Auto-configuring those is a separate feature.
- **Webhook secret configuration**: The Smee-forwarded webhooks don't use HMAC signature verification (Smee acts as a proxy). The existing `WEBHOOK_SECRET`-based verification applies only to direct webhook routes.
- **Health monitoring of created webhooks**: No ongoing verification that webhooks remain active after creation. The existing adaptive polling mechanism handles webhook failures at runtime.
- **Multi-Smee-channel support**: Only a single `SMEE_CHANNEL_URL` is supported across all repos.
- **Wiring the `SmeeWebhookReceiver` into `server.ts`**: The Smee receiver is currently only used in the CLI orchestrator command. Integrating it into the Fastify server startup is a separate concern.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `GH_TOKEN` lacks `admin:repo_hook` scope | Medium | Low — falls back to polling | Log clear warning with required scope name; document in setup guide |
| GitHub API rate limit hit during startup | Low | Low — only N calls where N = repo count | Runs once at startup; typically 2-3 repos |
| Smee channel URL changes between deploys | Low | Medium — old webhooks orphaned | Document that old webhooks should be manually removed; consider cleanup in future iteration |

---

*Generated by speckit*
