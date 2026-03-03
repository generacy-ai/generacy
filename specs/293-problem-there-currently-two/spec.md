# Feature Specification: Converge CLI Orchestrator to Fastify-based Server

**Branch**: `293-problem-there-currently-two` | **Date**: 2026-03-03 | **Status**: Draft

## Summary

The `generacy orchestrator` CLI command currently spins up a raw Node.js `http.createServer` (in `packages/generacy/src/orchestrator/server.ts`) while dynamically importing services from the newer `@generacy-ai/orchestrator` package. This creates a split-brain architecture: the CLI runs a hand-rolled HTTP server with 9 endpoints and basic Bearer token auth, while the Fastify-based server in `packages/orchestrator/` provides a full-featured platform with JWT auth, rate limiting, Prometheus metrics, worker dispatch, PR feedback monitoring, epic completion tracking, and structured routing across 11+ endpoint groups.

This feature converges the two implementations so the CLI command delegates directly to the Fastify server, eliminating code duplication, achieving feature parity, and ensuring the development environment runs identical code to production.

## Current Architecture

```
CLI command (packages/generacy/src/cli/commands/orchestrator.ts)
  ├── Accepts: --port (3100), --host, --worker-timeout, --auth-token, --redis-url,
  │           --label-monitor, --poll-interval, --monitored-repos
  ├── Creates: raw Node.js http.createServer (server.ts)
  │   ├── Hand-rolled regex router (router.ts)
  │   ├── WorkerRegistry — tracks workers, assigns jobs, heartbeats
  │   ├── InMemoryJobQueue / RedisJobQueue — simple queue
  │   ├── EventBus — SSE event streaming with buffering
  │   └── LogBufferManager — log output buffering
  ├── Imports services from @generacy-ai/orchestrator:
  │   ├── LabelMonitorService (polls GitHub for trigger labels)
  │   ├── LabelSyncService (syncs workflow labels on startup)
  │   ├── PhaseTrackerService (deduplicates phase completions)
  │   ├── SmeeWebhookReceiver (real-time webhook forwarding)
  │   └── WebhookSetupService (GitHub webhook CRUD)
  └── LabelMonitorBridge — adapts label monitor → old server's job submission API
```

## Target Architecture

```
CLI command (packages/generacy/src/cli/commands/orchestrator.ts)
  ├── Accepts: same CLI options, mapped to Fastify server config
  └── Delegates to: createServer() from @generacy-ai/orchestrator
      ├── Fastify 5.0 with plugins (CORS, Helmet, JWT, Rate Limit)
      ├── Structured routes (health, metrics, workflow, queue, agent,
      │   integration, events, webhooks, PR webhooks, dispatch)
      ├── Integrated services:
      │   ├── LabelMonitorService + LabelSyncService
      │   ├── PhaseTrackerService
      │   ├── PrFeedbackMonitorService
      │   ├── RedisQueueAdapter (Lua-based atomic ops)
      │   ├── WorkerDispatcher + ClaudeCliWorker
      │   └── EpicCompletionMonitor
      ├── Auth: API key (SHA-256) + JWT + scopes
      ├── Observability: Prometheus metrics, Pino logging, correlation IDs
      └── Graceful shutdown with in-flight worker timeout
```

## User Stories

### US1: Developer runs orchestrator via CLI with full feature set

**As a** developer using the `generacy orchestrator` CLI command,
**I want** the CLI to start the Fastify-based orchestrator server,
**So that** I get all features (PR feedback monitoring, epic completion, JWT auth, worker dispatch, metrics) without needing a separate deployment.

**Acceptance Criteria**:
- [ ] `generacy orchestrator` starts the Fastify server from `@generacy-ai/orchestrator`
- [ ] All existing CLI options (`--port`, `--host`, `--auth-token`, `--redis-url`, `--label-monitor`, `--poll-interval`, `--monitored-repos`, `--worker-timeout`) are mapped to the Fastify server config
- [ ] Health endpoint (`/health`) returns Fastify server health with service status
- [ ] Prometheus metrics are available at `/metrics`
- [ ] PR feedback monitoring activates when configured
- [ ] Epic completion tracking activates when configured
- [ ] Worker dispatcher starts when Redis is available

### US2: Label monitor continues to trigger jobs through the new server

**As a** developer with label monitoring enabled,
**I want** the label monitor to submit jobs through the Fastify server's queue API,
**So that** issue-triggered workflows execute correctly after the convergence.

**Acceptance Criteria**:
- [ ] `--label-monitor` flag enables LabelMonitorService within the Fastify server startup
- [ ] SmeeWebhookReceiver connects for real-time webhook forwarding when configured
- [ ] Fallback polling works at the configured `--poll-interval`
- [ ] Jobs submitted by the label monitor include issue metadata (description, owner, repo, issue number, command)
- [ ] LabelSyncService syncs workflow labels to monitored repos on startup

### US3: Existing external workers can still poll for jobs

**As an** operator running external worker processes,
**I want** the converged server to still expose job polling endpoints,
**So that** external workers are not broken during the transition.

**Acceptance Criteria**:
- [ ] Queue routes (`/api/queue/*` or equivalent) remain accessible
- [ ] Workers can poll, claim, and report results through the Fastify API
- [ ] Auth token passed via CLI is accepted for API access (backward compatibility)

### US4: Old orchestrator code is removed

**As a** maintainer of the codebase,
**I want** the old `packages/generacy/src/orchestrator/` server code to be removed,
**So that** there is only one orchestrator implementation to maintain.

**Acceptance Criteria**:
- [ ] `packages/generacy/src/orchestrator/server.ts` is deleted
- [ ] `packages/generacy/src/orchestrator/router.ts` is deleted
- [ ] `packages/generacy/src/orchestrator/worker-registry.ts` is deleted
- [ ] `packages/generacy/src/orchestrator/job-queue.ts` and `redis-job-queue.ts` are deleted
- [ ] `packages/generacy/src/orchestrator/event-bus.ts` is deleted
- [ ] `packages/generacy/src/orchestrator/log-buffer.ts` is deleted
- [ ] `packages/generacy/src/orchestrator/label-monitor-bridge.ts` is deleted or migrated
- [ ] `packages/generacy/src/orchestrator/types.ts` is deleted (types consolidated into orchestrator package)
- [ ] No remaining imports reference the old orchestrator module
- [ ] `packages/generacy/src/orchestrator/client.ts` is preserved if used elsewhere, or migrated

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | CLI command calls `createServer()` from `@generacy-ai/orchestrator` instead of `createOrchestratorServer()` | P1 | Core convergence change |
| FR-002 | Map `--port` CLI option to Fastify server config (preserve 3100 default for CLI) | P1 | Old default: 3100, Fastify default: 3000. CLI should override to 3100 for backward compat |
| FR-003 | Map `--host` CLI option to Fastify server config (default: `0.0.0.0`) | P1 | |
| FR-004 | Map `--auth-token` to Fastify auth config (API key provider) | P1 | Old: Bearer token. New: API key with SHA-256. Ensure backward compat or document migration |
| FR-005 | Map `--redis-url` to Fastify Redis config | P1 | Enables RedisQueueAdapter + WorkerDispatcher |
| FR-006 | Map `--label-monitor` flag to enable monitor in Fastify server config | P1 | Activates LabelMonitorService + webhook routes |
| FR-007 | Map `--poll-interval` to monitor config `pollIntervalMs` | P1 | Convert seconds to milliseconds if CLI uses seconds |
| FR-008 | Map `--monitored-repos` to Fastify repository config | P1 | Parse comma-separated `owner/repo` list into `{owner, repo}[]` |
| FR-009 | Map `--worker-timeout` to dispatch config `heartbeatTtlMs` | P2 | Old default: 60000ms |
| FR-010 | Integrate LabelMonitorBridge issue-enrichment logic into Fastify server's queue submission | P1 | Bridge fetches issue details and submits jobs with metadata; must work with RedisQueueAdapter |
| FR-011 | Preserve SmeeWebhookReceiver setup for real-time webhook forwarding | P1 | Currently wired up in CLI command |
| FR-012 | Preserve WebhookSetupService for automatic GitHub webhook CRUD | P2 | Currently wired up in CLI command |
| FR-013 | Retain graceful shutdown behavior (SIGINT/SIGTERM handling) | P1 | Fastify has its own shutdown hooks; CLI signal handlers should delegate |
| FR-014 | Delete old orchestrator files from `packages/generacy/src/orchestrator/` | P2 | After convergence is verified working |
| FR-015 | Preserve or migrate `orchestrator/client.ts` if used by other packages | P2 | Check for external imports before removing |
| FR-016 | `createServer()` accepts programmatic config (not just file/env) | P1 | CLI needs to pass config object directly |
| FR-017 | Log startup banner with effective config (port, host, enabled features) | P2 | Maintain CLI UX quality |
| FR-018 | Support `--smee-url` or `SMEE_URL` env var for SmeeWebhookReceiver | P2 | Currently handled in CLI |

## Technical Design Notes

### Config Mapping

The CLI accepts options as commander flags. These map to the Fastify server's Zod-validated config schema:

```
CLI Flag                → Fastify Config Path
--port 3100             → server.port
--host 0.0.0.0          → server.host
--auth-token TOKEN      → auth.enabled=true, auth.providers.apiKey.keys=[TOKEN]
--redis-url URL         → redis.url
--label-monitor         → monitor.enabled=true
--poll-interval 300     → monitor.pollIntervalMs (×1000 if in seconds)
--monitored-repos a/b   → repositories[{owner:'a', repo:'b'}]
--worker-timeout 60000  → dispatch.heartbeatTtlMs
```

### LabelMonitorBridge Migration

The current `LabelMonitorBridge` implements the `QueueAdapter` interface and:
1. Fetches GitHub issue details (title, body) via Octokit
2. Builds workflow input payload with issue metadata
3. Submits to the old server's job queue with priority "high"

In the Fastify server, `RedisQueueAdapter` already implements the `QueueAdapter` interface. Two options:
- **(A)** Keep `LabelMonitorBridge` as a composing wrapper that enriches payloads before delegating to `RedisQueueAdapter` — lower risk, preserves separation of concerns
- **(B)** Move issue-fetching logic into `LabelMonitorService` so the adapter receives pre-enriched payloads

Recommend **(A)** for lower risk. The bridge can be moved into `packages/orchestrator/src/services/` as part of this work.

### Port Default

The old server defaults to port 3100; the Fastify server defaults to 3000. The CLI command should default to 3100 to avoid breaking existing developer workflows, scripts, and documentation.

### createServer() API Change

The Fastify server's `createServer()` currently loads config from file/env. It needs to accept a programmatic config override:

```typescript
export async function createServer(
  configOverrides?: Partial<OrchestratorConfig>
): Promise<FastifyInstance>
```

## Implementation Phases

### Phase 1: Enable programmatic config in Fastify server
- Modify `createServer()` to accept optional config overrides
- Ensure all services can be enabled/disabled via config flags
- Add tests for config override behavior

### Phase 2: Rewire CLI command to use Fastify server
- Replace `createOrchestratorServer()` call with `createServer(mappedConfig)`
- Map all CLI flags to Fastify config schema
- Preserve SmeeWebhookReceiver and WebhookSetupService integration
- Wire up LabelMonitorBridge (or equivalent) with the Fastify server's queue

### Phase 3: Verify and test
- Run `generacy orchestrator` with all flag combinations
- Verify label monitor triggers jobs correctly
- Verify external workers can still poll/claim/report
- Verify graceful shutdown behavior
- Verify health, metrics, and auth endpoints

### Phase 4: Remove old orchestrator code
- Delete `packages/generacy/src/orchestrator/server.ts` and related files
- Update `packages/generacy/src/orchestrator/index.ts` exports
- Migrate or preserve `client.ts` if needed by other packages
- Remove unused dependencies from `packages/generacy/package.json`

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Single server implementation | 0 duplicate server files | Old orchestrator server files are deleted |
| SC-002 | CLI feature parity | 100% of Fastify features accessible via CLI | Manual verification: health, metrics, webhooks, dispatch, auth all work |
| SC-003 | Backward compatibility | All existing CLI flags still work | Run `generacy orchestrator --help` and verify all flags are present and functional |
| SC-004 | Label monitor functionality | Jobs triggered by labels execute successfully | Add trigger label to issue, verify job is queued and executed |
| SC-005 | Startup time | Server starts in < 5 seconds | Measure time from command invocation to first successful health check response |
| SC-006 | Graceful shutdown | Clean exit on SIGINT/SIGTERM | Verify no orphan processes or dangling connections after shutdown |

## Assumptions

- The Fastify server's `createServer()` can be modified to accept programmatic config without breaking existing consumers
- `RedisQueueAdapter` implements the same `QueueAdapter` interface that `LabelMonitorBridge` depends on
- The Fastify server can run without Redis (graceful degradation) to match the old server's in-memory fallback behavior
- SmeeWebhookReceiver and WebhookSetupService are already exported from `@generacy-ai/orchestrator` and can be initialized during Fastify server startup
- No external tools or scripts depend on the exact response format of the old server's 9 endpoints (or the Fastify equivalents are compatible)
- The `orchestrator/client.ts` module will continue to work against the Fastify server's API

## Out of Scope

- Changing the Fastify server's internal architecture or route structure
- Adding new features beyond what exists in either implementation today
- Migrating `orchestrator/client.ts` to a different package (only preserve if needed)
- Changing the authentication model (JWT + API key) — the CLI maps `--auth-token` to the existing auth system
- Modifying worker execution logic (`ClaudeCliWorker`, `PhaseLoop`, etc.)
- Changes to GitHub webhook payload handling logic
- Dashboard or UI changes
- Changes to how `@generacy-ai/orchestrator` is published or versioned
- Issue #291 (centralizing workspace repo lists into `.generacy/config.yaml`) — related but separate

## Related Issues

- #291 — Centralize workspace repo lists into `.generacy/config.yaml`

---

*Generated by speckit*
