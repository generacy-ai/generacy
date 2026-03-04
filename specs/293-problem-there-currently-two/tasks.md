# Tasks: Converge Orchestrator Implementations

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: InMemoryQueueAdapter

### T001 [P] Create InMemoryQueueAdapter implementing QueueManager interface
**File**: `packages/orchestrator/src/services/in-memory-queue-adapter.ts`
- Implement `QueueManager` interface (`enqueue`, `claim`, `release`, `complete`, `getQueueDepth`, `getQueueItems`, `getActiveWorkerCount`)
- Use sorted array for pending queue (sorted by priority descending, then FIFO via `enqueuedAt`)
- Use `Map<workerId, Map<itemKey, QueueItem>>` for claimed items
- Generate `itemKey` as `{owner}/{repo}#{issueNumber}` (matching `RedisQueueAdapter` key format)
- Track `attemptCount` per item key for retry/dead-letter logic (default `maxRetries: 3`)
- Implement dead-letter tracking (items exceeding max retries stored separately)
- Ensure dedup: reject enqueue if item key already exists in pending or claimed

### T002 [P] Write unit tests for InMemoryQueueAdapter
**File**: `packages/orchestrator/src/services/__tests__/in-memory-queue-adapter.test.ts`
- Test enqueue adds items to pending queue
- Test priority ordering (higher priority claimed first)
- Test FIFO within same priority level
- Test claim removes from pending and adds to claimed map
- Test claim returns null when queue is empty
- Test release re-enqueues item to pending
- Test release dead-letters after maxRetries exceeded
- Test complete removes item from claimed map
- Test getQueueDepth returns correct count
- Test getQueueItems returns pending items
- Test getActiveWorkerCount returns count of workers with claimed items
- Test dedup: enqueue rejects duplicate item keys

### T003 [P] Export InMemoryQueueAdapter from package
**Files**:
- `packages/orchestrator/src/services/index.ts`
- `packages/orchestrator/src/index.ts`
- Add `InMemoryQueueAdapter` to service exports
- Add `InMemoryQueueAdapter` to top-level package exports

---

## Phase 2: Bearer Token Auth Compatibility

### T004 [P] Add Bearer token fallback to auth middleware
**File**: `packages/orchestrator/src/auth/middleware.ts`
- After the existing API key check (`x-api-key` header) and before the JWT check:
  1. Extract Bearer token from `Authorization` header using existing `extractBearerToken()`
  2. SHA-256 hash it using `hashApiKey()`
  3. Look up the hashed value in `apiKeyStore`
  4. If found: set `request.auth` with key's scopes and return (authenticated)
  5. If not found: fall through to existing JWT verification path
- This allows the same token registered via `InMemoryApiKeyStore.addKey()` to work with both `X-API-Key` and `Authorization: Bearer` headers

### T005 [P] Write tests for Bearer token auth fallback
**File**: `packages/orchestrator/src/auth/__tests__/middleware.test.ts`
- Test Bearer token is hashed and validated against API key store
- Test valid Bearer token sets correct auth context with scopes
- Test invalid Bearer token falls through to JWT path
- Test `X-API-Key` header still works (no regression)
- Test JWT auth still works when Bearer token not in API key store
- Test unauthenticated request still rejected when auth enabled

---

## Phase 3: Smee/Webhook Lifecycle in Server

### T006 [P] Add smee config section to OrchestratorConfig schema
**File**: `packages/orchestrator/src/config/schema.ts`
- Add `smee` object to `OrchestratorConfigSchema`:
  ```
  smee: { channelUrl?: string (url), fallbackPollIntervalMs: number (min 30000, default 300000) }
  ```
- Add `webhookSetup` object:
  ```
  webhookSetup: { enabled: boolean (default false) }
  ```

### T007 [P] Map SMEE_CHANNEL_URL env var in config loader
**File**: `packages/orchestrator/src/config/loader.ts`
- Map `SMEE_CHANNEL_URL` env var to `smee.channelUrl`
- Map `WEBHOOK_SETUP_ENABLED` env var to `webhookSetup.enabled`

### T008 Integrate SmeeWebhookReceiver and WebhookSetupService lifecycle into Fastify server
**File**: `packages/orchestrator/src/server.ts`
- **Depends on**: T006, T007
- After `LabelMonitorService` creation, if `config.smee.channelUrl` is set:
  1. Import and create `SmeeWebhookReceiver` with the label monitor instance and watched repositories
  2. Set label monitor poll interval to `config.smee.fallbackPollIntervalMs`
  3. Disable adaptive polling on label monitor (Smee provides real-time events)
- In `onReady` hook:
  1. Start `SmeeWebhookReceiver` if created
  2. If `config.webhookSetup.enabled`, run `WebhookSetupService.ensureWebhooks()` for each repository
- In graceful shutdown cleanup:
  1. Stop `SmeeWebhookReceiver` if running

---

## Phase 4: Move Issue Enrichment into LabelMonitorService

### T009 [P] Add issue description fetching to LabelMonitorService.processLabelEvent()
**File**: `packages/orchestrator/src/services/label-monitor-service.ts`
- In `processLabelEvent()`, after dedup check and before `queueAdapter.enqueue()`:
  1. Call `this.createGitHubClient(owner).rest.issues.get({ owner, repo, issue_number })` to fetch issue details
  2. Extract description from issue body (fall back to issue title if body is empty)
  3. Attach `description` to `QueueItem.metadata` (extend `QueueItem` type if needed)
- Wrap in try/catch: log warning on failure, use fallback description string like `"Issue #{issueNumber}"`
- This eliminates the need for `LabelMonitorBridge` which currently does this enrichment

### T010 [P] Update ClaudeCliWorker to read description from QueueItem metadata
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- In `handle()` method, read `item.metadata?.description` if available
- Use it as the issue description instead of fetching separately
- Keep existing fetch-from-GitHub as fallback if metadata.description is missing (backwards compat)

### T011 [P] Extend QueueItem type to support metadata
**File**: `packages/orchestrator/src/types/monitor.ts`
- Add optional `metadata?: Record<string, unknown>` field to `QueueItem` interface
- Ensure `RedisQueueAdapter` serializes/deserializes metadata (check JSON.stringify/parse handling)

---

## Phase 5: Rewrite CLI Command

### T012 Accept optional apiKeyStore in CreateServerOptions
**File**: `packages/orchestrator/src/server.ts`
- **Depends on**: T001, T004, T008, T009
- Add `apiKeyStore?: InMemoryApiKeyStore` to `CreateServerOptions` interface
- In `createServer()`, if `options.apiKeyStore` is provided, use it instead of creating a new `InMemoryApiKeyStore`
- Export updated `CreateServerOptions` type from `packages/orchestrator/src/index.ts`

### T013 Rewrite CLI orchestrator command to use Fastify server
**File**: `packages/generacy/src/cli/commands/orchestrator.ts`
- **Depends on**: T012
- Complete rewrite of the command action:
  1. Import `createServer`, `startServer`, `InMemoryApiKeyStore`, `InMemoryQueueAdapter` from `@generacy-ai/orchestrator`
  2. Build `OrchestratorConfig` from CLI flags + env vars:
     - Map `--port` to `server.port` (default 3100, not 3000)
     - Map `--host` to `server.host`
     - Map `--auth-token` / `ORCHESTRATOR_TOKEN` to auth setup
     - Map `--redis-url` / `REDIS_URL` to `redis.url`
     - Map `--label-monitor` + `--monitored-repos` / `MONITORED_REPOS` to `repositories[]`
     - Map `--poll-interval` / `POLL_INTERVAL_MS` to `monitor.pollIntervalMs`
     - Map `--worker-timeout` to `dispatch.heartbeatTtlMs`
     - Map `--shutdown-timeout` to `dispatch.shutdownTimeoutMs` (new flag)
     - Map `--log-level` to `logging.level` (new flag)
     - Map `--log-pretty` to `logging.pretty` (new flag)
     - Map `SMEE_CHANNEL_URL` to `smee.channelUrl`
  3. If `--auth-token` provided:
     - Create `InMemoryApiKeyStore`, call `addKey(token, { scopes: ['admin'], name: 'cli-token' })`
     - Set `auth.enabled = true` in config
     - Pass `apiKeyStore` into `createServer()` options
  4. Call `createServer({ config, apiKeyStore })`
  5. Call `startServer(server)`
  6. Remove all old code: `createOrchestratorServer()`, `createJobQueue()`, `LabelMonitorBridge`, manual signal handling, manual service creation
- Add new CLI flags:
  - `--shutdown-timeout <ms>` (default: 30000)
  - `--log-level <level>` (default: info)
  - `--log-pretty` (boolean, default: false)

---

## Phase 6: In-Memory Queue Fallback in Server

### T014 Support Redis-free operation in Fastify server using InMemoryQueueAdapter
**File**: `packages/orchestrator/src/server.ts`
- **Depends on**: T001, T012
- When Redis connection fails (existing try/catch block):
  1. Create `InMemoryQueueAdapter` instead of the current logging-only stub
  2. Use it as `queueAdapter` for `LabelMonitorService`
  3. Use it as `QueueManager` for dispatch routes
- This replaces the current behavior where no-Redis mode creates a dummy adapter that only logs

### T015 Support WorkerDispatcher without Redis for heartbeat tracking
**File**: `packages/orchestrator/src/services/worker-dispatcher.ts`
- **Depends on**: T014
- Modify `WorkerDispatcher` constructor to accept `Redis | null`
- When `redis` is `null`:
  - Use `Map<workerId, number>` for heartbeat timestamps instead of Redis keys
  - `updateHeartbeat()`: set timestamp in map instead of `redis.set()`
  - `reapStaleWorkers()`: check map timestamps instead of `redis.get()`
  - `clearHeartbeat()`: delete from map instead of `redis.del()`
- When `redis` is provided: existing Redis-based behavior (no change)
- This allows `WorkerDispatcher` + `ClaudeCliWorker` to work without Redis in local dev

---

## Phase 7: Delete Old Orchestrator Code

### T016 Delete old orchestrator directory
**File**: `packages/generacy/src/orchestrator/`
- **Depends on**: T013
- Delete entire directory and all files:
  - `server.ts`, `client.ts`, `job-queue.ts`, `redis-job-queue.ts`
  - `worker-registry.ts`, `event-bus.ts`, `log-buffer.ts`, `heartbeat.ts`
  - `job-handler.ts`, `label-monitor-bridge.ts`, `router.ts`
  - `async-event-queue.ts`, `types.ts`, `index.ts`
  - `__tests__/` directory and all test files

### T017 Update worker.ts CLI command to not import from old orchestrator
**File**: `packages/generacy/src/cli/commands/worker.ts`
- **Depends on**: T016
- Check all imports from `../../orchestrator/index.js`
- Currently imports: `OrchestratorClient`, `OrchestratorClientError`, `HeartbeatManager`, `JobHandler`, `WorkerRegistration`
- Decision: The worker command talks to the orchestrator via HTTP client. These types are specific to the old server's API contract. Options:
  - If the worker command is still needed (external worker model): move the client/handler types into the orchestrator package or keep a minimal client
  - If the worker command is deprecated (Fastify server uses internal `WorkerDispatcher`): deprecate/remove the worker command
- **Action**: Evaluate whether `worker.ts` is still needed given the new `WorkerDispatcher` model. If not, mark as deprecated. If yes, move client types to orchestrator package.

### T018 Clean up package.json dependencies
**File**: `packages/generacy/package.json`
- **Depends on**: T016
- Check if `ioredis` is only used by old orchestrator code
- If so, remove `ioredis` from dependencies
- Check for any other dependencies only used by deleted code
- Run `pnpm install` to update lockfile

### T019 Remove or update any remaining imports of old orchestrator
**Files**: Various files in `packages/generacy/src/`
- **Depends on**: T016
- Search for any remaining imports of `../orchestrator/`, `../../orchestrator/`, or `./orchestrator/`
- Update or remove as needed
- Check barrel exports (`index.ts` files) that may re-export old orchestrator types

---

## Phase 8: Testing & Validation

### T020 Write integration test: Fastify server starts via CLI config (no Redis)
**File**: `packages/orchestrator/src/__tests__/server-cli-integration.test.ts`
- **Depends on**: T013, T014
- Build an `OrchestratorConfig` mimicking CLI flag mapping
- Call `createServer({ config })` with no Redis URL
- Verify server starts and `/health` returns 200
- Verify `InMemoryQueueAdapter` is used as queue backend
- Verify graceful shutdown works

### T021 Write integration test: auth-token flag registers API key
**File**: `packages/orchestrator/src/__tests__/server-auth-integration.test.ts`
- **Depends on**: T013, T004
- Create `InMemoryApiKeyStore`, add a token
- Pass to `createServer({ config, apiKeyStore })`
- Verify `Authorization: Bearer <token>` authenticates successfully
- Verify `X-API-Key: <token>` authenticates successfully
- Verify invalid tokens are rejected

### T022 Write integration test: label monitoring with Fastify server
**File**: `packages/orchestrator/src/__tests__/server-monitoring-integration.test.ts`
- **Depends on**: T013, T009
- Configure server with `repositories: [{ owner: 'test', repo: 'repo' }]`
- Verify `LabelMonitorService` is initialized
- Verify monitoring starts on server ready
- Verify monitoring stops on server close

### T023 Verify TypeScript compilation and lint
**Files**: All modified/new files
- **Depends on**: All previous tasks
- Run `pnpm -r build` to verify TypeScript compilation across all packages
- Run `pnpm -r lint` to verify no lint errors
- Fix any type errors or lint issues

### T024 Run existing test suites to verify no regressions
**Files**: Existing test files
- **Depends on**: T023
- Run `pnpm -r test` across all packages
- Verify existing orchestrator package tests still pass
- Verify existing generacy package tests still pass (after removing old orchestrator tests)
- Fix any test failures caused by the migration

### T025 Manual validation
- **Depends on**: T024
- Run `generacy orchestrator --port 3100`
- Verify `/health` returns 200
- Run `generacy orchestrator --port 3100 --auth-token test123`
- Verify unauthenticated requests to protected endpoints are rejected
- Verify `Authorization: Bearer test123` authenticates
- Run `generacy orchestrator --port 3100 --label-monitor --monitored-repos org/repo`
- Verify label monitoring initializes (check logs)
- Verify graceful shutdown (send SIGTERM, check clean exit)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phases 1-4 and Phase 6 are independent of each other and can be developed in parallel
- Phase 5 (CLI rewrite) depends on Phases 1, 2, 3, 4, and 6
- Phase 7 (delete old code) depends on Phase 5
- Phase 8 (testing) runs alongside Phases 5-7, with final validation after Phase 7

**Parallel opportunities within phases**:
- **Phase 1**: T001, T002, T003 can all start in parallel (T003 needs T001 exports but is trivial)
- **Phase 2**: T004 and T005 can run in parallel
- **Phase 3**: T006 and T007 can run in parallel; T008 depends on both
- **Phase 4**: T009, T010, T011 can all run in parallel
- **Phase 5**: T012 then T013 (sequential)
- **Phase 6**: T014 then T015 (sequential)
- **Phase 7**: T016 first, then T017, T018, T019 in parallel
- **Phase 8**: T020-T022 in parallel after implementation; T023, T024, T025 sequential

**Critical path**:
```
T001 ──┐
T004 ──┤
T006 → T007 → T008 ──┤
T009 ──┤──→ T012 → T013 → T016 → T023 → T024 → T025
T011 ──┤
T014 → T015 ──┘
```

**Estimated scope**: ~15 files modified, ~3 files created, ~15 files deleted
