import type {
  QueueItem,
  QueueItemWithScore,
  QueueManager,
  ReapReport,
  ReconcileReport,
  SerializedQueueItem,
} from '../types/index.js';
import type { DispatchConfig } from '../config/index.js';
import { getPriorityScore } from './queue-priority.js';
import {
  classifyDropSeverity,
  emitDropLog,
  type DropTransitionState,
} from './drop-log-helper.js';

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

function buildItemKey(item: QueueItem): string {
  return `${item.owner}/${item.repo}#${item.issueNumber}`;
}

/**
 * In-memory queue adapter implementing QueueManager for Redis-free local development.
 * Uses a sorted array for the pending queue and Maps for claimed/dead-letter tracking.
 */
export class InMemoryQueueAdapter implements QueueManager {
  private readonly logger: Logger;
  private readonly maxRetries: number;
  private readonly maxRunDurationMs: number;

  /** Pending items sorted by priority (lower = higher priority), then FIFO by enqueuedAt */
  private readonly pending: SerializedQueueItem[] = [];
  /** Claimed items: workerId → Map<itemKey, SerializedQueueItem> */
  private readonly claimed = new Map<string, Map<string, SerializedQueueItem>>();
  /** Dead-lettered items */
  private readonly deadLetter: SerializedQueueItem[] = [];
  /** Track attempt counts across claim/release cycles by itemKey */
  private readonly attemptCounts = new Map<string, number>();
  /** In-flight index: itemKeys currently pending or claimed */
  private readonly inFlightSet = new Set<string>();
  /**
   * #1054 / FR-006 — per-itemKey severity state for the `enqueueIfAbsent`
   * drop-log transition-edge decision. Cleared on `complete()` and
   * dead-letter (R6 mitigation).
   */
  private readonly dropLogState = new Map<string, DropTransitionState>();

  constructor(
    logger: Logger,
    config?: Pick<DispatchConfig, 'maxRetries' | 'maxRunDurationMs'>,
  ) {
    this.logger = logger;
    this.maxRetries = config?.maxRetries ?? 3;
    this.maxRunDurationMs = config?.maxRunDurationMs ?? 1_800_000;
  }

  async enqueue(item: QueueItem): Promise<boolean> {
    const itemKey = buildItemKey(item);

    // #1060 / FR-001: dedupe against the full in-flight index (pending ∪
    // claimed) via the SET rather than scanning both. Matches Redis adapter.
    if (this.inFlightSet.has(itemKey)) {
      // #1060 / FR-005: funnel through the same transition-edge log path as
      // Redis + enqueueIfAbsent so the log-line shape matches across adapters
      // and verbs (SC-003).
      const ageMs = await this.hasInFlightAge(itemKey);
      const decision = classifyDropSeverity(
        itemKey,
        ageMs,
        this.maxRunDurationMs,
        this.dropLogState,
      );
      emitDropLog(
        this.logger,
        decision,
        { itemKey, source: 'enqueue', reason: 'in-flight', ageMs },
        'Dropping enqueue (item already in flight)',
      );
      return false;
    }

    const priority = getPriorityScore(item.queueReason);
    const serialized: SerializedQueueItem = {
      ...item,
      priority,
      attemptCount: this.attemptCounts.get(itemKey) ?? 0,
      itemKey,
    };

    this.insertSorted(serialized);
    this.inFlightSet.add(itemKey);

    this.logger.info(
      { owner: item.owner, repo: item.repo, issue: item.issueNumber, priority },
      'Item enqueued to in-memory queue'
    );
    return true;
  }

  async enqueueIfAbsent(item: QueueItem): Promise<boolean> {
    const itemKey = buildItemKey(item);

    if (this.inFlightSet.has(itemKey)) {
      // #879 / FR-009: structured drop signal for the in-flight-collision path.
      // #1054 / FR-006: severity escalates from `info` to `warn` on the
      // transition edge when the wedged in-flight entry's age crosses
      // `maxRunDurationMs`. Structured fields preserved verbatim.
      const ageMs = await this.hasInFlightAge(itemKey);
      const decision = classifyDropSeverity(
        itemKey,
        ageMs,
        this.maxRunDurationMs,
        this.dropLogState,
      );
      emitDropLog(
        this.logger,
        decision,
        { itemKey, reason: 'in-flight', ageMs },
        'Dropping enqueue (item already in flight)',
      );
      return false;
    }

    const priority = getPriorityScore(item.queueReason);
    const serialized: SerializedQueueItem = {
      ...item,
      priority,
      attemptCount: 0,
      itemKey,
    };

    this.inFlightSet.add(itemKey);
    this.insertSorted(serialized);

    this.logger.info(
      { owner: item.owner, repo: item.repo, issue: item.issueNumber, priority, itemKey },
      'Item enqueued to in-memory queue (in-flight-checked)'
    );
    return true;
  }

  async hasInFlight(itemKey: string): Promise<boolean> {
    return this.inFlightSet.has(itemKey);
  }

  /**
   * #1054 / FR-006 / FR-007 — return the age in ms of the given itemKey's
   * in-flight entry (claimed or pending), or `null` if not in flight.
   */
  async hasInFlightAge(itemKey: string): Promise<number | null> {
    const now = Date.now();
    for (const workerItems of this.claimed.values()) {
      const entry = workerItems.get(itemKey);
      if (entry) {
        const ms = Date.parse(entry.enqueuedAt);
        if (Number.isNaN(ms)) return null;
        return now - ms;
      }
    }
    for (const pendingItem of this.pending) {
      if (pendingItem.itemKey === itemKey) {
        const ms = Date.parse(pendingItem.enqueuedAt);
        if (Number.isNaN(ms)) return null;
        return now - ms;
      }
    }
    return null;
  }

  /**
   * #1054 / FR-011 — no-op for the in-memory adapter (in-memory process
   * death is total; no orphaned claim can survive). Returns an empty
   * report so `WorkerDispatcher.reaperLoop` can call this unconditionally.
   */
  async reapOrphanClaims(_now?: number): Promise<ReapReport> {
    return {
      scanned: 0,
      reclaimed: [],
      skippedRaceReappeared: 0,
      skippedGraceWindow: 0,
    };
  }

  /**
   * #1058 / FR-005 — no-op for the in-memory adapter. In-memory `pending`,
   * `claimed`, and `inFlightSet` are first-class fields in the same process
   * that cannot diverge without a bug in this class (caught by
   * `in-memory-queue-adapter.enqueue-invariant.test.ts` and siblings).
   * Returns an empty report so `WorkerDispatcher.reaperLoop` can call this
   * unconditionally without a Redis-vs-in-memory branch.
   *
   * `scanned` returns the set size rather than 0 so a call site logging
   * `scanned` sees a truthful "sweep did examine the set" signal.
   */
  async reconcileInFlight(_now?: number): Promise<ReconcileReport> {
    return {
      scanned: this.inFlightSet.size,
      reconciled: 0,
      skippedRaceReappeared: 0,
      trackedFirstSeen: 0,
    };
  }

  async claim(workerId: string): Promise<QueueItem | null> {
    if (this.pending.length === 0) {
      return null;
    }

    // Pop the highest-priority item (first element — lowest priority score)
    const serialized = this.pending.shift()!;

    // Add to claimed map
    let workerClaimed = this.claimed.get(workerId);
    if (!workerClaimed) {
      workerClaimed = new Map();
      this.claimed.set(workerId, workerClaimed);
    }
    workerClaimed.set(serialized.itemKey, serialized);

    this.logger.info(
      { workerId, itemKey: serialized.itemKey, attempt: serialized.attemptCount },
      'Item claimed from in-memory queue'
    );

    return {
      owner: serialized.owner,
      repo: serialized.repo,
      issueNumber: serialized.issueNumber,
      workflowName: serialized.workflowName,
      command: serialized.command,
      priority: serialized.priority,
      enqueuedAt: serialized.enqueuedAt,
      metadata: serialized.metadata,
      queueReason: serialized.queueReason,
    };
  }

  async release(workerId: string, item: QueueItem): Promise<void> {
    const itemKey = buildItemKey(item);
    const workerClaimed = this.claimed.get(workerId);
    const claimed = workerClaimed?.get(itemKey);

    // #1060 PR #1065 review finding 1 — parity with Redis adapter's
    // null-guard. If the claim entry for this (worker, itemKey) is
    // absent, another actor already re-pended it; skipping the re-queue
    // avoids a duplicate pending entry for the same itemKey (in-memory
    // parity for the ZSET double-member hazard on Redis).
    if (!claimed) {
      this.logger.info(
        { workerId, itemKey },
        'release() called on already-cleared claim — skipping re-pend to avoid duplicate pending entry',
      );
      return;
    }

    const attemptCount = claimed.attemptCount + 1;
    workerClaimed!.delete(itemKey);
    if (workerClaimed!.size === 0) {
      this.claimed.delete(workerId);
    }

    // Track attempt count for future enqueues
    this.attemptCounts.set(itemKey, attemptCount);

    if (attemptCount >= this.maxRetries) {
      // Dead-letter: too many retries. Remove from in-flight index.
      const deadLetterItem: SerializedQueueItem = {
        ...item,
        attemptCount,
        itemKey,
      };
      this.deadLetter.push(deadLetterItem);
      this.inFlightSet.delete(itemKey);
      // #1054 / R6: bound the transition-edge Map growth.
      this.dropLogState.delete(itemKey);
      this.logger.warn(
        { workerId, itemKey, attemptCount, maxRetries: this.maxRetries },
        'Item dead-lettered after max retries'
      );
    } else {
      // Re-queue with retry priority
      const retryPriority = getPriorityScore('retry');
      const requeueItem: SerializedQueueItem = {
        ...item,
        queueReason: 'retry',
        priority: retryPriority,
        attemptCount,
        itemKey,
      };
      this.insertSorted(requeueItem);
      this.logger.info(
        { workerId, itemKey, attemptCount },
        'Item released back to pending queue'
      );
    }
  }

  /**
   * #1060 PR #1065 review finding 2 — re-pend after a lease-expiry event
   * WITHOUT consuming a retry attempt. See `QueueManager.requeueForResume`
   * for full semantics.
   */
  async requeueForResume(workerId: string, item: QueueItem): Promise<void> {
    const itemKey = buildItemKey(item);
    const workerClaimed = this.claimed.get(workerId);
    const claimed = workerClaimed?.get(itemKey);

    if (!claimed) {
      // Reaper (or another lease-expiry firing) already re-pended it.
      this.logger.info(
        { workerId, itemKey },
        'requeueForResume() called on already-cleared claim — skipping re-pend',
      );
      return;
    }

    workerClaimed!.delete(itemKey);
    if (workerClaimed!.size === 0) {
      this.claimed.delete(workerId);
    }

    // Preserve attemptCount verbatim — lease expiry is not a work failure.
    const resumePriority = getPriorityScore('resume');
    const requeueItem: SerializedQueueItem = {
      ...item,
      queueReason: 'resume',
      priority: resumePriority,
      attemptCount: claimed.attemptCount,
      itemKey,
    };
    this.insertSorted(requeueItem);
    this.logger.info(
      {
        workerId,
        itemKey,
        attemptCount: claimed.attemptCount,
        reason: 'lease-expiry',
      },
      'Item re-pended at resume priority (attemptCount preserved)',
    );
  }

  async complete(workerId: string, item: QueueItem): Promise<void> {
    const itemKey = buildItemKey(item);
    const workerClaimed = this.claimed.get(workerId);

    if (workerClaimed) {
      workerClaimed.delete(itemKey);
      if (workerClaimed.size === 0) {
        this.claimed.delete(workerId);
      }
    }

    // Clean up attempt tracking and in-flight index
    this.attemptCounts.delete(itemKey);
    this.inFlightSet.delete(itemKey);
    // #1054 / R6: bound the transition-edge Map growth.
    this.dropLogState.delete(itemKey);

    this.logger.info(
      { workerId, itemKey },
      'Item completed and removed from claimed set + in-flight index'
    );
  }

  async getQueueDepth(): Promise<number> {
    return this.pending.length;
  }

  async getQueueItems(offset: number, limit: number): Promise<QueueItemWithScore[]> {
    return this.pending.slice(offset, offset + limit).map((serialized) => ({
      item: {
        owner: serialized.owner,
        repo: serialized.repo,
        issueNumber: serialized.issueNumber,
        workflowName: serialized.workflowName,
        command: serialized.command,
        priority: serialized.priority,
        enqueuedAt: serialized.enqueuedAt,
        metadata: serialized.metadata,
        queueReason: serialized.queueReason,
      },
      score: serialized.priority,
    }));
  }

  async getActiveWorkerCount(): Promise<number> {
    let count = 0;
    for (const workerItems of this.claimed.values()) {
      count += workerItems.size;
    }
    return count;
  }

  /**
   * Insert an item into the pending array maintaining sort order.
   * Sorted by priority ascending (lower score = higher priority),
   * then by enqueuedAt ascending (FIFO within same priority).
   */
  private insertSorted(item: SerializedQueueItem): void {
    let lo = 0;
    let hi = this.pending.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midItem = this.pending[mid]!;
      if (
        midItem.priority < item.priority ||
        (midItem.priority === item.priority && midItem.enqueuedAt <= item.enqueuedAt)
      ) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    this.pending.splice(lo, 0, item);
  }
}
