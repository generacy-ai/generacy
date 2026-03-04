# Research: Orchestrator Convergence Technical Decisions

## 1. InMemoryQueueAdapter Design

### QueueManager Interface to Implement

From `packages/orchestrator/src/types/monitor.ts`:

```typescript
interface QueueManager extends QueueAdapter {
  claim(workerId: string): Promise<QueueItem | null>;
  release(workerId: string, item: QueueItem): Promise<void>;
  complete(workerId: string, item: QueueItem): Promise<void>;
  getQueueDepth(): Promise<number>;
  getQueueItems(offset: number, limit: number): Promise<QueueItemWithScore[]>;
  getActiveWorkerCount(): Promise<number>;
}
```

### Data Structures

```typescript
// Pending queue: sorted by priority (lower number = higher priority), FIFO within same priority
private pending: Array<{ item: SerializedQueueItem; score: number }> = [];

// Claimed items per worker
private claimed: Map<string, Map<string, SerializedQueueItem>> = new Map();

// Dead-letter queue
private deadLetter: Array<{ item: SerializedQueueItem; score: number }> = [];
```

### Priority Scoring (matching RedisQueueAdapter)

The `RedisQueueAdapter` uses `item.priority` directly as the ZADD score. Lower score = higher priority. The `InMemoryQueueAdapter` should match this:
- Insert into sorted array maintaining score order
- On claim: pop from front (lowest score = highest priority)

### Item Key Generation

```typescript
const itemKey = `${item.owner}/${item.repo}#${item.issueNumber}`;
```

### Retry/Dead-Letter

- Track `attemptCount` in `SerializedQueueItem`
- On `release()`: increment attemptCount, re-enqueue if < maxRetries, dead-letter otherwise
- Default maxRetries: 3 (from DispatchConfig)

## 2. Bearer Token Auth Flow

### Current Auth Middleware Flow (middleware.ts:40-109)

```
1. Auth disabled?        → anonymous with admin scopes
2. Route in skipRoutes?  → anonymous with no scopes
3. X-API-Key header?     → hash, validate against store
4. Authorization: Bearer? → verify as JWT
5. None?                 → 401
```

### Modified Flow

```
1. Auth disabled?        → anonymous with admin scopes
2. Route in skipRoutes?  → anonymous with no scopes
3. X-API-Key header?     → hash, validate against store
4. Authorization: Bearer?
   a. Hash token, check against API key store  ← NEW
   b. If found → authenticate as API key user  ← NEW
   c. If not found → try JWT verification (existing)
5. None?                 → 401
```

This is backward-compatible: existing JWT tokens still work because they won't be found in the API key store and fall through to JWT verification.

### CLI Token Registration

```typescript
// In CLI command, after createServer():
const apiKeyStore = new InMemoryApiKeyStore();
apiKeyStore.addKey(authToken, {
  name: 'cli-auth-token',
  scopes: ['admin'],
  createdAt: new Date().toISOString(),
});
// Pass apiKeyStore to createServer() options
```

## 3. SmeeWebhookReceiver Server Integration

### Current SmeeWebhookReceiver Constructor (smee-receiver.ts)

```typescript
constructor(
  logger: Logger,
  monitorService: LabelMonitorService,
  options: SmeeReceiverOptions,
)
```

Where `SmeeReceiverOptions`:
```typescript
interface SmeeReceiverOptions {
  channelUrl: string;
  watchedRepos: Set<string>;
  baseReconnectDelayMs?: number;
}
```

### Integration Point in server.ts

After `labelMonitorService` creation (around line 198), before route registration:

```typescript
let smeeReceiver: SmeeWebhookReceiver | null = null;
if (config.smee?.channelUrl && labelMonitorService) {
  const watchedRepos = new Set(config.repositories.map(r => `${r.owner}/${r.repo}`));
  smeeReceiver = new SmeeWebhookReceiver(server.log, labelMonitorService, {
    channelUrl: config.smee.channelUrl,
    watchedRepos,
  });

  // Adjust monitor config for smee mode
  // (monitor already created — can't change config, but adaptive polling flag
  //  should be set in config before monitor creation)
}
```

### Config Schema Addition

```typescript
export const SmeeConfigSchema = z.object({
  channelUrl: z.string().url().optional(),
  fallbackPollIntervalMs: z.number().int().min(30000).default(300000),
});
```

### WebhookSetupService in onReady

```typescript
server.addHook('onReady', async () => {
  // ... existing polling starts ...

  if (smeeReceiver) {
    smeeReceiver.start().catch(err => server.log.error({ err }, 'Smee receiver failed'));
  }

  if (config.smee?.channelUrl && config.repositories.length > 0) {
    const webhookService = new WebhookSetupService(server.log);
    webhookService.ensureWebhooks(config.smee.channelUrl, config.repositories)
      .then(summary => server.log.info({ ...summary }, 'Webhook setup complete'))
      .catch(err => server.log.warn({ err }, 'Webhook setup failed'));
  }
});
```

## 4. WorkerDispatcher Without Redis

### Current Redis Dependencies in WorkerDispatcher

1. **Heartbeat SET** (`runWorker`): `redis.set(key, '1', 'PX', ttlMs)` — sets worker heartbeat with TTL
2. **Heartbeat refresh** (interval): `redis.set(key, '1', 'PX', ttlMs)` — refreshes TTL
3. **Reaper check**: `redis.exists(key)` — checks if heartbeat expired
4. **Cleanup on complete**: `redis.del(key)` — removes heartbeat

### In-Memory Alternative

When `Redis` is null, use a `Map<string, NodeJS.Timeout>` for heartbeat tracking:

```typescript
class InMemoryHeartbeatTracker {
  private timers = new Map<string, NodeJS.Timeout>();
  private expired = new Set<string>();

  setHeartbeat(workerId: string, ttlMs: number): void {
    this.clearHeartbeat(workerId);
    this.expired.delete(workerId);
    this.timers.set(workerId, setTimeout(() => {
      this.timers.delete(workerId);
      this.expired.add(workerId);
    }, ttlMs));
  }

  isExpired(workerId: string): boolean {
    return this.expired.has(workerId);
  }

  clearHeartbeat(workerId: string): void {
    const timer = this.timers.get(workerId);
    if (timer) clearTimeout(timer);
    this.timers.delete(workerId);
    this.expired.delete(workerId);
  }

  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.expired.clear();
  }
}
```

### Approach: Modify WorkerDispatcher Constructor

```typescript
constructor(
  queue: QueueManager,
  redis: Redis | null,  // Changed from Redis to Redis | null
  logger: Logger,
  config: DispatchConfig,
  handler: WorkerHandler,
  labelCleanup?: LabelCleanupFn,
) {
  // If redis is null, use InMemoryHeartbeatTracker
  this.heartbeatTracker = redis
    ? new RedisHeartbeatTracker(redis)
    : new InMemoryHeartbeatTracker();
}
```

## 5. CLI Config Building

### Mapping CLI Flags to OrchestratorConfig

```typescript
function buildConfig(options: CLIOptions): Partial<OrchestratorConfig> {
  const config: Record<string, unknown> = {};

  // Server
  if (options.port) config.server = { port: parseInt(options.port) };
  if (options.host) config.server = { ...config.server, host: options.host };

  // Redis
  const redisUrl = options.redisUrl ?? process.env['REDIS_URL'];
  if (redisUrl) config.redis = { url: redisUrl };

  // Auth (handled separately via apiKeyStore)
  const authToken = options.authToken ?? process.env['ORCHESTRATOR_TOKEN'];
  if (authToken) {
    config.auth = { enabled: true, providers: ['apiKey'] };
  } else {
    config.auth = { enabled: false };
  }

  // Repositories (from --monitored-repos or MONITORED_REPOS)
  const labelMonitor = options.labelMonitor || process.env['LABEL_MONITOR_ENABLED'] === 'true';
  if (labelMonitor) {
    const reposStr = options.monitoredRepos ?? process.env['MONITORED_REPOS'] ?? '';
    config.repositories = parseRepos(reposStr);
  }

  // Monitor
  if (options.pollInterval) config.monitor = { pollIntervalMs: parseInt(options.pollInterval) };

  // Dispatch
  if (options.workerTimeout) config.dispatch = { heartbeatTtlMs: parseInt(options.workerTimeout) };
  if (options.shutdownTimeout) config.dispatch = { ...config.dispatch, shutdownTimeoutMs: parseInt(options.shutdownTimeout) };

  // Logging
  config.logging = { level: options.logLevel ?? 'info', pretty: options.logPretty ?? true };

  // Smee
  if (process.env['SMEE_CHANNEL_URL']) config.smee = { channelUrl: process.env['SMEE_CHANNEL_URL'] };

  return config;
}
```

### Config Precedence Implementation

The CLI builds a config object and passes it to `createServer({ config })`. The `loadConfig()` function in the orchestrator handles env vars > file > defaults. To achieve CLI flags > env vars > file > defaults:

```typescript
// Option 1: Build config manually (CLI handles all merging)
const baseConfig = loadConfig(); // env > file > defaults
const cliOverrides = buildConfigFromFlags(options);
const finalConfig = deepMerge(baseConfig, cliOverrides); // CLI wins
await createServer({ config: finalConfig });

// Option 2: Pass CLI values as env vars before loadConfig() (hacky, not recommended)

// Option 3: Extend CreateServerOptions with overrides
await createServer({ configOverrides: cliOverrides }); // Server merges internally
```

**Chosen**: Option 1. The CLI calls `loadConfig()` to get the base config, then applies CLI flag overrides on top. This gives the desired precedence: CLI flags > env vars > config file > defaults.

## 6. EpicCompletionMonitor Integration

The `EpicCompletionMonitor` (`epic-completion-monitor-service.ts`) is already available in the orchestrator package but not yet initialized in `server.ts`. Per Q12, it should auto-enable when label monitor is active.

### Integration in server.ts

After `labelMonitorService` creation:

```typescript
let epicMonitor: EpicCompletionMonitorService | null = null;
if (config.epicMonitor.enabled && config.repositories.length > 0) {
  epicMonitor = new EpicCompletionMonitorService(
    server.log,
    createGitHubClient,
    config.epicMonitor,
    config.repositories,
  );
}

// In onReady hook:
if (epicMonitor) {
  epicMonitor.startPolling().catch(err =>
    server.log.error({ err }, 'Epic completion monitor failed')
  );
}

// In shutdown cleanup:
if (epicMonitor) {
  epicMonitor.stopPolling();
}
```

## 7. Signals and Process Lifecycle

### Current CLI Signal Handling (to be removed)

The CLI currently registers:
- `SIGTERM` → custom shutdown
- `SIGINT` → custom shutdown
- `uncaughtException` → log and shutdown
- `unhandledRejection` → log and shutdown

### Fastify's setupGracefulShutdown

Already handles:
- `SIGTERM` and `SIGINT` via Fastify's built-in `close()` hook
- Cleanup sequence with configurable timeout
- Ordered shutdown of services

### Decision

The CLI should NOT register its own signal handlers. Instead, rely entirely on the Fastify server's `setupGracefulShutdown()` which is already configured in `createServer()`. The CLI just needs to:
1. Call `createServer()`
2. Call `startServer()`
3. Let Fastify handle everything else

If the CLI needs to log "Orchestrator started" after listen, it can use the resolved address from `startServer()`.
