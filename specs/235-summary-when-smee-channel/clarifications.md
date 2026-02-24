# Clarification Questions

## Status: Follow-up Required

## Questions

### Q1: Integration Scope — server.ts vs orchestrator.ts
**Context**: There are two entry points for the orchestrator: the Fastify-based `server.ts` (used by the full orchestrator package) and the CLI `orchestrator.ts` command (in the generacy CLI). The Smee receiver is only wired up in the CLI path today. The spec mentions integrating `WebhookSetupService` in both `server.ts` and `orchestrator.ts`, but also lists "Wiring the SmeeWebhookReceiver into server.ts" as out of scope. Adding webhook auto-configuration to `server.ts` without the Smee receiver means webhooks get created but never consumed via that code path.
**Question**: Should webhook setup be integrated into both `server.ts` and `orchestrator.ts`, or only into the CLI `orchestrator.ts` path where the Smee receiver actually runs?
**Options**:
- A) CLI only: Only integrate `WebhookSetupService` into `orchestrator.ts` where Smee is actually used. The `server.ts` path is out of scope for this feature.
- B) Both paths: Integrate into both `server.ts` and `orchestrator.ts`. Even though `server.ts` doesn't use the Smee receiver yet, pre-creating webhooks prepares for future Smee integration there.
- C) Both paths, plus wire Smee receiver into server.ts: Expand scope to also add Smee receiver support to the Fastify server, making the full path work end-to-end in both entry points.
**Answer**: A) CLI only. The Smee receiver only runs in the CLI `orchestrator.ts` path. `server.ts` uses direct GitHub webhooks via Fastify routes with HMAC verification — a fundamentally different approach. Adding webhook auto-config to `server.ts` without a Smee receiver means creating webhooks that point to a Smee URL nobody's listening on. Keep scope tight.

### Q2: GitHubClient Interface Location
**Context**: The `GitHubClient` interface lives in `packages/workflow-engine/src/actions/github/client/interface.ts` and its `GhCliGitHubClient` implementation is in the same directory. The spec says to extend this interface with webhook methods (`listRepoWebhooks`, `createRepoWebhook`, `updateRepoWebhook`). However, webhook management is an orchestrator concern, not a workflow-engine concern. Adding it to the workflow-engine's `GitHubClient` interface means every implementation (including any future ones) must implement webhook methods, even if they don't need them.
**Question**: Should the webhook methods be added directly to the existing `GitHubClient` interface in workflow-engine, or should the `WebhookSetupService` call the GitHub API directly (e.g., via `gh api`) without going through the `GitHubClient` abstraction?
**Options**:
- A) Extend GitHubClient: Add methods to the existing interface and `GhCliGitHubClient` implementation, following the spec as written. Keeps all GitHub API access behind one abstraction.
- B) Direct API calls: Have `WebhookSetupService` call `gh api` directly (or use `executeCommand` utility) without modifying the `GitHubClient` interface. Keeps webhook concerns isolated to the orchestrator package.
- C) Separate interface: Create a new `WebhookClient` interface in the orchestrator package that the `WebhookSetupService` depends on, with its own `gh api` implementation. Clean separation without polluting the workflow-engine interface.
**Answer**: B) Direct API calls. Webhook management is an orchestrator concern. The `GitHubClient` in workflow-engine abstracts issue/label/PR operations used by workflow actions. Webhook admin methods don't belong there — they'd force every future `GitHubClient` implementation to implement methods irrelevant to workflow execution. `WebhookSetupService` can call `gh api` directly via the existing `executeCommand` utility, keeping it self-contained in the orchestrator package.

### Q3: GitHub API Return Types for Webhook Methods
**Context**: The spec defines the `WebhookSetupResult` type but does not specify the TypeScript types for GitHub webhook API responses (the shapes returned by `GET /repos/{owner}/{repo}/hooks`, etc.). The `GhCliGitHubClient` implementation needs to parse these responses. The GitHub REST API returns a rich webhook object with fields like `id`, `name`, `active`, `events`, `config.url`, `config.content_type`, `config.insecure_ssl`, etc.
**Question**: What should the webhook type definitions look like? Should we define minimal types covering only the fields we need, or comprehensive types matching the GitHub API schema?
**Options**:
- A) Minimal types: Define only the fields needed by `WebhookSetupService` (e.g., `{ id: number; active: boolean; config: { url: string } }`). Simpler, less maintenance burden.
- B) Comprehensive types: Define types matching the full GitHub webhook API response. More future-proof but more code to maintain.
**Answer**: A) Minimal types. We only need `id`, `active`, `config.url`, and `events` from the webhook response. Minimal types are easier to maintain and sufficient for the matching/reactivation logic. We're not building a general-purpose GitHub webhook SDK.

### Q4: Config Schema Addition — FR-009 Scope
**Context**: FR-009 says to add `SMEE_CHANNEL_URL` to `MonitorConfigSchema`. Currently, the CLI `orchestrator.ts` reads `SMEE_CHANNEL_URL` directly from `process.env` (line 230) without going through the config schema/loader. Adding it to the schema also requires updating `loader.ts` to read the env var and thread it through. This is a broader config refactoring that touches the config schema, loader, and possibly changes how the CLI command accesses the value.
**Question**: Should we add `smeeChannelUrl` to the formal `MonitorConfigSchema` and config loader, or keep reading it from `process.env` directly as the CLI does today?
**Options**:
- A) Add to schema + loader: Add `smeeChannelUrl` as an optional string field to `MonitorConfigSchema` and update `loader.ts` to read from `SMEE_CHANNEL_URL` env var. The `WebhookSetupService` and CLI command both consume it from the config object.
- B) Keep as env var: Continue reading `SMEE_CHANNEL_URL` directly from `process.env` in the CLI command, and pass it as a parameter to `WebhookSetupService`. No config schema changes needed.
**Answer**: B) Keep as env var. `SMEE_CHANNEL_URL` is already read from `process.env` in the CLI path. The `MonitorConfigSchema` is primarily used by `server.ts` / the config loader, which doesn't use Smee. Adding it to the schema means touching `schema.ts`, `loader.ts`, and the config types for something only the CLI path consumes. Pass it as a parameter to `WebhookSetupService` instead.

### Q5: Inactive Webhook Reactivation — Matching Criteria
**Context**: FR-005 says to reactivate inactive webhooks that match the Smee URL. But the spec doesn't address what to do if the matching webhook has different `events` than what we want (e.g., it subscribes to `["push"]` instead of `["issues"]`). A webhook could match by URL but have been manually modified to track different events. Blindly reactivating it might not deliver the `issues.labeled` events the Smee receiver needs.
**Question**: When reactivating an inactive webhook that matches the Smee URL, should the service also verify/update the `events` array to ensure it includes `"issues"`?
**Options**:
- A) Reactivate only: Just set `active: true` as the spec says. If events are wrong, the operator can fix manually. Simpler implementation.
- B) Reactivate and fix events: When reactivating, also PATCH the events to `["issues"]` to ensure correctness. Slightly more API calls but ensures the webhook actually works.
- C) Reactivate and merge events: When reactivating, PATCH events to include `"issues"` while preserving any other events the webhook already tracks. Most permissive approach.
**Answer**: C) Reactivate and merge events. If a webhook matches by URL but has `["push"]` instead of `["issues"]`, just reactivating it won't deliver label events. Merging ensures `"issues"` is present without removing other events someone intentionally configured. This avoids both silent failure (option A) and clobbering existing config (option B).

### Q6: URL Matching — Trailing Slash and Query Parameter Sensitivity
**Context**: FR-003 says to match `config.url` against `SMEE_CHANNEL_URL` with case-insensitive comparison. But smee.io URLs can vary in subtle ways: trailing slashes (`https://smee.io/abc` vs `https://smee.io/abc/`), query parameters, or protocol differences. The spec says "case-insensitive" but doesn't address other normalization.
**Question**: How strict should URL matching be when checking for existing webhooks?
**Options**:
- A) Case-insensitive string comparison: Compare the full URL strings case-insensitively. Simple and predictable. If the URL has a trailing slash mismatch, it won't match (and a new webhook is created).
- B) Normalized comparison: Parse both URLs and compare origin + pathname (normalized, stripping trailing slashes). More robust against minor formatting differences.
**Answer**: A) Case-insensitive string comparison. Smee.io URLs are machine-generated and consistent. Normalized URL parsing adds complexity for an edge case that's unlikely in practice. If a trailing slash mismatch causes a duplicate webhook, the worst case is two webhooks pointing to the same Smee channel — harmless and obvious to debug.

### Q7: Startup Blocking Behavior
**Context**: FR-008 says webhook setup should run before the Smee receiver starts, and FR-007 says 403/404 errors should not block startup. But the spec doesn't clarify how long the webhook setup should be allowed to take before startup continues. With many repos or slow GitHub API responses, `ensureWebhooks()` could take significant time. There's no timeout specified.
**Question**: Should webhook setup have a timeout, and should it block the entire startup sequence or run concurrently with it?
**Options**:
- A) Blocking with no timeout: Run `ensureWebhooks()` to completion (or failure) before starting the Smee receiver. Simple, deterministic ordering. GitHub API errors fail fast per-repo (FR-007), so total time is bounded by repo count.
- B) Blocking with timeout: Run `ensureWebhooks()` but abort after a configurable timeout (e.g., 30 seconds). If it times out, proceed with startup and log which repos weren't checked.
- C) Non-blocking: Start webhook setup and Smee receiver concurrently. The Smee receiver begins listening immediately; webhook setup runs in parallel and logs results as they complete.
**Answer**: A) Blocking with no timeout. `MONITORED_REPOS` is a small, bounded list. Each GitHub API call is fast (sub-second). Per-repo error handling (FR-007) means individual failures don't stall the whole sequence. A timeout adds complexity for a scenario (many slow repos) that doesn't exist in practice. Deterministic ordering (setup completes → Smee starts) is simpler to reason about.

### Q8: Logging Format — Structured Logger Compatibility
**Context**: The spec says to use structured logs with `{ owner, repo, action, webhookId? }`. The CLI `orchestrator.ts` uses a custom pino logger adapter (lines 49-53, 259-281) that wraps the CLI logger. The `server.ts` uses Fastify's built-in pino logger. These two paths have slightly different logger shapes and calling conventions.
**Question**: Should the `WebhookSetupService` accept a generic logger interface (like the existing services do), and if so, which logger shape should it follow?
**Options**:
- A) Pino-style `logger.info(obj, msg)`: Follow the pattern used by `LabelMonitorService` and other orchestrator services. The CLI command's `monitorLogger` adapter already translates this to the CLI logger.
- B) Simple `logger.info(msg, data?)` style: Follow the pattern used by the CLI's `loggerAdapter`. Simpler but inconsistent with orchestrator services.
**Answer**: A) Pino-style `logger.info(obj, msg)`. This is the established pattern across all orchestrator services (`LabelMonitorService`, `SmeeWebhookReceiver`, `PhaseTrackerService`). The CLI's `monitorLogger` adapter already translates Pino-style calls to the CLI logger. Consistency > simplicity here.

### Q9: Test Strategy
**Context**: The spec doesn't mention testing requirements. The `WebhookSetupService` will make external API calls (via `gh api`) and has several code paths: webhook exists, webhook missing, webhook inactive, permission denied, API error. The existing codebase has test files for the orchestrator services (e.g., label monitor tests), and the `GitHubClient` interface enables mocking.
**Question**: What level of test coverage is expected for this feature?
**Options**:
- A) Unit tests only: Test `WebhookSetupService` with a mocked `GitHubClient` (or mocked `gh api` calls). Cover the main code paths: create, skip, reactivate, permission error.
- B) Unit + integration tests: Unit tests as above, plus integration tests that run against a real GitHub repo (or GitHub API mock server) to verify end-to-end webhook creation.
- C) No new tests: Rely on manual testing and the existing test infrastructure. Ship the feature quickly and add tests later.
**Answer**: A) Unit tests only. Mock the `gh api` calls (or use a mock `executeCommand`) and test the main code paths: create, skip-existing, reactivate, permission error, network error. The existing test infrastructure in `packages/orchestrator/tests/unit/services/` has clear patterns to follow. Integration tests against real GitHub API are brittle and overkill for this feature.

### Q10: Error Handling for Non-Permission Errors
**Context**: FR-007 covers 403/404 graceful degradation (insufficient permissions). But the spec doesn't specify behavior for other error types: network timeouts, 500 server errors, rate limiting (429), or malformed responses. Should these also be caught per-repo and logged as warnings, or should they be treated differently (e.g., retried)?
**Question**: How should non-permission GitHub API errors (500, 429, network errors) be handled during webhook setup?
**Options**:
- A) Treat same as permission errors: Log warning per-repo, continue to next repo. No retries. The `failed` result status covers all error types.
- B) Retry transient errors: Retry 429 and 5xx errors with backoff (1-2 attempts), but treat persistent failures the same as permission errors.
- C) Fail fast on unexpected errors: Only gracefully handle 403/404. Other errors (500, network) should cause the webhook setup to abort entirely and log an error (but still not block startup).
**Answer**: A) Treat same as permission errors. This is a best-effort startup convenience, not a critical path. The system degrades gracefully to polling regardless. Adding retry logic with backoff for transient errors adds complexity for minimal benefit — if GitHub is having 500s at startup, it'll likely resolve by the next restart. Log the warning, move on.

---

## Follow-up Questions

The following new questions were raised based on the clarification answers:

### Q11: Duplicate Event Processing (Smee + Direct Webhook)
**Context**: The spec wires up `SmeeWebhookReceiver` to feed events into `LabelMonitorService`, but the direct webhook route (`/webhooks/github`) already does the same thing. If a GitHub webhook delivers an event both directly to the orchestrator endpoint AND through the Smee channel, the same event will be processed twice. The `LabelMonitorService.processLabelEvent()` has deduplication logic, but there's no explicit mention of this scenario in the spec.
**Question**: When both Smee and the direct webhook endpoint are active, should the spec address duplicate event suppression, or is the existing deduplication in `processLabelEvent()` sufficient?
**Options**:
- A) Existing dedup is sufficient: The `processLabelEvent()` deduplication already handles this — no spec changes needed.
- B) Disable direct webhook route when Smee is active: If `SMEE_CHANNEL_URL` is set, don't register the direct `/webhooks/github` route to avoid duplicate processing.
- C) Document the expected behavior: Keep both paths active but explicitly document in the spec that deduplication handles concurrent delivery.
**Answer**:

### Q12: Webhook Secret Reuse vs. Separate Secrets
**Context**: The spec uses `config.monitor.webhookSecret` (loaded from `WEBHOOK_SECRET`) as the secret for both the direct webhook HMAC verification AND the auto-created webhook config. However, Smee.io proxies events as raw SSE data — it does not forward GitHub's HMAC signature headers in a way that allows server-side verification. The `SmeeWebhookReceiver` does not verify signatures. Setting a webhook secret on auto-created Smee webhooks means GitHub will sign the payloads, but Smee strips/doesn't forward the `X-Hub-Signature-256` header, making the secret effectively unused on the receive side.
**Question**: Should the webhook secret still be configured on auto-created Smee webhooks, given that Smee-proxied events cannot be HMAC-verified?
**Options**:
- A) Always set secret if available: Configure the secret on the webhook anyway — it doesn't hurt, and if the architecture changes to direct webhooks later, verification is already in place.
- B) Skip secret for Smee webhooks: Don't set `config.secret` on webhooks pointing to Smee URLs, since signature verification is impossible through the Smee proxy.
- C) Add a separate env var: Introduce `SMEE_WEBHOOK_SECRET` to allow different secrets for Smee-created vs. direct webhooks.
**Answer**:

### Q13: PR Feedback Events Through Smee
**Context**: The `SmeeWebhookReceiver` currently only handles `issues.labeled` events and feeds them into `LabelMonitorService`. The webhook events configured include `pull_request_review` and `pull_request_review_comment`, but the Smee receiver ignores these event types (line 189 of `smee-receiver.ts`: `if (!body || githubEvent !== 'issues') return`). The spec lists this as "Out of Scope" but the auto-configured webhooks will subscribe to PR review events that are received but silently dropped.
**Question**: Should the auto-configured webhook events list only include `issues` (matching what the Smee receiver actually processes), or should it include all three event types in anticipation of future PR feedback integration?
**Options**:
- A) All three events (as specified): Subscribe to `issues`, `pull_request_review`, and `pull_request_review_comment` to avoid needing a webhook update when PR feedback via Smee is added later.
- B) Only `issues` for now: Subscribe only to events the Smee receiver actually processes, and update the webhook when PR feedback support is added.
**Answer**:

### Q14: Startup Ordering — Webhook Config Before or After Redis
**Context**: The spec places webhook auto-config (step 5) before Redis init (step 6), but the spec also says it's non-blocking. Currently in `server.ts`, label sync (step 4) runs before Redis. Webhook config requires network calls to GitHub API via `gh api`, which could be slow if there are many repos or API latency. Placing it before Redis means Redis init is delayed until webhook config completes (even though webhook config failures don't block startup, the sequential ordering does).
**Question**: Should webhook auto-config run before Redis init (blocking Redis until complete) or be moved to a non-blocking position (e.g., fire-and-forget in `onReady`)?
**Options**:
- A) Before Redis (as specified): Keep webhook config before Redis init to ensure webhooks are configured before the server starts accepting events. Acceptable latency for < 10 repos.
- B) In onReady hook (fire-and-forget): Move webhook config to the `onReady` hook alongside polling start, so it doesn't delay Redis or other startup steps.
- C) Parallel with Redis: Run webhook config concurrently with Redis init using `Promise.all()` to avoid blocking either.
**Answer**:

### Q15: Smee Receiver Reconnect Behavior on Repeated Failures
**Context**: The `SmeeWebhookReceiver` has auto-reconnect with a fixed 5-second delay. If smee.io is down or the channel URL is invalid, it will reconnect indefinitely every 5 seconds, logging warnings each time. The spec doesn't mention a maximum retry limit or exponential backoff.
**Question**: Should the Smee receiver have a maximum number of reconnection attempts or exponential backoff before giving up, or is infinite retry with fixed delay acceptable?
**Options**:
- A) Infinite retry (current behavior): Keep reconnecting forever with a 5-second fixed delay. Smee downtime is transient, and polling covers the gap.
- B) Exponential backoff: Add exponential backoff (e.g., 5s → 10s → 20s → ... capped at 5min) to reduce log noise during extended outages.
- C) Max retries then stop: After N failed reconnections (e.g., 10), stop the receiver and log an error. Rely on polling only.
**Answer**:

### Q16: Webhook Event Type Update for Existing Webhooks
**Context**: The spec explicitly states under "Out of Scope" that existing webhooks with different event types won't be updated — only URL matching is checked. However, if a webhook already exists for the Smee URL but was created with only `["issues"]` events (from a previous version), the auto-config will report "already exists" even though it's missing `pull_request_review` events. This is a silent misconfiguration.
**Question**: Should the implementation log a warning when an existing webhook's event list doesn't match the desired configuration, even if no update is performed?
**Options**:
- A) Silent skip (as specified): If the URL matches, report "already exists" with no further checks.
- B) Warn on event mismatch: Check the existing webhook's events and log a warning if they differ from the desired list, but don't update.
- C) Update events on mismatch: Use the GitHub API to PATCH the existing webhook's events to match the desired list.
**Answer**:

### Q17: Testing Requirements for Integration Code
**Context**: The spec lists the existing unit tests for `WebhookConfigService` and `WebhookClient` as already complete, and states "No Changes Needed" for those files. However, the new integration code in `server.ts` (wiring services together, startup/shutdown, config loading) has no specified test requirements. The server startup involves conditional logic (Smee enabled/disabled), error handling, and shutdown ordering that could regress.
**Question**: Should integration tests be written for the new `server.ts` wiring, or is manual verification sufficient?
**Options**:
- A) No new tests needed: The existing unit tests cover the services; manual verification of the wiring is sufficient for this integration-focused change.
- B) Integration test for startup: Add a test that creates a server with `SMEE_CHANNEL_URL` set (using mocked services) and verifies the Smee receiver is started and stopped correctly.
- C) Config loader tests only: Add unit tests for the new `SMEE_CHANNEL_URL` config loading in `loader.ts` and schema validation, but skip server integration tests.
- D) Both integration and config tests: Add tests for both the config loader changes and the server startup wiring.
**Answer**:

### Q18: Smee Channel URL Validation Strictness
**Context**: The spec defines the Zod schema as `z.string().url().optional()`, which accepts any valid URL. However, Smee channel URLs have a specific format (`https://smee.io/XXXXX`). Passing a non-Smee URL would create webhooks pointing to an arbitrary endpoint. The `WebhookConfigService` would successfully create the webhook, but events would be sent to the wrong URL.
**Question**: Should the schema validate that the URL is specifically a smee.io URL, or accept any URL to allow alternative Smee-compatible proxies?
**Options**:
- A) Any valid URL: Accept any URL to support self-hosted Smee proxies or alternative webhook forwarding services.
- B) Smee.io URLs only: Validate that the URL starts with `https://smee.io/` to prevent misconfiguration.
- C) Warn on non-Smee URLs: Accept any URL but log a warning at startup if it doesn't match the `smee.io` domain.
**Answer**:
