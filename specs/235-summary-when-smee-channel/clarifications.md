# Clarification Questions

## Status: Pending

## Questions

### Q1: Integration Scope — server.ts vs orchestrator.ts
**Context**: There are two entry points for the orchestrator: the Fastify-based `server.ts` (used by the full orchestrator package) and the CLI `orchestrator.ts` command (in the generacy CLI). The Smee receiver is only wired up in the CLI path today. The spec mentions integrating `WebhookSetupService` in both `server.ts` and `orchestrator.ts`, but also lists "Wiring the SmeeWebhookReceiver into server.ts" as out of scope. Adding webhook auto-configuration to `server.ts` without the Smee receiver means webhooks get created but never consumed via that code path.
**Question**: Should webhook setup be integrated into both `server.ts` and `orchestrator.ts`, or only into the CLI `orchestrator.ts` path where the Smee receiver actually runs?
**Options**:
- A) CLI only: Only integrate `WebhookSetupService` into `orchestrator.ts` where Smee is actually used. The `server.ts` path is out of scope for this feature.
- B) Both paths: Integrate into both `server.ts` and `orchestrator.ts`. Even though `server.ts` doesn't use the Smee receiver yet, pre-creating webhooks prepares for future Smee integration there.
- C) Both paths, plus wire Smee receiver into server.ts: Expand scope to also add Smee receiver support to the Fastify server, making the full path work end-to-end in both entry points.
**Answer**:

### Q2: GitHubClient Interface Location
**Context**: The `GitHubClient` interface lives in `packages/workflow-engine/src/actions/github/client/interface.ts` and its `GhCliGitHubClient` implementation is in the same directory. The spec says to extend this interface with webhook methods (`listRepoWebhooks`, `createRepoWebhook`, `updateRepoWebhook`). However, webhook management is an orchestrator concern, not a workflow-engine concern. Adding it to the workflow-engine's `GitHubClient` interface means every implementation (including any future ones) must implement webhook methods, even if they don't need them.
**Question**: Should the webhook methods be added directly to the existing `GitHubClient` interface in workflow-engine, or should the `WebhookSetupService` call the GitHub API directly (e.g., via `gh api`) without going through the `GitHubClient` abstraction?
**Options**:
- A) Extend GitHubClient: Add methods to the existing interface and `GhCliGitHubClient` implementation, following the spec as written. Keeps all GitHub API access behind one abstraction.
- B) Direct API calls: Have `WebhookSetupService` call `gh api` directly (or use `executeCommand` utility) without modifying the `GitHubClient` interface. Keeps webhook concerns isolated to the orchestrator package.
- C) Separate interface: Create a new `WebhookClient` interface in the orchestrator package that the `WebhookSetupService` depends on, with its own `gh api` implementation. Clean separation without polluting the workflow-engine interface.
**Answer**:

### Q3: GitHub API Return Types for Webhook Methods
**Context**: The spec defines the `WebhookSetupResult` type but does not specify the TypeScript types for GitHub webhook API responses (the shapes returned by `GET /repos/{owner}/{repo}/hooks`, etc.). The `GhCliGitHubClient` implementation needs to parse these responses. The GitHub REST API returns a rich webhook object with fields like `id`, `name`, `active`, `events`, `config.url`, `config.content_type`, `config.insecure_ssl`, etc.
**Question**: What should the webhook type definitions look like? Should we define minimal types covering only the fields we need, or comprehensive types matching the GitHub API schema?
**Options**:
- A) Minimal types: Define only the fields needed by `WebhookSetupService` (e.g., `{ id: number; active: boolean; config: { url: string } }`). Simpler, less maintenance burden.
- B) Comprehensive types: Define types matching the full GitHub webhook API response. More future-proof but more code to maintain.
**Answer**:

### Q4: Config Schema Addition — FR-009 Scope
**Context**: FR-009 says to add `SMEE_CHANNEL_URL` to `MonitorConfigSchema`. Currently, the CLI `orchestrator.ts` reads `SMEE_CHANNEL_URL` directly from `process.env` (line 230) without going through the config schema/loader. Adding it to the schema also requires updating `loader.ts` to read the env var and thread it through. This is a broader config refactoring that touches the config schema, loader, and possibly changes how the CLI command accesses the value.
**Question**: Should we add `smeeChannelUrl` to the formal `MonitorConfigSchema` and config loader, or keep reading it from `process.env` directly as the CLI does today?
**Options**:
- A) Add to schema + loader: Add `smeeChannelUrl` as an optional string field to `MonitorConfigSchema` and update `loader.ts` to read from `SMEE_CHANNEL_URL` env var. The `WebhookSetupService` and CLI command both consume it from the config object.
- B) Keep as env var: Continue reading `SMEE_CHANNEL_URL` directly from `process.env` in the CLI command, and pass it as a parameter to `WebhookSetupService`. No config schema changes needed.
**Answer**:

### Q5: Inactive Webhook Reactivation — Matching Criteria
**Context**: FR-005 says to reactivate inactive webhooks that match the Smee URL. But the spec doesn't address what to do if the matching webhook has different `events` than what we want (e.g., it subscribes to `["push"]` instead of `["issues"]`). A webhook could match by URL but have been manually modified to track different events. Blindly reactivating it might not deliver the `issues.labeled` events the Smee receiver needs.
**Question**: When reactivating an inactive webhook that matches the Smee URL, should the service also verify/update the `events` array to ensure it includes `"issues"`?
**Options**:
- A) Reactivate only: Just set `active: true` as the spec says. If events are wrong, the operator can fix manually. Simpler implementation.
- B) Reactivate and fix events: When reactivating, also PATCH the events to `["issues"]` to ensure correctness. Slightly more API calls but ensures the webhook actually works.
- C) Reactivate and merge events: When reactivating, PATCH events to include `"issues"` while preserving any other events the webhook already tracks. Most permissive approach.
**Answer**:

### Q6: URL Matching — Trailing Slash and Query Parameter Sensitivity
**Context**: FR-003 says to match `config.url` against `SMEE_CHANNEL_URL` with case-insensitive comparison. But smee.io URLs can vary in subtle ways: trailing slashes (`https://smee.io/abc` vs `https://smee.io/abc/`), query parameters, or protocol differences. The spec says "case-insensitive" but doesn't address other normalization.
**Question**: How strict should URL matching be when checking for existing webhooks?
**Options**:
- A) Case-insensitive string comparison: Compare the full URL strings case-insensitively. Simple and predictable. If the URL has a trailing slash mismatch, it won't match (and a new webhook is created).
- B) Normalized comparison: Parse both URLs and compare origin + pathname (normalized, stripping trailing slashes). More robust against minor formatting differences.
**Answer**:

### Q7: Startup Blocking Behavior
**Context**: FR-008 says webhook setup should run before the Smee receiver starts, and FR-007 says 403/404 errors should not block startup. But the spec doesn't clarify how long the webhook setup should be allowed to take before startup continues. With many repos or slow GitHub API responses, `ensureWebhooks()` could take significant time. There's no timeout specified.
**Question**: Should webhook setup have a timeout, and should it block the entire startup sequence or run concurrently with it?
**Options**:
- A) Blocking with no timeout: Run `ensureWebhooks()` to completion (or failure) before starting the Smee receiver. Simple, deterministic ordering. GitHub API errors fail fast per-repo (FR-007), so total time is bounded by repo count.
- B) Blocking with timeout: Run `ensureWebhooks()` but abort after a configurable timeout (e.g., 30 seconds). If it times out, proceed with startup and log which repos weren't checked.
- C) Non-blocking: Start webhook setup and Smee receiver concurrently. The Smee receiver begins listening immediately; webhook setup runs in parallel and logs results as they complete.
**Answer**:

### Q8: Logging Format — Structured Logger Compatibility
**Context**: The spec says to use structured logs with `{ owner, repo, action, webhookId? }`. The CLI `orchestrator.ts` uses a custom pino logger adapter (lines 49-53, 259-281) that wraps the CLI logger. The `server.ts` uses Fastify's built-in pino logger. These two paths have slightly different logger shapes and calling conventions.
**Question**: Should the `WebhookSetupService` accept a generic logger interface (like the existing services do), and if so, which logger shape should it follow?
**Options**:
- A) Pino-style `logger.info(obj, msg)`: Follow the pattern used by `LabelMonitorService` and other orchestrator services. The CLI command's `monitorLogger` adapter already translates this to the CLI logger.
- B) Simple `logger.info(msg, data?)` style: Follow the pattern used by the CLI's `loggerAdapter`. Simpler but inconsistent with orchestrator services.
**Answer**:

### Q9: Test Strategy
**Context**: The spec doesn't mention testing requirements. The `WebhookSetupService` will make external API calls (via `gh api`) and has several code paths: webhook exists, webhook missing, webhook inactive, permission denied, API error. The existing codebase has test files for the orchestrator services (e.g., label monitor tests), and the `GitHubClient` interface enables mocking.
**Question**: What level of test coverage is expected for this feature?
**Options**:
- A) Unit tests only: Test `WebhookSetupService` with a mocked `GitHubClient` (or mocked `gh api` calls). Cover the main code paths: create, skip, reactivate, permission error.
- B) Unit + integration tests: Unit tests as above, plus integration tests that run against a real GitHub repo (or GitHub API mock server) to verify end-to-end webhook creation.
- C) No new tests: Rely on manual testing and the existing test infrastructure. Ship the feature quickly and add tests later.
**Answer**:

### Q10: Error Handling for Non-Permission Errors
**Context**: FR-007 covers 403/404 graceful degradation (insufficient permissions). But the spec doesn't specify behavior for other error types: network timeouts, 500 server errors, rate limiting (429), or malformed responses. Should these also be caught per-repo and logged as warnings, or should they be treated differently (e.g., retried)?
**Question**: How should non-permission GitHub API errors (500, 429, network errors) be handled during webhook setup?
**Options**:
- A) Treat same as permission errors: Log warning per-repo, continue to next repo. No retries. The `failed` result status covers all error types.
- B) Retry transient errors: Retry 429 and 5xx errors with backoff (1-2 attempts), but treat persistent failures the same as permission errors.
- C) Fail fast on unexpected errors: Only gracefully handle 403/404. Other errors (500, network) should cause the webhook setup to abort entirely and log an error (but still not block startup).
**Answer**:
