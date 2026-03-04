# Implementation Plan: Converge Orchestrator Implementations

## Summary

Replace the CLI command's use of the old Node.js HTTP server (`packages/generacy/src/orchestrator/server.ts`) with the Fastify-based server from `@generacy-ai/orchestrator`. The CLI command (`orchestrator.ts`) will build an `OrchestratorConfig` from CLI flags/env vars and call `createServer()` + `startServer()` from the orchestrator package. This eliminates dual-server maintenance and gives the CLI all Fastify features (PR feedback monitoring, epic completion, JWT auth, worker dispatcher).

Key changes:
1. Rewrite the CLI command to delegate to the Fastify server
2. Implement `InMemoryQueueAdapter` for Redis-free local development
3. Add Bearer token auth compatibility in the Fastify auth middleware
4. Move SmeeWebhookReceiver and WebhookSetupService lifecycle into the Fastify server
5. Move issue-description enrichment from `LabelMonitorBridge` into `LabelMonitorService`
6. Add `--shutdown-timeout` CLI flag
7. Delete the old orchestrator server code

## Technical Context

- **Language**: TypeScript (ESM)
- **Framework**: Fastify 5, Commander (CLI)
- **Package manager**: pnpm (monorepo)
- **Key packages**:
  - `packages/generacy` — CLI tool (`@generacy-ai/generacy`)
  - `packages/orchestrator` — Fastify server (`@generacy-ai/orchestrator`)
  - `packages/workflow-engine` — GitHub client, workflow engine (`@generacy-ai/workflow-engine`)
- **Runtime**: Node.js ≥ 20
- **Queue**: Redis (ioredis) with in-memory fallback
- **Config**: Zod schemas, YAML files, env vars

## Architecture Overview

### Before (Current)
```
CLI command (orchestrator.ts)
  ├── createJobQueue() → InMemoryJobQueue | RedisJobQueue
  ├── createOrchestratorServer() → old Node.js http.createServer
  ├── Dynamic imports from @generacy-ai/orchestrator:
  │   ├── LabelMonitorService
  │   ├── LabelSyncService
  │   ├── PhaseTrackerService
  │   ├── SmeeWebhookReceiver
  │   └── WebhookSetupService
  └── LabelMonitorBridge → server.submitJob()
```

### After (Target)
```
CLI command (orchestrator.ts)
  ├── Build OrchestratorConfig from CLI flags + env vars
  ├── createServer(config) → Fastify server (from @generacy-ai/orchestrator)
  │   ├── Auth: InMemoryApiKeyStore (auto-hash --auth-token)
  │   ├── Queue: RedisQueueAdapter | InMemoryQueueAdapter (new)
  │   ├── LabelMonitorService (with enrichment, replaces bridge)
  │   ├── PrFeedbackMonitorService (auto-enabled)
  │   ├── EpicCompletionMonitor (auto-enabled)
  │   ├── WorkerDispatcher + ClaudeCliWorker
  │   ├── SmeeWebhookReceiver (lifecycle inside server)
  │   └── WebhookSetupService (onReady hook)
  └── startServer() → listen on configured port/host
```

## Implementation Phases

### Phase 1: InMemoryQueueAdapter (orchestrator package)
**Goal**: Enable the Fastify server to run without Redis by providing an in-memory `QueueManager` implementation.

**Files to create**:
- `packages/orchestrator/src/services/in-memory-queue-adapter.ts`
- `packages/orchestrator/src/services/__tests__/in-memory-queue-adapter.test.ts`

**Implementation**:
- Implement `QueueManager` interface (enqueue, claim, release, complete, getQueueDepth, getQueueItems, getActiveWorkerCount)
- Use a sorted array for the pending queue (sorted by priority, FIFO within same priority)
- Use a `Map<workerId, Map<itemKey, QueueItem>>` for claimed items
- Generate `itemKey` as `{owner}/{repo}#{issueNumber}` (matching Redis adapter)
- Track `attemptCount` per item for retry/dead-letter logic
- No persistence — data lost on restart (acceptable for local dev)

**Export** from `packages/orchestrator/src/services/index.ts` and `packages/orchestrator/src/index.ts`.

### Phase 2: Bearer Token Auth Compatibility (orchestrator package)
**Goal**: Allow existing clients sending `Authorization: Bearer <token>` to authenticate against the Fastify server's API key model.

**Files to modify**:
- `packages/orchestrator/src/auth/middleware.ts`
- `packages/orchestrator/src/auth/api-key.ts`

**Implementation**:
- In `createAuthMiddleware()`, after the API key check and before the JWT check, add a fallback path:
  1. Extract Bearer token from `Authorization` header
  2. SHA-256 hash it using `hashApiKey()`
  3. Validate against `apiKeyStore`
  4. If valid, set auth context and return
  5. If invalid, fall through to JWT verification (existing behavior)
- This means the same token registered via `InMemoryApiKeyStore.addKey(plainToken, ...)` works whether sent as `X-API-Key: <token>` or `Authorization: Bearer <token>`
- The JWT path still fires if the hashed Bearer token isn't found in the API key store (no functional change for actual JWTs)

**Tests to add**:
- `packages/orchestrator/src/auth/__tests__/middleware.test.ts` — test Bearer token hashed and validated against API key store

### Phase 3: SmeeWebhookReceiver & WebhookSetupService Lifecycle in Server (orchestrator package)
**Goal**: Move SmeeWebhookReceiver startup/shutdown and WebhookSetupService one-shot setup into the Fastify server so the CLI doesn't need to manage them externally.

**Files to modify**:
- `packages/orchestrator/src/server.ts`
- `packages/orchestrator/src/config/schema.ts`
- `packages/orchestrator/src/config/loader.ts`

**Config schema additions** (`schema.ts`):
```typescript
// Add to OrchestratorConfigSchema
smee: z.object({
  channelUrl: z.string().url().optional(),
  fallbackPollIntervalMs: z.number().int().min(30000).default(300000),
}).default({})
```

**Config loader additions** (`loader.ts`):
- Map `SMEE_CHANNEL_URL` env var → `smee.channelUrl`

**Server changes** (`server.ts`):
- After creating `labelMonitorService`, if `config.smee.channelUrl` is set:
  1. Create `SmeeWebhookReceiver` with the label monitor and watched repos
  2. Adjust label monitor poll interval to `smee.fallbackPollIntervalMs` and disable adaptive polling
  3. In `onReady` hook: start SmeeWebhookReceiver, run `WebhookSetupService.ensureWebhooks()`
  4. In shutdown cleanup: stop SmeeWebhookReceiver

### Phase 4: Move Issue Enrichment into LabelMonitorService (orchestrator package)
**Goal**: Eliminate the LabelMonitorBridge by moving issue-description fetching into `LabelMonitorService.processLabelEvent()` before calling `queueAdapter.enqueue()`.

**Files to modify**:
- `packages/orchestrator/src/services/label-monitor-service.ts`

**Implementation**:
- In `processLabelEvent()`, after dedup check and before `enqueue()`:
  1. Fetch issue details via `this.createGitHubClient().getIssue(owner, repo, issueNumber)`
  2. Attach `description` (issue body or title fallback) to `QueueItem.metadata`
  3. Catch and log errors gracefully (use fallback description string)
- The `ClaudeCliWorker` already reads from `item.metadata` — update it to read `description` from metadata if present, or fetch it itself as fallback

**Files to modify** (worker side):
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — read `item.metadata.description` if available

### Phase 5: Rewrite CLI Command (generacy package)
**Goal**: Replace the CLI command's use of the old server with `createServer()` + `startServer()` from the orchestrator package.

**Files to modify**:
- `packages/generacy/src/cli/commands/orchestrator.ts` — complete rewrite

**New CLI flags**:
| Flag | Type | Default | Maps to config |
|------|------|---------|----------------|
| `-p, --port <port>` | number | 3100 | `server.port` |
| `-h, --host <host>` | string | 0.0.0.0 | `server.host` |
| `--auth-token <token>` | string | env `ORCHESTRATOR_TOKEN` | registers in `InMemoryApiKeyStore` |
| `--redis-url <url>` | string | env `REDIS_URL` | `redis.url` |
| `--label-monitor` | boolean | env `LABEL_MONITOR_ENABLED` | enables repositories config |
| `--poll-interval <ms>` | number | 30000 | `monitor.pollIntervalMs` |
| `--monitored-repos <repos>` | string | env `MONITORED_REPOS` | `repositories[]` |
| `--worker-timeout <ms>` | number | 60000 | `dispatch.heartbeatTtlMs` |
| `--shutdown-timeout <ms>` | number | 30000 | `dispatch.shutdownTimeoutMs` |
| `--log-level <level>` | string | info | `logging.level` |
| `--log-pretty` | boolean | false | `logging.pretty` |

**Implementation**:
```typescript
import { createServer, startServer, type OrchestratorConfig, InMemoryApiKeyStore, hashApiKey } from '@generacy-ai/orchestrator';

// 1. Parse CLI options
// 2. Build OrchestratorConfig from CLI flags (highest priority overrides)
// 3. If --auth-token provided:
//    a. Set auth.enabled = true
//    b. After createServer(), get apiKeyStore from server and addKey(token, { scopes: ['admin'], name: 'cli-token' })
// 4. Call createServer({ config })
// 5. Call startServer(server)
// 6. Remove all manual signal handling (Fastify's setupGracefulShutdown handles it)
// 7. Remove all manual service creation (Fastify server creates them internally)
```

**Key design decisions**:
- The CLI no longer dynamically imports orchestrator services — they're all initialized inside `createServer()`
- No `setupLabelMonitor()` function needed — repositories in config auto-enables monitoring
- `--label-monitor` flag: when false (default) and no `MONITORED_REPOS` set, `repositories: []` → no monitoring
- When `--label-monitor` is true, requires `--monitored-repos` or `MONITORED_REPOS`
- Auth token: CLI calls `apiKeyStore.addKey(plainToken, ...)` after server creation. Need to expose the `apiKeyStore` instance — either via server decoration or by passing it into `createServer()` options

**Server API change needed** (`server.ts`):
- Accept optional `apiKeyStore` in `CreateServerOptions` so the CLI can pre-register keys:
  ```typescript
  interface CreateServerOptions {
    config?: OrchestratorConfig;
    fastifyOptions?: FastifyServerOptions;
    skipRoutes?: boolean;
    apiKeyStore?: InMemoryApiKeyStore; // New: allow external API key registration
  }
  ```
- If provided, use it instead of creating a new one internally

### Phase 6: Update Fastify Server for In-Memory Queue Fallback (orchestrator package)
**Goal**: When Redis is unavailable, use `InMemoryQueueAdapter` instead of the logging-only stub.

**Files to modify**:
- `packages/orchestrator/src/server.ts`

**Implementation**:
- Import `InMemoryQueueAdapter`
- When Redis connection fails:
  ```typescript
  const inMemoryQueue = new InMemoryQueueAdapter();
  // Use inMemoryQueue as both queueAdapter (for monitors) and QueueManager (for dispatcher)
  ```
- Create `WorkerDispatcher` even without Redis, using the in-memory adapter
- The in-memory adapter doesn't need a Redis client for heartbeats — use timers instead
- Note: `WorkerDispatcher` currently requires a `Redis` instance for heartbeat SET/GET. For in-memory mode, either:
  - Option A: Create an `InMemoryWorkerDispatcher` variant that uses timers
  - Option B: Make `WorkerDispatcher` accept a heartbeat abstraction
  - **Chosen**: Option A is simpler — the `InMemoryQueueAdapter` can include basic worker tracking, and we create a simplified dispatcher that doesn't need Redis. Alternatively, just skip the dispatcher for in-memory mode and have `LabelMonitorService` → `InMemoryQueueAdapter` → `ClaudeCliWorker` directly. **Simplest approach**: Make the `InMemoryQueueAdapter` optionally accept a worker handler and auto-dispatch on enqueue (inline execution). This matches how the old server worked — jobs were executed immediately when claimed.

**Revised approach for no-Redis mode**:
- `InMemoryQueueAdapter` implements `QueueManager` for the dispatch routes
- Create a lightweight `InMemoryDispatcher` that polls the in-memory queue and runs workers, using `setTimeout`-based heartbeats instead of Redis keys
- OR: Make `WorkerDispatcher` constructor accept `Redis | null` and use in-memory heartbeat tracking when null

### Phase 7: Delete Old Orchestrator Code (generacy package)
**Goal**: Remove the old server code and all related files.

**Files to delete**:
- `packages/generacy/src/orchestrator/server.ts`
- `packages/generacy/src/orchestrator/client.ts`
- `packages/generacy/src/orchestrator/job-queue.ts`
- `packages/generacy/src/orchestrator/redis-job-queue.ts`
- `packages/generacy/src/orchestrator/worker-registry.ts`
- `packages/generacy/src/orchestrator/event-bus.ts`
- `packages/generacy/src/orchestrator/log-buffer.ts`
- `packages/generacy/src/orchestrator/heartbeat.ts`
- `packages/generacy/src/orchestrator/job-handler.ts`
- `packages/generacy/src/orchestrator/label-monitor-bridge.ts`
- `packages/generacy/src/orchestrator/router.ts`
- `packages/generacy/src/orchestrator/async-event-queue.ts`
- `packages/generacy/src/orchestrator/types.ts`
- `packages/generacy/src/orchestrator/index.ts`
- `packages/generacy/src/orchestrator/__tests__/*` (all test files)

**Files to check/update**:
- `packages/generacy/src/orchestrator/` — delete entire directory
- `packages/generacy/src/cli/commands/worker.ts` — if it imports from old orchestrator, update to use Fastify server's API
- Any other imports of `../../orchestrator/` in the generacy package
- `packages/generacy/package.json` — remove `ioredis` if only used by old orchestrator

### Phase 8: Testing & Validation

**Unit tests**:
- `InMemoryQueueAdapter` — enqueue, claim, release, complete, priority ordering, dead-letter
- Auth middleware Bearer token fallback
- CLI command config building (mock `createServer`)

**Integration tests**:
- Start Fastify server via CLI config builder (no Redis) → verify health endpoint
- Start with `--auth-token` → verify Bearer token auth works
- Start with `--label-monitor` + `--monitored-repos` → verify monitoring services initialize
- Verify graceful shutdown stops all services

**Manual validation**:
- Run `generacy orchestrator --port 3100 --label-monitor --monitored-repos org/repo`
- Verify `/health` returns 200
- Verify label monitoring polls repositories
- Verify `--auth-token` protects endpoints

## Key Technical Decisions

### D1: InMemoryQueueAdapter vs Inline Execution
**Decision**: Implement a proper `InMemoryQueueAdapter` that satisfies `QueueManager`.
**Rationale**: The Fastify server's dispatch routes (`/dispatch/queue/*`) call `getQueueDepth()`, `getQueueItems()`, `getActiveWorkerCount()` on a `QueueManager`. Without a proper implementation, these routes would error. Also enables the `WorkerDispatcher` to poll and dispatch workers, matching production behavior.

### D2: Bearer Token Auth via API Key Store Hashing
**Decision**: Hash Bearer tokens and validate against `InMemoryApiKeyStore`, rather than adding a separate auth path.
**Rationale**: Per Q1 answer — the Fastify auth model uses hashed keys. Auto-hashing Bearer tokens on the validation side means existing clients work unchanged. Single auth store, no special-casing.

### D3: SmeeWebhookReceiver Lifecycle Inside Server
**Decision**: Per Q4 answer — move Smee/webhook lifecycle into the Fastify server as onReady hooks and shutdown cleanup.
**Rationale**: `SmeeWebhookReceiver` feeds events into `LabelMonitorService` which is already created inside the server. Keeping the lifecycle together avoids the CLI needing to reach into server internals.

### D4: Eliminate LabelMonitorBridge
**Decision**: Per Q5 answer — move issue enrichment into `LabelMonitorService.processLabelEvent()`.
**Rationale**: The bridge exists only to fetch issue descriptions and call `server.submitJob()`. With the Fastify server, `LabelMonitorService` calls `queueAdapter.enqueue()` directly. Adding description fetching there eliminates an entire class and indirection layer.

### D5: No `/api/*` Route Prefix
**Decision**: Per Q10 answer — use Fastify's current route paths as canonical.
**Rationale**: No external consumers beyond the deleted `client.ts`. Adding `/api/` would mean changing all Fastify route registrations and tests.

### D6: WorkerDispatcher Without Redis
**Decision**: For in-memory mode, make `WorkerDispatcher` work with `Redis | null` by adding timer-based heartbeat tracking when Redis is unavailable.
**Rationale**: Allows `generacy orchestrator` to dispatch and execute workers locally without Redis, matching the old server's behavior. The alternative (skip dispatcher entirely) would mean no work gets done without Redis.

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Breaking existing `generacy orchestrator` users | Medium | High | Test all CLI flags map correctly; verify health endpoint and monitoring work identically |
| WorkerDispatcher Redis dependency in no-Redis mode | Medium | Medium | Phase 6 handles this; test in-memory path thoroughly |
| Auth regression (Bearer token clients break) | Low | High | Phase 2 adds explicit Bearer→hash fallback with tests |
| Fastify server startup slower than old server | Low | Low | Fastify cold start is typically <500ms; acceptable |
| SmeeWebhookReceiver timing issues when moved to onReady | Low | Medium | Same pattern as polling services — start in background, catch errors |
| Old orchestrator tests reference deleted code | High | Low | Delete tests with code; new behavior tested via integration tests |

## Dependency Graph

```
Phase 1 (InMemoryQueueAdapter)  ──┐
Phase 2 (Bearer Auth Compat)   ──┤
Phase 3 (Smee/Webhook in Server)──┼──→ Phase 5 (Rewrite CLI) ──→ Phase 7 (Delete Old Code)
Phase 4 (Enrichment in Monitor) ──┤                              Phase 8 (Testing)
Phase 6 (In-Memory Fallback)   ──┘
```

Phases 1–4 and 6 can be developed in parallel. Phase 5 depends on all of them. Phase 7 follows Phase 5. Phase 8 runs alongside Phases 5–7.

## Files Changed Summary

### New Files
| File | Purpose |
|------|---------|
| `packages/orchestrator/src/services/in-memory-queue-adapter.ts` | In-memory QueueManager implementation |
| `packages/orchestrator/src/services/__tests__/in-memory-queue-adapter.test.ts` | Tests |

### Modified Files
| File | Changes |
|------|---------|
| `packages/orchestrator/src/server.ts` | Accept apiKeyStore option; Smee/webhook lifecycle; in-memory queue fallback |
| `packages/orchestrator/src/config/schema.ts` | Add `smee` config section |
| `packages/orchestrator/src/config/loader.ts` | Map `SMEE_CHANNEL_URL` env var |
| `packages/orchestrator/src/auth/middleware.ts` | Bearer token → API key hash fallback |
| `packages/orchestrator/src/services/label-monitor-service.ts` | Issue description enrichment |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Read description from item metadata |
| `packages/orchestrator/src/services/worker-dispatcher.ts` | Accept Redis \| null for in-memory mode |
| `packages/orchestrator/src/services/index.ts` | Export InMemoryQueueAdapter |
| `packages/orchestrator/src/index.ts` | Export InMemoryQueueAdapter, apiKeyStore option |
| `packages/generacy/src/cli/commands/orchestrator.ts` | Complete rewrite to use Fastify server |

### Deleted Files
| File | Reason |
|------|--------|
| `packages/generacy/src/orchestrator/server.ts` | Replaced by Fastify server |
| `packages/generacy/src/orchestrator/client.ts` | No consumers after migration |
| `packages/generacy/src/orchestrator/job-queue.ts` | Replaced by InMemoryQueueAdapter |
| `packages/generacy/src/orchestrator/redis-job-queue.ts` | Replaced by RedisQueueAdapter |
| `packages/generacy/src/orchestrator/worker-registry.ts` | Replaced by WorkerDispatcher |
| `packages/generacy/src/orchestrator/event-bus.ts` | Replaced by Fastify SSE |
| `packages/generacy/src/orchestrator/log-buffer.ts` | Replaced by Fastify SSE |
| `packages/generacy/src/orchestrator/heartbeat.ts` | Replaced by WorkerDispatcher |
| `packages/generacy/src/orchestrator/job-handler.ts` | Replaced by ClaudeCliWorker |
| `packages/generacy/src/orchestrator/label-monitor-bridge.ts` | Enrichment moved to LabelMonitorService |
| `packages/generacy/src/orchestrator/router.ts` | Replaced by Fastify routing |
| `packages/generacy/src/orchestrator/async-event-queue.ts` | No longer needed |
| `packages/generacy/src/orchestrator/types.ts` | Types in orchestrator package |
| `packages/generacy/src/orchestrator/index.ts` | Directory removed |
| `packages/generacy/src/orchestrator/__tests__/*` | Tests for deleted code |
