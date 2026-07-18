# Data Model: Monitor webhook-flip runtime setter

**Feature**: `987-summary-cluster-where-smee`
**Date**: 2026-07-18

This feature changes almost no persistent data — it flips in-memory state on already-constructed services. This document names the affected types and their invariants.

## MonitorState (existing — no schema change)

**Location**: `packages/orchestrator/src/types/monitor.ts:187-211`

```ts
export interface MonitorState {
  isPolling: boolean;
  webhookHealthy: boolean;
  lastWebhookEvent: number | null;
  currentPollIntervalMs: number;
  basePollIntervalMs: number;
  webhooksConfigured: boolean;
}
```

**Change**: the `webhooksConfigured` field's JSDoc currently says "Set once at construction … never mutated." This is inaccurate after #987. Update the JSDoc:

```ts
/**
 * #953: Whether a webhook feeder is configured for this service.
 * Set at construction from a per-service derivation rule; may be
 * flipped `false → true` at runtime by #987's `setWebhooksConfigured(true)`
 * once `startSmeePipeline` observes the smee receiver connect.
 * Never flipped back to `false` — receiver-death recovery is handled by
 * the controller's `webhook-stale → to-fast` branch.
 */
webhooksConfigured: boolean;
```

Also update the `lastWebhookEvent` JSDoc (line 195-198):

```ts
/**
 * Timestamp of the last webhook event received. Stays `null` until
 * the corresponding inbound path calls `recordWebhookEvent`. On smee
 * clusters, the receiver fans out to all four monitors (#987 FR-004).
 */
```

## SetWebhooksConfiguredOptions (new)

**Location**: exported from each of the four monitor service modules (co-located with the class).

```ts
export interface SetWebhooksConfiguredOptions {
  /**
   * The base cadence to run at once webhooks are live. Sets both
   * `state.basePollIntervalMs` and `state.currentPollIntervalMs`.
   * If omitted, the existing `state.basePollIntervalMs` is kept.
   */
  basePollIntervalMs?: number;
}
```

Rationale for symmetric export from all four services: TypeScript structural typing means a single shared type would work, but co-locating keeps each service's public API self-describing and avoids a shared "monitor interface" barrel that would then have to be maintained.

## setWebhooksConfigured method signature (new — on all four services)

```ts
setWebhooksConfigured(configured: true, opts?: SetWebhooksConfiguredOptions): void;
```

**Contract** (formalized in `contracts/setter-contract.md`):

- `configured` is the literal type `true`. TypeScript rejects `false` at compile time. This is Q1=A enforced by the type system, not by runtime assertion.
- Invocations must be idempotent — calling twice with the same `opts` is a no-op. The controller doesn't care whether `webhooksConfigured` transitions `false → true` or stays `true → true`; the state is monotonic.
- Behavior:
  1. `state.webhooksConfigured = true`.
  2. If `opts?.basePollIntervalMs !== undefined`: `state.basePollIntervalMs = opts.basePollIntervalMs; state.currentPollIntervalMs = opts.basePollIntervalMs`.
  3. Does **not** modify `options.adaptivePolling`.
- Concurrency: monitors are single-threaded within the Node event loop; no locking is required. The setter is a synchronous field write.

## SmeeReceiverOptions (extension)

**Location**: `packages/orchestrator/src/services/smee-receiver.ts:23-37`

Existing shape:
```ts
export interface SmeeReceiverOptions {
  channelUrl: string;
  watchedRepos: Set<string>;
  clusterGithubUsername?: string;
  baseReconnectDelayMs?: number;
}
```

Extended shape (add — no changes to existing fields):
```ts
export interface SmeeReceiverOptions {
  channelUrl: string;
  watchedRepos: Set<string>;
  clusterGithubUsername?: string;
  baseReconnectDelayMs?: number;
  /**
   * #987: called exactly once, after the first successful SSE connect
   * (immediately after the `Connected to smee.io channel` log line).
   * Subsequent reconnects do NOT re-invoke. Callers use this to flip
   * `webhooksConfigured=true` on the constructed monitors.
   */
  onConnected?: () => void;
  /**
   * #987 FR-004: sibling monitor refs for broad `recordWebhookEvent()`
   * fan-out. On every inbound event whose repo matches `watchedRepos`,
   * the receiver calls `recordWebhookEvent()` on each provided monitor.
   * Per-event processing dispatch fires only where the receiver has a
   * natural entry point (see contracts/smee-receiver-contract.md).
   */
  prFeedbackMonitor?: PrFeedbackMonitorService;
  mergeConflictMonitor?: MergeConflictMonitorService;
  clarificationAnswerMonitor?: ClarificationAnswerMonitorService;
}
```

**Constructor invariants**:
- All new fields are optional. Existing callers (`server.ts:503-507`, tests) compile unchanged; behavior when the new fields are omitted matches today's behavior.
- The receiver stores each optional monitor ref on `private readonly` fields set in the constructor (mirrors the existing `monitorService` field pattern).

## SmeeReceiver internal state (extension)

Add one private field to track the "connected once" edge:

```ts
private connectedOnceFired = false;
```

Semantics: set to `true` inside `connect()` immediately after the existing `'Connected to smee.io channel'` log line, guarded by a check that it's currently `false`. The `onConnected` callback (from options) is invoked on the same edge.

## ClarificationAnswerMonitorService constructor (schema change)

**Location**: `packages/orchestrator/src/services/clarification-answer-monitor-service.ts:102-137`

Current positional signature (9 args):
```ts
constructor(
  logger: Logger,
  createClient: GitHubClientFactory,
  queueManager: QueueManager,
  config: PrMonitorConfig,
  repositories: RepositoryConfig[],
  clusterGithubUsername?: string,
  tokenProvider?: () => Promise<string | undefined>,
  authHealth?: AuthHealthSink,
  githubAppCredentialId?: string,
);
```

Extended signature (10 args — appended optional):
```ts
constructor(
  logger: Logger,
  createClient: GitHubClientFactory,
  queueManager: QueueManager,
  config: PrMonitorConfig,
  repositories: RepositoryConfig[],
  clusterGithubUsername?: string,
  tokenProvider?: () => Promise<string | undefined>,
  authHealth?: AuthHealthSink,
  githubAppCredentialId?: string,
  webhooksConfigured: boolean = false,
);
```

Body change (constructor):
- Line 135 (`webhooksConfigured: false,` hardcoded in `this.state = {...}` initializer) becomes `webhooksConfigured,` (reading from the new parameter).
- No other constructor changes.

## Event validation rules (new smee dispatch paths)

For per-event processing dispatch added to the smee receiver:

### `pull_request_review` / `pull_request_review_comment`
- Guard: `payload.action === 'submitted'` (review) or `'created'` (comment).
- Guard: `watchedRepos.has(${owner}/${repo})`.
- Guard: `payload.pull_request?.number` and `payload.pull_request?.head?.ref` are non-empty.
- Payload → `PrReviewEvent`: `{ owner, repo, prNumber, prBody, branchName, source: 'webhook' }` (mirrors `pr-webhooks.ts:108-116`).
- Assignee filter: **not** applied at the smee layer — `PrFeedbackMonitorService.processPrReviewEvent` performs its own PR-link + assignee resolution.

### `issue_comment.created`
- Guard: `payload.action === 'created'`.
- Guard: `watchedRepos.has(${owner}/${repo})`.
- Guard: `payload.issue?.number` and `payload.issue?.labels` are present.
- Payload → `ClarificationAnswerEvent`: `{ owner, repo, issueNumber, issueLabels, source: 'poll' }`. Note: the existing type declares `source: 'poll'` as the only variant (spec §"Event Processing" for the clarification monitor). The receiver passes `'poll'` for consistency; a follow-up may widen the type to include `'webhook'`.
- Assignee filter: applied at the smee layer (existing pattern from `smee-receiver.ts:224-241` for label events).

## Related types (no schema change, referenced for completeness)

- `PrReviewEvent` — `packages/orchestrator/src/types/monitor.ts`
- `ClarificationAnswerEvent` — `packages/orchestrator/src/services/clarification-answer-monitor-service.ts:49-55`
- `AdaptivePollDecision` / `AdaptivePollParams` / `AdaptivePollReason` — `packages/orchestrator/src/services/adaptive-poll-controller.ts:10-55`
- `SmeeChannelResolveResult` — `packages/orchestrator/src/services/smee-channel-resolver.ts`

## No persistent data changes

- No database schema changes.
- No new files under `.agency/` or `/var/lib/generacy/`.
- No new environment variables.
- No config schema changes. `config.smee.fallbackPollIntervalMs` is already on `SmeeConfig` (verified at read time — used at `server.ts:479`).
- No changeset entries required beyond the top-level `.changeset/987-monitors-webhook-flip-on-connect.md`.
