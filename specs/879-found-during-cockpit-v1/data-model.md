# Data Model: PR-feedback dedupe migration (#879)

This is a caller-site migration — no new persisted entities, no new schemas. The relevant "data model" is the shape of the interfaces being edited and the log lines that materialize the operator-facing contract.

## Interfaces Modified

### `PrFeedbackMonitorService` constructor (`packages/orchestrator/src/services/pr-feedback-monitor-service.ts`)

**Before** (11 positional args):

```typescript
constructor(
  logger: Logger,
  createClient: GitHubClientFactory,
  phaseTracker: PhaseTracker,                   // ← DELETE (FR-011)
  queueAdapter: QueueAdapter,
  config: PrMonitorConfig,
  repositories: RepositoryConfig[],
  clusterGithubUsername?: string,
  tokenProvider?: () => Promise<string | undefined>,
  authHealth?: AuthHealthSink,
  githubAppCredentialId?: string,
  actingIdentity?: string,
)
```

**After** (10 positional args):

```typescript
constructor(
  logger: Logger,
  createClient: GitHubClientFactory,
  queueManager: QueueManager,                   // ← RETYPED (was QueueAdapter)
  config: PrMonitorConfig,
  repositories: RepositoryConfig[],
  clusterGithubUsername?: string,
  tokenProvider?: () => Promise<string | undefined>,
  authHealth?: AuthHealthSink,
  githubAppCredentialId?: string,
  actingIdentity?: string,
)
```

**Field type widening**: `QueueAdapter` → `QueueManager` (superset with `enqueueIfAbsent`, `hasInFlight`, `claim`, `release`, `complete`, depth accessors). The wiring in `server.ts` already provides a `QueueManager` — this is a type-narrowing at declaration, not a runtime change.

### `PrFeedbackHandler` constructor (`packages/orchestrator/src/worker/pr-feedback-handler.ts`)

**Before** (6 positional args):

```typescript
constructor(
  config: WorkerConfig,
  logger: Logger,
  agentLauncher: AgentLauncher,
  phaseTracker: PhaseTracker,                   // ← DELETE (FR-008 downstream)
  clusterIdentity: string | undefined,
  sseEmitter?: SSEEventEmitter,
)
```

**After** (5 positional args):

```typescript
constructor(
  config: WorkerConfig,
  logger: Logger,
  agentLauncher: AgentLauncher,
  clusterIdentity: string | undefined,
  sseEmitter?: SSEEventEmitter,
)
```

### Removed constants

- `pr-feedback-monitor-service.ts:38`: `const DEDUP_PHASE = 'address-pr-feedback';` — deleted.
- `pr-feedback-handler.ts:19`: `const DEDUP_PHASE = 'address-pr-feedback';` — deleted.

## Interfaces Unchanged

### `QueueAdapter` / `QueueManager` (`packages/orchestrator/src/types/monitor.ts:175-239`)

No shape changes. `QueueManager.enqueueIfAbsent(item: QueueItem): Promise<boolean>` is already declared at line 232 and already implemented in both `RedisQueueAdapter` and `InMemoryQueueAdapter`.

### `PhaseTracker` (`packages/orchestrator/src/types/monitor.ts:265-275`)

Interface unchanged. Implementation `PhaseTrackerService` unchanged. Both stay in the repo — the class-deletion follow-up ships separately (spec Out of Scope).

### `QueueItem` (`packages/orchestrator/src/types/monitor.ts`)

Unchanged. `command: 'address-pr-feedback'` remains a valid queue command. `buildItemKey` on the adapter side continues to return `${owner}/${repo}#${issueNumber}` with no `command` component (Q2→A confirmed).

### `PrFeedbackMetadata` (`packages/orchestrator/src/types/monitor.ts`)

Unchanged.

## Log-line Contracts (Operator-Facing)

These are the observable outputs the SC / FR items measure against.

### FR-009: in-flight drop log (structured `info`)

Emitted from **both** `RedisQueueAdapter` and `InMemoryQueueAdapter` on the `false`-return path of `enqueueIfAbsent`:

| Field | Type | Value |
|-------|------|-------|
| `level` | string | `info` |
| `itemKey` | string | `${owner}/${repo}#${issueNumber}` (from `buildItemKey`) |
| `reason` | string literal | `"in-flight"` |
| msg | string | `Dropping enqueue (item already in flight)` |

Additional caller-side context (source, phase) may be added by the monitor's own log line — but the adapter-level line must carry at minimum `itemKey` and `reason: "in-flight"` per FR-009.

### FR-010: waiting-for label add (idempotent)

Called with `client.addLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback'])` **before** `enqueueIfAbsent`, whenever `unresolvedThreadIds.length > 0` (Case A). Idempotent by GitHub API contract (adding an already-present label returns success no-op). Failure to add is non-fatal warn (unchanged existing behavior).

## Redis Key Space Changes

**Removed writes** (post-migration, nothing writes these):

- `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` — no longer written by the monitor. Existing keys expire on their own ~24h TTL and no longer influence any code path.

**Untouched writes**:

- In-flight `SET` at `queue:in-flight` (owned by `RedisQueueAdapter.enqueueIfAbsent` Lua script) — semantics unchanged.
- Pending `ZSET` at `queue:pending` — semantics unchanged.
- Any other `phase-tracker:*` keys for phases other than `address-pr-feedback` — semantics unchanged (out of scope for this PR per spec).

## Validation Rules

None. There is no new validation — the change is a swap of dedupe mechanism at a caller site. Existing input validation on `PrReviewEvent`, `QueueItem`, and the GitHub client is unchanged.

## Relationships

- `PrFeedbackMonitorService` (producer) → `QueueManager.enqueueIfAbsent` (dedupe checkpoint) → `RedisQueueAdapter` / `InMemoryQueueAdapter` (storage) → `PrFeedbackHandler` (consumer, no dedupe interaction post-migration).
- `PhaseTracker` no longer participates in the `address-pr-feedback` flow. The class stays for other callers; a follow-up PR audits and removes.
