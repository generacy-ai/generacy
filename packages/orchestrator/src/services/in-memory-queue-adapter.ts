import type { QueueItem, QueueItemWithScore, QueueManager, SerializedQueueItem } from '../types/index.js';
import type { DispatchConfig } from '../config/index.js';
import { getPriorityScore } from './queue-priority.js';

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

  /** Pending items sorted by priority (lower = higher priority), then FIFO by enqueuedAt */
  private readonly pending: SerializedQueueItem[] = [];
  /** Claimed items: workerId → Map<itemKey, SerializedQueueItem> */
  private readonly claimed = new Map<string, Map<string, SerializedQueueItem>>();
  /** Dead-lettered items */
  private readonly deadLetter: SerializedQueueItem[] = [];
  /** Track attempt counts across claim/release cycles by itemKey */
  private readonly attemptCounts = new Map<string, number>();

  constructor(logger: Logger, config?: Pick<DispatchConfig, 'maxRetries'>) {
    this.logger = logger;
    this.maxRetries = config?.maxRetries ?? 3;
  }

  async enqueue(item: QueueItem): Promise<void> {
    const itemKey = buildItemKey(item);

    // Dedup: reject if item key already exists in pending
    if (this.pending.some((p) => p.itemKey === itemKey)) {
      this.logger.debug(
        { itemKey },
        'Duplicate item key in pending queue, skipping enqueue'
      );
      return;
    }

    // Dedup: reject if item key already claimed by any worker
    for (const workerItems of this.claimed.values()) {
      if (workerItems.has(itemKey)) {
        this.logger.debug(
          { itemKey },
          'Duplicate item key in claimed set, skipping enqueue'
        );
        return;
      }
    }

    const priority = getPriorityScore(item.queueReason);
    const serialized: SerializedQueueItem = {
      ...item,
      priority,
      attemptCount: this.attemptCounts.get(itemKey) ?? 0,
      itemKey,
    };

    this.insertSorted(serialized);

    this.logger.info(
      { owner: item.owner, repo: item.repo, issue: item.issueNumber, priority },
      'Item enqueued to in-memory queue'
    );
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

    let attemptCount = 0;
    if (workerClaimed) {
      const claimed = workerClaimed.get(itemKey);
      if (claimed) {
        attemptCount = claimed.attemptCount + 1;
      }
      workerClaimed.delete(itemKey);
      if (workerClaimed.size === 0) {
        this.claimed.delete(workerId);
      }
    }

    // Track attempt count for future enqueues
    this.attemptCounts.set(itemKey, attemptCount);

    if (attemptCount >= this.maxRetries) {
      // Dead-letter: too many retries
      const deadLetterItem: SerializedQueueItem = {
        ...item,
        attemptCount,
        itemKey,
      };
      this.deadLetter.push(deadLetterItem);
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

  async complete(workerId: string, item: QueueItem): Promise<void> {
    const itemKey = buildItemKey(item);
    const workerClaimed = this.claimed.get(workerId);

    if (workerClaimed) {
      workerClaimed.delete(itemKey);
      if (workerClaimed.size === 0) {
        this.claimed.delete(workerId);
      }
    }

    // Clean up attempt tracking
    this.attemptCounts.delete(itemKey);

    this.logger.info(
      { workerId, itemKey },
      'Item completed and removed from claimed set'
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
