/**
 * Reason an item was enqueued — determines priority tier.
 * - 'resume': Continue in-progress work (highest priority)
 * - 'retry': Re-attempt failed work
 * - 'new': Fresh issue trigger (lowest priority, FIFO)
 */
export type QueueReason = 'new' | 'resume' | 'retry';

/**
 * Queue item for workflow processing
 */
export interface QueueItem {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Issue number */
  issueNumber: number;
  /** Workflow name parsed from label (e.g., "speckit-feature") */
  workflowName: string;
  /** Command type: "process" for new, "continue" for resume, "address-pr-feedback" for PR review feedback, "resolve-merge-conflicts" for #898 bounded conflict resolution */
  command: 'process' | 'continue' | 'address-pr-feedback' | 'resolve-merge-conflicts';
  /** Priority score (timestamp for FIFO, lower = higher priority) */
  priority: number;
  /** When this item was enqueued */
  enqueuedAt: string;
  /** Optional metadata for command-specific data */
  metadata?: Record<string, unknown>;
  /** Why this item was enqueued — adapters use this to compute priority */
  queueReason?: QueueReason;
  /** Cluster owner's user ID — used for lease requests */
  userId?: string;
}

/**
 * Metadata for the address-pr-feedback command
 */
export interface PrFeedbackMetadata {
  /** PR number on the repository */
  prNumber: number;
  /** IDs of unresolved review threads at detection time */
  reviewThreadIds: number[];
  /**
   * #1070 D-1: Number of auto-retries dispatched so far for this trigger,
   * INCLUDING this dispatch. Original cycle = 0. First auto-retry = 1.
   * Second auto-retry = 2 (last permitted per Q5=C max=2).
   *
   * Written by PrFeedbackMonitorService at every enqueue (both the normal
   * path and the retry-eligible branch). Read by PrFeedbackHandler on the
   * timeout+hasChanges disposition to decide between
   * `blocked:fixer-timeout` (< 2) and `blocked:fixer-timeout-repeat` (>= 2).
   *
   * Optional for backwards compatibility with in-flight QueueItems queued
   * before this PR lands. Handler reads `?? 0`.
   */
  retryAttempt?: number;
}

/**
 * Metadata for the `resolve-merge-conflicts` command (#898).
 *
 * `conflictedPathsAtPause` and `prNumber` are advisory. The handler re-derives
 * them independently. `phase` (added in #902) is the interrupted phase carried
 * in-band from the phase-loop pause site — required at handler entry for the
 * re-arm path; absence triggers fail-loud per FR-004.
 *
 * #1131: the resolution base/head SHAs a resolution-scoped review needs do NOT
 * live here. They travel on the re-armed outcome's `reviewScope`
 * (`ReArmedOutcome.reviewScope` → `WorkerContext.reviewScope`), because this
 * sidecar is cleared immediately after re-arm and would be gone by the time the
 * review executor runs. Do not add a SHA field here. `phase` stays required for
 * the fail-loud guard and the flag-OFF (`reviewPhaseEnabled === false`) fallback.
 */
export interface ResolveMergeConflictsMetadata {
  /** Advisory snapshot of conflicted paths at pause time. */
  conflictedPathsAtPause?: string[];
  /** Advisory PR number if monitor resolved it. */
  prNumber?: number;
  /**
   * NEW in #902 (FR-003).
   * Interrupted phase carried in-band from the phase-loop pause site.
   * Populated by the worker at handler dispatch (from the pause-context
   * sidecar in the workflow state store).
   *
   * Absence at handler entry → fail-loud per FR-004 / #889 terminal path.
   * MUST NOT be re-derived from labels.
   *
   * Optional at parse time because the monitor cannot construct it — only
   * the worker (after reading the pause-context sidecar) populates it.
   */
  phase?: import('../worker/types.js').WorkflowPhase;
}

/**
 * Represents a PR review event from webhook or polling
 */
export interface PrReviewEvent {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** PR number */
  prNumber: number;
  /** PR body text */
  prBody: string;
  /** Head branch name */
  branchName: string;
  /** How this event was detected */
  source: 'webhook' | 'poll';
  /**
   * NEW (#1049): whether the PR is currently merged. Read from
   * `payload.pull_request.merged` on the webhook path; always `false`
   * on the poll path (poll lists open PRs only). Used by the merged-PR
   * gate (FR-008) to reject reviews on merged PRs before any checkout
   * / fetch / push code path runs — see spec US4.
   */
  prMerged: boolean;
}

/**
 * Result of linking a PR to an orchestrated issue
 */
export interface PrToIssueLink {
  /** PR number */
  prNumber: number;
  /** Linked issue number */
  issueNumber: number;
  /** How the link was resolved */
  linkMethod: 'pr-body' | 'branch-name';
  /** Issue assignees (returned from PrLinker to avoid duplicate getIssue calls) */
  assignees: string[];
}

/**
 * GitHub webhook payload for pull_request_review and pull_request_review_comment events
 */
export interface GitHubPrReviewWebhookPayload {
  action: string;
  review?: {
    id: number;
    state: string;
    body: string | null;
    user: { login: string };
  };
  comment?: {
    id: number;
    body: string;
    path: string;
    line: number | null;
    user: { login: string };
    in_reply_to_id?: number;
  };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    head: { ref: string; sha: string };
    base: { ref: string };
    state: string;
    merged?: boolean;             // NEW (#1049)
    merged_at?: string | null;    // NEW (#1049) — carried for observability; not consumed
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
}

/**
 * Parsed label event from webhook or polling
 */
export interface LabelEvent {
  /** Event type */
  type: 'process' | 'resume';
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Issue number */
  issueNumber: number;
  /** Full label name (e.g., "process:speckit-feature") */
  labelName: string;
  /** Parsed workflow/phase name */
  parsedName: string;
  /** Source of detection */
  source: 'webhook' | 'poll';
  /** All labels on the issue at detection time */
  issueLabels: string[];
}

/**
 * GitHub webhook payload for issues.labeled events
 */
export interface GitHubWebhookPayload {
  action: string;
  label: {
    name: string;
    color: string;
    description: string;
  };
  issue: {
    number: number;
    title: string;
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
}

/**
 * Internal state tracked by the monitor service
 */
export interface MonitorState {
  /** Whether the polling loop is running */
  isPolling: boolean;
  /**
   * Whether the configured webhook path is currently delivering events.
   * Only meaningful when `webhooksConfigured === true`.
   */
  webhookHealthy: boolean;
  /**
   * Timestamp of the last webhook event received. Stays `null` until the
   * corresponding inbound path calls `recordWebhookEvent`. On smee clusters,
   * the receiver fans out to all four monitors (#987 FR-004).
   */
  lastWebhookEvent: number | null;
  /** Current effective poll interval (adaptive) */
  currentPollIntervalMs: number;
  /** Configured base poll interval */
  basePollIntervalMs: number;
  /**
   * #953: Whether a webhook feeder is configured for this service.
   * Set at construction from a per-service derivation rule; may be
   * flipped `false → true` at runtime by #987's `setWebhooksConfigured(true)`
   * once `startSmeePipeline` observes the smee receiver connect.
   * Never flipped back to `false` — receiver-death recovery is handled by
   * the controller's `webhook-stale → to-fast` branch.
   */
  webhooksConfigured: boolean;
}

/**
 * Queue adapter interface for enqueuing items
 */
export interface QueueAdapter {
  /**
   * Atomically enqueue an item, dropping if its `itemKey` is already in
   * flight (pending or claimed by any worker).
   *
   * Invariant: after `enqueue(item)` returns `true`, `item.itemKey` MUST
   * be a member of the in-flight index (`orchestrator:queue:in-flight-items`
   * on the Redis adapter, `inFlightSet` on the in-memory adapter). Every
   * implementation of this interface is bound to the end-to-end equality
   * `in-flight = pending ∪ claimed` at every intermediate step of the
   * `enqueue → claim → release-retry → reclaim-orphan → complete` sequence.
   *
   * ERROR contract (PR #1065 review finding 4): implementations MUST NOT
   * conflate "already in flight" with "transport error". On transport
   * failure, this method throws — callers that dedup on a `false` return
   * would otherwise silently drop a real intake on a transient Redis blip.
   * Sibling `enqueueIfAbsent` intentionally swallows errors (its callers
   * treat the two the same way); `enqueue`'s caller does not.
   *
   * @returns true if enqueued, false if dropped because the itemKey is
   *          already in flight.
   * @throws  the underlying transport error on Redis / adapter failure.
   */
  enqueue(item: QueueItem): Promise<boolean>;
}

/**
 * Queue item with its priority score, used for listing
 */
export interface QueueItemWithScore {
  item: QueueItem;
  score: number;
}

/**
 * Internal representation stored in Redis, adding retry tracking
 */
export interface SerializedQueueItem extends QueueItem {
  /**
   * Number of times this item's own execution failed and it was released.
   * Bumped exclusively by `QueueManager.release()`. Consumed by `release()`'s
   * dead-letter gate at `attemptCount >= maxRetries`. MUST NOT be bumped by
   * infrastructure events (orphan reclaim, cluster restart) — those would
   * condemn blameless items after N infra events (see #1054 finding 9).
   */
  attemptCount: number;
  /**
   * #1054 finding 9 — diagnostic counter for orphan-reclaims of this item.
   * Bumped by `reapOrphanClaims`. NEVER read by any dead-letter or retry
   * gate; purely observability so operators can distinguish an item that
   * has genuinely failed N times (`attemptCount` high) from one that has
   * just weathered N cluster restarts (`reclaimCount` high).
   *
   * Optional for backwards compatibility — legacy payloads written before
   * this field existed round-trip as `undefined`; callers must default to 0.
   */
  reclaimCount?: number;
  /**
   * #1054 finding 3 — ISO timestamp stamped by CLAIM_SCRIPT at claim time.
   * Reaper's grace-window (FR-005) measures age-since-CLAIM, not
   * age-since-enqueue, so an item that waited hours in pending doesn't
   * skip the grace window the instant it's claimed.
   *
   * Optional for backwards compatibility — legacy claim payloads written
   * before this field existed fall back to `enqueuedAt` for the age
   * calculation.
   */
  claimedAt?: string;
  /** Unique key for deduplication in the sorted set */
  itemKey: string;
}

/**
 * Extended queue interface for dispatch operations.
 * The monitor only uses enqueue() via QueueAdapter.
 * The dispatcher and routes use the full QueueManager interface.
 */
export interface QueueManager extends QueueAdapter {
  /** Atomically claim the highest-priority item for a worker */
  claim(workerId: string): Promise<QueueItem | null>;
  /**
   * Release a claimed item back to the pending queue.
   *
   * Consumes a retry attempt (`attemptCount++`) and dead-letters at
   * `maxRetries`. INTENDED for handler-failure paths only. For
   * infrastructure events (lease expiry, cluster restart) that must NOT
   * consume an attempt, use `requeueForResume`.
   *
   * #1060 PR #1065 review finding 1 — the retry branch is null-guarded:
   * if the claim hash entry is already gone (reaper race), the method
   * returns without a `ZADD pending`, avoiding a duplicate pending
   * member for the itemKey.
   */
  release(workerId: string, item: QueueItem): Promise<void>;
  /**
   * #1060 PR #1065 review finding 2 — re-pend after an infrastructure
   * event (lease expiry) WITHOUT consuming a retry attempt.
   *
   * `attemptCount` is preserved verbatim; the item re-enters pending at
   * `resume` priority. In-flight-SET membership is preserved (the item
   * was and remains in flight — SREM is never issued). Reaper-race
   * safe: if the claim hash entry is already gone, returns without a
   * `ZADD pending`, avoiding a duplicate pending member.
   *
   * Never throws; Redis errors are logged at `warn` and swallowed
   * (matches `release()` / `complete()` error contract).
   */
  requeueForResume(workerId: string, item: QueueItem): Promise<void>;
  /** Mark a claimed item as complete and remove it */
  complete(workerId: string, item: QueueItem): Promise<void>;
  /** Get the number of items in the pending queue */
  getQueueDepth(): Promise<number>;
  /** Get paginated list of pending items with scores */
  getQueueItems(offset: number, limit: number): Promise<QueueItemWithScore[]>;
  /** Get the number of currently active (claimed) workers */
  getActiveWorkerCount(): Promise<number>;
  /**
   * Atomically enqueue an item iff its `itemKey` is not already in flight
   * (pending or claimed by any worker).
   *
   * Semantics (per clarifications Q1 → B, Q2 → A, Q3 → A, Q4 → A):
   *   - itemKey = `<owner>/<repo>#<issue>`
   *   - "In flight" = membership in `orchestrator:queue:in-flight-items`, which
   *     tracks the union of pending + claimed. Orphaned claims count as in-flight
   *     until the dispatcher's reclaim path fires.
   *   - Race-free: two concurrent calls with the same itemKey → one returns true,
   *     the other returns false. No double-enqueue.
   *   - Redis-error safe: returns false + logs warn on transport failure. Caller's
   *     poll cycle re-fires the event.
   *
   * @returns true if the item was enqueued, false if it was already in flight or
   *          a transport error occurred.
   */
  enqueueIfAbsent(item: QueueItem): Promise<boolean>;
  /**
   * Observability helper — SISMEMBER against the in-flight SET.
   * NOT used on the dedupe path (Q1: enqueueIfAbsent is the atomic gate).
   * Exposed for admin/queue routes and future cockpit views.
   */
  hasInFlight(itemKey: string): Promise<boolean>;
  /**
   * #1054 / FR-001 / FR-002 / FR-004: reclaim orphaned claims whose owning
   * worker's heartbeat is absent. Runs on the dispatcher's reaper cadence.
   *
   * Race safety (US2): the outer-loop `EXISTS heartbeat` check is an
   * optimization; the load-bearing guard is the server-side re-check inside
   * `RECLAIM_ORPHAN_SCRIPT`. A heartbeat that re-appears between the two
   * checks aborts the reclaim without mutating state.
   *
   * Grace window (FR-005): claims younger than `2 × heartbeatCheckIntervalMs`
   * are skipped to defend against a hypothetical future refactor that splits
   * `CLAIM_SCRIPT`'s atomicity.
   *
   * @param now epoch-ms; parameterized for testability (default `Date.now()`)
   */
  reapOrphanClaims(now?: number): Promise<ReapReport>;
  /**
   * #1058 / FR-001: reconciliation sweep for `orchestrator:queue:in-flight-items`
   * members that have no matching pending or claim entry (the residue class of
   * failure that `reapOrphanClaims` cannot see — its sweep is candidate-set-
   * driven from `claimed:*` keys). Runs on the dispatcher's reaper cadence
   * immediately after `reapOrphanClaims` (AD-5), plus one boot sweep at
   * process start (Q2=B).
   *
   * Two-sweep confirmation gate (Q1=D): a residue candidate must be observed
   * as residue in two consecutive sweeps before removal. Cross-sweep state
   * lives in an in-memory `Map<itemKey, firstSeenSweepId>` on the adapter.
   * First-sweep observations log at `debug`; second-sweep confirmations
   * invoke `RECONCILE_IN_FLIGHT_SCRIPT` (single-key atomic `SISMEMBER`+`SREM`).
   *
   * On successful `SREM`: `enqueuedAtCache.delete(itemKey)` AND
   * `dropLogState.delete(itemKey)` fire (AD-6 / Q3=C — full cleanup matches
   * `complete()`, dead-letter, and successful reclaim semantics).
   *
   * Never throws. On transport error mid-sweep: `warn` + returns partial
   * report so subsequent cycles retry.
   *
   * @param now epoch-ms; parameterized for testability (default `Date.now()`)
   */
  reconcileInFlight(now?: number): Promise<ReconcileReport>;
  /**
   * #1054 / FR-006 / FR-007: observability accessor — returns the age in ms
   * of the given itemKey's in-flight entry, or `null` if not in flight OR on
   * transport error. Called by monitor-side drop sites to compute `ageMs`
   * for the shared severity dispatcher.
   */
  hasInFlightAge(itemKey: string): Promise<number | null>;
}

/**
 * #1054 — one entry per reclaimed orphan produced by
 * `QueueManager.reapOrphanClaims`.
 *
 * #1054 finding 9 — the reaper bumps `reclaimCount`, NOT `attemptCount`,
 * so `attemptCountBefore === attemptCountAfter` on every reclaimed item
 * (kept in the shape for wire compatibility). The load-bearing pair is
 * `reclaimCountBefore` / `reclaimCountAfter`.
 */
export interface ReclaimedItem {
  workerId: string;
  itemKey: string;
  ageMs: number;
  /** Preserved verbatim across reclaim (attemptCount tracks execution failures, not infra events). */
  attemptCountBefore: number;
  /** Equal to attemptCountBefore — kept in the shape for wire compatibility. */
  attemptCountAfter: number;
  /** Reclaim count before the sweep (0 for first reclaim, else N). */
  reclaimCountBefore: number;
  /** Reclaim count after the sweep (always reclaimCountBefore + 1). */
  reclaimCountAfter: number;
}

/**
 * #1054 — aggregate result of one `reapOrphanClaims` sweep. Consumed by
 * `WorkerDispatcher.reaperLoop`'s per-cycle log line (info when nonzero).
 */
export interface ReapReport {
  /** Number of claim (workerId, itemKey) pairs iterated. */
  scanned: number;
  /** Successfully reclaimed items. */
  reclaimed: ReclaimedItem[];
  /** Skipped because heartbeat re-appeared server-side (US2 defence). */
  skippedRaceReappeared: number;
  /** Skipped because claim was within the grace window (FR-005). */
  skippedGraceWindow: number;
}

/**
 * #1058 — aggregate result of one `reconcileInFlight` sweep. Consumed by
 * `WorkerDispatcher.reaperLoop`'s per-cycle log line (info when nonzero).
 * Log gate: `reconciled > 0 || skippedAlreadyGone > 0 || trackedFirstSeen > 0`.
 * A fully healthy cycle produces zero log lines.
 */
export interface ReconcileReport {
  /** Number of `IN_FLIGHT_KEY` members examined via `SSCAN`. */
  scanned: number;
  /**
   * Number of `SREM`s successfully issued this cycle (post two-sweep
   * confirmation, post-Lua atomic re-check). Each corresponds to exactly
   * one `orphan-in-flight-reconciled` warn line (or contributes to the
   * aggregate line if `RECONCILE_LOG_CAP` is exceeded).
   */
  reconciled: number;
  /**
   * Confirmed residue candidates whose `RECONCILE_IN_FLIGHT_SCRIPT`
   * returned `0` (SISMEMBER == 0 — item was already gone from
   * `IN_FLIGHT_KEY` at Lua time, i.e. a concurrent
   * `complete()`/`release()`/`reapOrphanClaims()` fired the `SREM`
   * between snapshot and Lua). Tracker entry retained; next sweep
   * re-evaluates. Distinct from `ReapReport.skippedRaceReappeared` —
   * the two report opposite polarities and the shared root name in
   * `ReapReport` refers to a heartbeat that _re-appeared_ (opposite of
   * "gone").
   */
  skippedAlreadyGone: number;
  /**
   * Number of itemKeys inserted into `reconcileTracker` this cycle
   * (first-sweep observations). These will be re-evaluated on the next
   * sweep; if still residue, they graduate to `reconciled` (or
   * `skippedAlreadyGone` on Lua race). If they re-appear in
   * pending/claimed before then, they are silently dropped from the
   * tracker (transient race artifact self-clear).
   */
  trackedFirstSeen: number;
}

/**
 * Represents an active worker tracked by the dispatcher
 */
export interface WorkerInfo {
  /** Unique worker ID */
  workerId: string;
  /** The item being processed */
  item: QueueItem;
  /** When the worker started processing */
  startedAt: number;
  /** Heartbeat refresh interval handle */
  heartbeatInterval: NodeJS.Timeout;
  /** Promise resolving when the handler completes */
  promise: Promise<void>;
}

/**
 * Callback signature for processing queue items.
 *
 * Returns a `WorkerResult` discriminant that the dispatcher branches on:
 * - `'completed'` — happy path; queue.complete()
 * - `'failed-terminal'` — label-op exhaustion or similar caught terminal failure;
 *   queue.complete() (NOT released) + best-effort recovery via terminalFailureHandler
 *
 * Non-`WorkerResult` throws still propagate; the dispatcher catches them and
 * releases the item back to the queue (unchanged behavior for generic errors).
 */
export type WorkerHandler = (item: QueueItem) => Promise<import('../worker/worker-result.js').WorkerResult>;

/**
 * Phase tracker interface for deduplication
 */
export interface PhaseTracker {
  isDuplicate(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
  markProcessed(owner: string, repo: string, issue: number, phase: string): Promise<void>;
  clear(owner: string, repo: string, issue: number, phase: string): Promise<void>;
  /**
   * Atomically check and mark as processed (SET NX).
   * Returns true if this call won the race (not a duplicate).
   * Returns false if already processed (duplicate).
   */
  tryMarkProcessed(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
  /**
   * Raw-key variants for callers that own the full key namespace (#892).
   * Semantically identical to isDuplicate/markProcessed but with the caller
   * controlling the entire key string. Used by BaseAdvanceMonitorService
   * which needs `base-advance-tracker:` keys sitting outside the `phase-tracker:`
   * namespace.
   */
  isDuplicateRaw(key: string): Promise<boolean>;
  markProcessedRaw(key: string): Promise<void>;
  /**
   * Raw-key arbitrary-string get/set/clear (#1107). Unlike the boolean
   * mark/isDuplicate pair, these store and return an opaque string value with
   * an explicit TTL. Used by the implement-phase product-diff guard to persist
   * the phase-start commit ref across increments.
   */
  getValueRaw(key: string): Promise<string | null>;
  setValueRaw(key: string, value: string, ttlSeconds: number): Promise<void>;
  clearRaw(key: string): Promise<void>;
}
