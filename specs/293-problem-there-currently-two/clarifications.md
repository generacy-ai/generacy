# Clarification Questions

## Status: Resolved

## Questions

### Q1: Authentication Backward Compatibility
**Context**: The old server uses simple Bearer token comparison (`Authorization: Bearer <token>`), while the Fastify server uses API keys with SHA-256 hashing plus JWT with scopes. External workers and the `orchestrator/client.ts` currently send plain Bearer tokens. The spec says "Ensure backward compat or document migration" (FR-004) but doesn't specify which approach to take.
**Question**: How should the auth transition be handled for the `--auth-token` CLI flag?
**Options**:
- A) Compatibility shim: Add a Fastify auth hook that accepts both plain Bearer tokens (matching the old behavior) and SHA-256 hashed API keys, so existing clients work without changes
- B) Auto-hash on startup: When the CLI receives `--auth-token`, SHA-256 hash it and register it as an API key in the Fastify auth provider. Existing clients sending `Authorization: Bearer <token>` would still work if the Fastify API key auth extracts Bearer tokens and hashes them for comparison
- C) Breaking change with migration guide: Document that `--auth-token` now uses the Fastify API key model. Update `client.ts` and require external workers to update their auth headers. Provide a migration guide
- D) Dual auth mode: Support both `--auth-token` (legacy Bearer) and `--api-key` (new hashed) flags simultaneously during a deprecation period
**Answer**: **B) Auto-hash on startup.** When the CLI receives `--auth-token`, SHA-256 hash it and register it in the Fastify `InMemoryApiKeyStore`. The Fastify auth middleware already checks `x-api-key` header first, but add a fallback that also extracts `Authorization: Bearer <token>`, hashes it, and validates against the store. Seamless backward compatibility — existing clients sending `Bearer <token>` just work — while aligning with the Fastify auth model internally.

### Q2: External Worker Polling Endpoint
**Context**: The old server exposes `GET /api/jobs/poll` for external workers to claim jobs, plus `POST /api/workers/register`, `POST /api/workers/:id/heartbeat`, `PUT /api/jobs/:id/status`, and `POST /api/jobs/:id/result`. The Fastify server has a fundamentally different model using Redis-based `WorkerDispatcher` with `/dispatch/queue/*` monitoring endpoints but no equivalent polling API. US3 requires "existing external workers can still poll for jobs" but the Fastify server lacks these endpoints entirely.
**Question**: How should external worker backward compatibility be handled?
**Options**:
- A) Add compatibility routes: Add `/api/jobs/poll`, `/api/workers/*`, and `/api/jobs/:id/*` routes to the Fastify server that bridge to the Redis queue/dispatcher, preserving the old API contract
- B) Breaking change: Document that external workers must migrate to the new dispatch model. Provide migration guide and update any known worker implementations
- C) Deprecation period: Add compatibility routes (option A) but mark them as deprecated with warnings, targeting removal in a future release
- D) Out of scope: Declare external worker migration as a separate issue. This convergence only handles the CLI command; external workers get a follow-up ticket
**Answer**: **D) Out of scope.** External worker polling is a fundamentally different dispatch model from the Fastify server's Redis-based `WorkerDispatcher`. Bridging these adds significant complexity. External worker migration should be a separate follow-up ticket. The Fastify server's `WorkerDispatcher` runs workers in-process via `ClaudeCliWorker` — that's the target model going forward.

### Q3: In-Memory Queue Fallback Without Redis
**Context**: The old server has a full `InMemoryJobQueue` that allows jobs to be queued, polled, and executed without Redis. The Fastify server's fallback without Redis is a logging-only stub that discards items (`logOnlyAdapter`). The spec assumes "The Fastify server can run without Redis (graceful degradation) to match the old server's in-memory fallback behavior," but the actual degradation is more severe — jobs are logged and lost, not queued.
**Question**: What behavior is expected when running without Redis?
**Options**:
- A) Accept the degraded behavior: Running without Redis means no job dispatch. Label monitor still polls and logs findings, but nothing is queued or executed. Document this as a known limitation
- B) Add InMemoryQueueAdapter: Implement an in-memory queue adapter in the Fastify server that mimics the old behavior for development/testing scenarios without Redis
- C) Require Redis: Make Redis a hard requirement for the CLI orchestrator command. Fail fast on startup if `--redis-url` is not provided or Redis is unreachable
**Answer**: **B) Add InMemoryQueueAdapter.** Implement an in-memory queue adapter that satisfies the `QueueManager` interface (enqueue, claim, release, complete, getQueueDepth, etc.) using in-memory data structures. Keeps the zero-dependency local development experience working. Doesn't need to be production-grade — just functional enough for `generacy orchestrator` to work locally without Redis.

### Q4: SmeeWebhookReceiver Lifecycle Ownership
**Context**: The CLI command currently creates and manages `SmeeWebhookReceiver` and `WebhookSetupService` outside the old server. The Fastify server does not initialize these services internally — it only registers webhook HTTP routes. The spec says to "Preserve SmeeWebhookReceiver setup" (FR-011) and "Preserve WebhookSetupService" (FR-012) but doesn't specify where the lifecycle management should live after convergence.
**Question**: Where should SmeeWebhookReceiver and WebhookSetupService be initialized and managed?
**Options**:
- A) Inside Fastify server: Add Smee/webhook setup as Fastify plugins or onReady hooks, configured via the programmatic config (e.g., `smee.channelUrl` config key). This keeps all service lifecycle in one place
- B) Outside in CLI: Keep the current pattern where the CLI command creates and manages these services after `createServer()` returns. The CLI connects them to the Fastify server's label monitor instance
- C) Hybrid: Move SmeeWebhookReceiver into Fastify server lifecycle (it's tightly coupled to the label monitor), but keep WebhookSetupService in the CLI (it's a one-shot setup operation, not a long-running service)
**Answer**: **A) Inside Fastify server.** `SmeeWebhookReceiver` is tightly coupled to the label monitor (feeds events into `monitorService.processLabelEvent()`) and already lives in `packages/orchestrator/src/services/smee-receiver.ts`. Move its lifecycle into the Fastify server configured via `smee.channelUrl` in config. `WebhookSetupService` is also already in the orchestrator package — it should run as an `onReady` hook.

### Q5: LabelMonitorBridge Package Location
**Context**: The spec recommends Option A — keeping `LabelMonitorBridge` as a composing wrapper that enriches payloads before delegating to `RedisQueueAdapter`. The bridge currently lives in `packages/generacy/src/orchestrator/` (the old package being deleted). The spec suggests moving it to `packages/orchestrator/src/services/`. However, the bridge uses `createGitHubClient` from the CLI package and has coupling to `Octokit` for issue fetching.
**Question**: Where should the LabelMonitorBridge live and how should it integrate?
**Options**:
- A) Move to Fastify package: Move bridge to `packages/orchestrator/src/services/label-monitor-bridge.ts`, accepting a `QueueAdapter` (RedisQueueAdapter) in its constructor instead of the old server. Pull in Octokit dependency to the orchestrator package
- B) Move enrichment into LabelMonitorService: Instead of a separate bridge, extend `LabelMonitorService` to fetch issue details before submitting to the queue adapter. This eliminates the bridge entirely (spec's Option B)
- C) Keep bridge in CLI package: Move bridge to `packages/generacy/src/cli/services/` since it's only used by the CLI command. Pass it as the queue adapter to the Fastify server's label monitor config
**Answer**: **B) Move enrichment into LabelMonitorService.** The bridge exists solely because the old server needed `submitJob()` calls with enriched payloads (issue body fetched via Octokit). With the Fastify server, `LabelMonitorService` already calls `queueAdapter.enqueue()` directly. The enrichment (fetching issue description) should move into `LabelMonitorService.processLabelEvent()` before calling `enqueue()`. Eliminates the bridge entirely — no extra class, no indirection. The GitHub client dependency is already available in the service context.

### Q6: Job Submission Endpoint Parity
**Context**: The old server has `POST /api/jobs` for submitting jobs directly (used by `LabelMonitorBridge` via `server.submitJob()`). The Fastify server has `POST /queue` for creating "decisions" but no direct job submission endpoint. The models are semantically different — old "jobs" vs new "decisions/dispatch items." The spec doesn't address whether a direct job submission API is needed in the Fastify server.
**Question**: Does the Fastify server need a direct job submission endpoint equivalent to the old `POST /api/jobs`?
**Options**:
- A) Not needed: The LabelMonitorBridge (or equivalent) will use `RedisQueueAdapter.enqueue()` programmatically, bypassing HTTP. External job submission is out of scope
- B) Add job submission route: Add a `POST /api/jobs` or `POST /dispatch/submit` route to the Fastify server for programmatic job submission via HTTP, preserving the old API contract
- C) Use existing queue route: Map the old job submission semantics to `POST /queue` with appropriate payload transformation
**Answer**: **A) Not needed.** `LabelMonitorService` (with enrichment per Q5) will call `RedisQueueAdapter.enqueue()` programmatically. No need for an HTTP endpoint for internal job submission. The existing `POST /queue` route serves a different purpose (decision queue). External job submission via HTTP can be added in a separate ticket if ever needed.

### Q7: Client.ts Migration Strategy
**Context**: `packages/generacy/src/orchestrator/client.ts` is a REST client for the old server API. It uses Bearer token auth and calls old endpoints (`/api/jobs/poll`, `/api/workers/register`, etc.). It's currently used in CLI tests. The spec says "Preserve or migrate client.ts if used elsewhere" (FR-015) but the client won't work against the Fastify server due to different auth, endpoints, and response formats.
**Question**: What should happen to `orchestrator/client.ts`?
**Options**:
- A) Delete it: Remove client.ts along with the other old orchestrator files. Update or remove the CLI tests that depend on it. The Fastify server can be tested via its own test infrastructure
- B) Rewrite for Fastify API: Update client.ts to target the Fastify server's endpoints, auth model, and response formats. Keep it as the canonical TypeScript client for the orchestrator
- C) Preserve as-is with deprecation: Keep client.ts temporarily for backward compat but mark it deprecated. Create a new client in the orchestrator package if needed
**Answer**: **A) Delete it.** `client.ts` is a REST client for the old server's endpoints (`/api/jobs/poll`, `/api/workers/register`, etc.) which won't exist in the Fastify server. CLI tests should be updated to test against the Fastify server's API directly. Delete it along with the other old orchestrator files.

### Q8: Config Precedence Order
**Context**: The Fastify server's `loadConfig()` reads from config files and environment variables. The CLI passes programmatic config overrides. The spec doesn't specify what happens when multiple sources conflict — e.g., if a config file sets `server.port: 3000`, env var `PORT=8080`, and CLI flag `--port 3100` are all present.
**Question**: What is the config precedence order when multiple sources provide conflicting values?
**Options**:
- A) CLI flags > env vars > config file > defaults: CLI flags take highest priority, matching standard CLI convention. The programmatic config from the CLI overrides everything
- B) Env vars > CLI flags > config file > defaults: Environment variables take highest priority, matching 12-factor app convention and container deployment patterns
- C) Let Fastify's existing loadConfig handle it: Pass CLI flags as overrides to `createServer(config)`, and let the existing config loader determine precedence for anything not explicitly set via CLI
**Answer**: **A) CLI flags > env vars > config file > defaults.** Standard CLI convention (used by Docker, kubectl, npm, etc.). The Fastify `loadConfig()` already handles env vars > config file > defaults. The CLI's programmatic config should be applied as the final override layer. If you explicitly pass `--port 3100`, that wins.

### Q9: Startup Health Check Contract
**Context**: The old server's `GET /api/health` returns a custom health response with service status. The Fastify server's `GET /health` returns a different structure including Kubernetes-style liveness/readiness probes at `/health/live` and `/health/ready`. SC-005 measures "time from command invocation to first successful health check response." The health endpoint path and response format differ between implementations.
**Question**: Should the health endpoint maintain the old `/api/health` path or switch to the Fastify `/health` path?
**Options**:
- A) Use Fastify paths only: Switch to `/health`, `/health/live`, `/health/ready`. Update any scripts or monitoring that reference `/api/health`
- B) Add alias: Register both `/api/health` (legacy) and `/health` (new) pointing to the same handler, for backward compatibility
- C) Redirect: Add a 301 redirect from `/api/health` to `/health` to guide consumers to the new path
**Answer**: **A) Use Fastify paths only.** The Fastify server already has `/health`, `/health/live`, and `/health/ready` (standard Kubernetes-style probes). The old `/api/health` path is only used by the CLI's own startup check and possibly scripts. Since we're replacing the server, use the new paths and update any references. Adding aliases creates maintenance burden for no real benefit.

### Q10: Endpoint Route Prefix Convention
**Context**: The old server mounts all routes under `/api/` (e.g., `/api/health`, `/api/jobs/poll`, `/api/workers/register`). The Fastify server mounts routes at the root or under specific prefixes (e.g., `/health`, `/metrics`, `/queue`, `/dispatch/queue/*`, `/webhooks/github`). Any external clients, scripts, or documentation referencing `/api/*` paths will break.
**Question**: Should the Fastify server routes be prefixed with `/api/` to match the old convention?
**Options**:
- A) No prefix change: Use Fastify's current route paths as-is. This is the new canonical API. Update documentation and any known clients
- B) Add `/api/` prefix: Register all Fastify routes under `/api/` prefix (e.g., `/api/health`, `/api/queue`, `/api/dispatch/queue/*`) to maintain URL consistency with the old server
- C) Selective prefix: Keep Fastify's root-level routes (health, metrics) but add `/api/` prefix to operational routes (queue, dispatch, webhooks) for consistency
**Answer**: **A) No prefix change.** The Fastify server's routes are the new canonical API. The old `/api/*` routes are disappearing along with the old server. No known external consumers beyond `client.ts` (being deleted per Q7) and the CLI itself. Adding `/api/` prefix would mean changing all existing Fastify route registrations and tests for no practical benefit.

### Q11: Graceful Shutdown Timeout
**Context**: The spec mentions "Graceful shutdown with in-flight worker timeout" and FR-013 says "Fastify has its own shutdown hooks; CLI signal handlers should delegate." The old server's CLI handles SIGINT/SIGTERM with a hard 5-second timeout before force exit. The Fastify server has its own shutdown sequence (stop dispatcher, stop monitors, close SSE, close Redis). The `--worker-timeout` flag maps to `heartbeatTtlMs` but is separate from the shutdown grace period.
**Question**: What should the graceful shutdown timeout be, and should it be configurable?
**Options**:
- A) Fixed 30-second timeout: Use a fixed 30-second grace period for in-flight workers to complete, then force exit. This matches typical container orchestrator defaults (Kubernetes terminationGracePeriodSeconds)
- B) Tied to worker-timeout: Use `--worker-timeout` value as the shutdown grace period, since it represents how long to wait for workers
- C) Configurable via new flag: Add `--shutdown-timeout` CLI flag (default 30s) separate from `--worker-timeout`, since heartbeat TTL and shutdown grace period serve different purposes
**Answer**: **C) Configurable via new flag.** Heartbeat TTL (`--worker-timeout`) and shutdown grace period serve different purposes. The `WorkerDispatcher` already has `shutdownTimeoutMs` in its config schema (under `dispatch.shutdownTimeoutMs`). Expose it as `--shutdown-timeout` CLI flag with a sensible default (30s matches Kubernetes defaults). Keeps the two concepts separate and independently configurable.

### Q12: Epic Completion Monitor Configuration
**Context**: The spec mentions "Epic completion tracking activates when configured" (US1 acceptance criteria) but doesn't specify any CLI flags or configuration for the `EpicCompletionMonitor`. The Fastify server initializes it, but the CLI command has no `--epic-monitor` flag or equivalent. This is a new capability not present in the old server.
**Question**: How should the Epic Completion Monitor be configured via CLI?
**Options**:
- A) Auto-enable: Enable EpicCompletionMonitor automatically when the label monitor is active (it depends on the same repository configuration)
- B) New CLI flag: Add `--epic-monitor` boolean flag to explicitly enable/disable it, defaulting to enabled when label monitor is active
- C) Config-only: Don't add a CLI flag; configure it only via config file or environment variable, since it's a new feature not part of the old CLI contract
**Answer**: **A) Auto-enable.** The `EpicCompletionMonitor` depends on the same repository list and GitHub access as the label monitor. It's lightweight (polls every 5 minutes by default). Auto-enabling when the label monitor is active is the simplest approach and matches how the Fastify server already initializes it. Users who need to disable it can use the config file (`epicMonitor.enabled: false`).

### Q13: PR Feedback Monitor Configuration
**Context**: Similar to Epic Completion, the PR Feedback Monitor is a new capability mentioned in US1 ("PR feedback monitoring activates when configured") but the old CLI has no flags for it. The Fastify server creates `PrFeedbackMonitorService` during startup. The spec doesn't define what "when configured" means for CLI users.
**Question**: How should the PR Feedback Monitor be configured via CLI?
**Options**:
- A) Auto-enable: Enable when label monitor is active, using the same repository list
- B) New CLI flag: Add `--pr-feedback-monitor` flag to explicitly enable/disable
- C) Config-only: Don't add a CLI flag; configure via config file or environment variable only
**Answer**: **A) Auto-enable.** Same reasoning as Q12. The PR Feedback Monitor uses the same repository list and is already initialized by the Fastify server when configured. Auto-enable when label monitor is active, with config file override available (`prMonitor.enabled: false`). Keeps the CLI flags simple.
