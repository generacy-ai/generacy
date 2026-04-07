import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { QueueManager, WorkerHandler, WorkerInfo } from '../types/index.js';
import type { DispatchConfig } from '../config/index.js';
import type { LeaseManager } from './lease-manager.js';

export type LabelCleanupFn = (owner: string, repo: string, issueNumber: number) => Promise<void>;

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Worker dispatcher that polls the queue, processes one job at a time,
 * manages heartbeats, reaps stale workers, and handles graceful shutdown.
 *
 * Each worker container replica runs exactly one job at a time to ensure
 * full isolation. Scaling is achieved by adding container replicas, not
 * by increasing concurrency within a single container.
 *
 * Supports both Redis-based and in-memory heartbeat tracking.
 * When Redis is null, heartbeats are tracked via an in-memory Map with timestamps.
 *
 * Follows the same AbortController pattern as LabelMonitorService.
 */
export class WorkerDispatcher {
  private readonly queue: QueueManager;
  private readonly redis: Redis | null;
  private readonly logger: Logger;
  private readonly config: DispatchConfig;
  private readonly handler: WorkerHandler;
  private readonly activeWorkers = new Map<string, WorkerInfo>();
  private readonly labelCleanup?: LabelCleanupFn;
  /** In-memory heartbeat timestamps (used when Redis is null) */
  private readonly heartbeatTimestamps = new Map<string, number>();
  private abortController: AbortController | null = null;
  private running = false;
  private leaseManager: LeaseManager | null = null;
  /** Tracks leaseId for each active workerId */
  private readonly workerLeases = new Map<string, string>();
  /** Whether polling is paused (e.g., after lease_denied, waiting for slot_available) */
  private pollingPaused = false;

  constructor(
    queue: QueueManager,
    redis: Redis | null,
    logger: Logger,
    config: DispatchConfig,
    handler: WorkerHandler,
    labelCleanup?: LabelCleanupFn,
  ) {
    this.queue = queue;
    this.redis = redis;
    this.logger = logger;
    this.config = config;
    this.handler = handler;
    this.labelCleanup = labelCleanup;
  }

  /**
   * Start the poll loop and reaper loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Worker dispatcher already running');
      return;
    }

    const ac = new AbortController();
    this.abortController = ac;
    this.running = true;

    this.logger.info(
      {
        pollIntervalMs: this.config.pollIntervalMs,
        heartbeatTtlMs: this.config.heartbeatTtlMs,
      },
      'Starting worker dispatcher',
    );

    // Run poll loop and reaper loop concurrently
    await Promise.all([
      this.pollLoop(ac.signal),
      this.reaperLoop(ac.signal),
    ]);

    this.running = false;
    this.logger.info('Worker dispatcher stopped');
  }

  /**
   * Stop the dispatcher gracefully.
   * Waits for in-flight workers up to shutdownTimeoutMs, then releases remaining.
   */
  async stop(): Promise<void> {
    if (!this.abortController) return;

    this.logger.info('Stopping worker dispatcher');
    this.abortController.abort();
    this.abortController = null;

    // Wait for in-flight workers with timeout
    if (this.activeWorkers.size > 0) {
      this.logger.info(
        { activeWorkers: this.activeWorkers.size },
        'Waiting for in-flight workers to complete',
      );

      const workerPromises = Array.from(this.activeWorkers.values()).map(w => w.promise);

      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, this.config.shutdownTimeoutMs),
      );

      await Promise.race([
        Promise.allSettled(workerPromises),
        timeout,
      ]);

      // Release any remaining claimed items
      for (const [workerId, worker] of this.activeWorkers) {
        clearInterval(worker.heartbeatInterval);
        try {
          await this.queue.release(workerId, worker.item);
          this.logger.info({ workerId }, 'Released worker item during shutdown');
        } catch (error) {
          this.logger.warn(
            { err: error, workerId },
            'Failed to release worker item during shutdown',
          );
        }
      }
      this.activeWorkers.clear();
    }
  }

  /**
   * Get the number of active workers.
   */
  getActiveWorkerCount(): number {
    return this.activeWorkers.size;
  }

  /**
   * Check if the dispatcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Inject lease manager for per-user lease gating.
   * When set, dispatch is gated on lease_granted from the cloud.
   * When not set, dispatch proceeds without lease gating (graceful fallback).
   */
  setLeaseManager(manager: LeaseManager): void {
    this.leaseManager = manager;

    // On slot:available, resume polling and attempt dispatch
    manager.on('slot:available', () => {
      if (this.pollingPaused) {
        this.pollingPaused = false;
        this.logger.info('Slot available, resuming polling');
        // Trigger an immediate poll attempt
        this.pollOnce().catch((error) => {
          this.logger.error({ err: error }, 'Error during slot:available poll');
        });
      }
    });

    // On lease:expired, re-enqueue with resume priority
    manager.on('lease:expired', (data) => {
      this.handleLeaseExpired(data).catch((error) => {
        this.logger.error({ err: error }, 'Error handling lease:expired');
      });
    });

    this.logger.info('Lease manager configured for dispatch gating');
  }

  private async handleLeaseExpired(data: { leaseId: string; queueItemId: string; workerId: string }): Promise<void> {
    // Find the active worker for this lease
    let targetWorkerId: string | null = null;
    for (const [wid, leaseId] of this.workerLeases) {
      if (leaseId === data.leaseId) {
        targetWorkerId = wid;
        break;
      }
    }

    if (!targetWorkerId) return;

    const worker = this.activeWorkers.get(targetWorkerId);
    if (!worker) return;

    this.logger.warn(
      { workerId: targetWorkerId, leaseId: data.leaseId },
      'Lease expired, cancelling worker and re-enqueuing with resume priority',
    );

    // Clean up worker
    clearInterval(worker.heartbeatInterval);
    this.clearHeartbeat(targetWorkerId);
    this.workerLeases.delete(targetWorkerId);
    this.activeWorkers.delete(targetWorkerId);

    // Re-enqueue with resume priority (0) — check for duplicates first
    const existingItems = await this.queue.getQueueItems(0, 100);
    const itemKey = `${worker.item.owner}/${worker.item.repo}#${worker.item.issueNumber}`;
    const isDuplicate = existingItems.some(
      (qi) => `${qi.item.owner}/${qi.item.repo}#${qi.item.issueNumber}` === itemKey,
    );

    if (!isDuplicate) {
      await this.queue.enqueue({
        ...worker.item,
        priority: 0, // Resume priority (highest)
        queueReason: 'resume',
        enqueuedAt: new Date().toISOString(),
      });
      this.logger.info({ itemKey }, 'Re-enqueued with resume priority after lease expiry');
    } else {
      this.logger.info({ itemKey }, 'Skipped re-enqueue (duplicate already in queue)');
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error({ err: error }, 'Error during poll cycle');
      }

      await this.sleep(this.config.pollIntervalMs, signal);
    }
  }

  private async pollOnce(): Promise<void> {
    // Skip polling if paused (waiting for slot_available after lease_denied)
    if (this.pollingPaused) return;

    // Skip if cluster has been rejected
    if (this.leaseManager?.isClusterRejected) {
      this.logger.debug('Cluster rejected, skipping poll');
      return;
    }

    // Worker cap: respect tier limit when lease manager is active
    const maxWorkers = this.leaseManager?.userTierLimit != null
      ? Math.min(1, this.leaseManager.userTierLimit)
      : 1;

    if (this.activeWorkers.size >= maxWorkers) {
      this.logger.debug(
        { active: this.activeWorkers.size, max: maxWorkers },
        'At worker cap, skipping claim',
      );
      return;
    }

    const workerId = randomUUID();
    const item = await this.queue.claim(workerId);

    if (!item) {
      return;
    }

    // Gate dispatch on lease if lease manager is configured and tier_info has been received
    if (this.leaseManager && this.leaseManager.userTierLimit != null) {
      const queueItemId = `${item.owner}/${item.repo}#${item.issueNumber}`;
      const userId = item.userId ?? '';
      const jobId = queueItemId;

      this.logger.info(
        { workerId, queueItemId },
        'Requesting lease before dispatch',
      );

      const result = await this.leaseManager.requestLease(userId, queueItemId, jobId);

      if (result.status === 'denied') {
        // Re-enqueue and pause polling until slot_available
        this.logger.info(
          { reason: result.reason, queueItemId },
          'Lease denied, re-enqueuing and pausing polling',
        );
        await this.queue.release(workerId, item);
        this.pollingPaused = true;
        return;
      }

      if (result.status === 'timeout') {
        // Re-enqueue with retry priority
        this.logger.warn({ queueItemId }, 'Lease request timed out, re-enqueuing');
        await this.queue.release(workerId, item);
        return;
      }

      // Granted — start lease heartbeat and track the lease
      this.leaseManager.startHeartbeat(result.leaseId, userId, queueItemId, workerId);
      this.workerLeases.set(workerId, result.leaseId);
    }

    this.logger.info(
      { workerId, owner: item.owner, repo: item.repo, issue: item.issueNumber },
      'Dispatching worker for claimed item',
    );

    // Start heartbeat refresh at half the TTL
    const heartbeatInterval = this.startHeartbeat(workerId);

    // Create the worker promise
    const promise = this.runWorker(workerId, item, heartbeatInterval);

    const workerInfo: WorkerInfo = {
      workerId,
      item,
      startedAt: Date.now(),
      heartbeatInterval,
      promise,
    };

    this.activeWorkers.set(workerId, workerInfo);
  }

  private async runWorker(
    workerId: string,
    item: import('../types/index.js').QueueItem,
    heartbeatInterval: NodeJS.Timeout,
  ): Promise<void> {
    try {
      await this.handler(item);

      // Success: complete the item
      await this.queue.complete(workerId, item);
      this.logger.info(
        { workerId, owner: item.owner, repo: item.repo, issue: item.issueNumber },
        'Worker completed successfully',
      );
    } catch (error) {
      // Failure: release back to queue
      await this.queue.release(workerId, item);
      this.logger.error(
        { err: error, workerId, owner: item.owner, repo: item.repo, issue: item.issueNumber },
        'Worker failed, item released back to queue',
      );
    } finally {
      clearInterval(heartbeatInterval);
      this.clearHeartbeat(workerId);
      // Release lease if one was acquired
      const leaseId = this.workerLeases.get(workerId);
      if (leaseId && this.leaseManager) {
        this.leaseManager.releaseLease(leaseId);
        this.workerLeases.delete(workerId);
      }
      this.activeWorkers.delete(workerId);
    }
  }

  /**
   * Start a heartbeat for a worker. Returns the interval handle.
   * Uses Redis SET with TTL when Redis is available, or in-memory timestamps otherwise.
   */
  private startHeartbeat(workerId: string): NodeJS.Timeout {
    if (this.redis) {
      const heartbeatKey = `orchestrator:worker:${workerId}:heartbeat`;
      const ttlSeconds = Math.ceil(this.config.heartbeatTtlMs / 1000);
      // Set initial heartbeat
      this.redis.set(heartbeatKey, '1', 'EX', ttlSeconds).catch((error) => {
        this.logger.warn({ err: error, workerId }, 'Failed to set initial heartbeat');
      });
      return setInterval(async () => {
        try {
          await this.redis!.set(heartbeatKey, '1', 'EX', ttlSeconds);
        } catch (error) {
          this.logger.warn({ err: error, workerId }, 'Failed to refresh heartbeat');
        }
      }, this.config.heartbeatTtlMs / 2);
    }

    // In-memory heartbeat: store current timestamp
    this.heartbeatTimestamps.set(workerId, Date.now());
    return setInterval(() => {
      this.heartbeatTimestamps.set(workerId, Date.now());
    }, this.config.heartbeatTtlMs / 2);
  }

  /**
   * Check if a worker's heartbeat is still alive.
   * Uses Redis EXISTS when Redis is available, or checks in-memory timestamps otherwise.
   */
  private async isHeartbeatAlive(workerId: string): Promise<boolean> {
    if (this.redis) {
      const heartbeatKey = `orchestrator:worker:${workerId}:heartbeat`;
      const exists = await this.redis.exists(heartbeatKey);
      return exists === 1;
    }

    // In-memory: check if timestamp is within TTL
    const lastHeartbeat = this.heartbeatTimestamps.get(workerId);
    if (lastHeartbeat === undefined) {
      return false;
    }
    return (Date.now() - lastHeartbeat) < this.config.heartbeatTtlMs;
  }

  /**
   * Clear a worker's heartbeat.
   * Deletes the Redis key or removes the in-memory timestamp.
   */
  private clearHeartbeat(workerId: string): void {
    if (this.redis) {
      const heartbeatKey = `orchestrator:worker:${workerId}:heartbeat`;
      this.redis.del(heartbeatKey).catch((error) => {
        this.logger.warn({ err: error, workerId }, 'Failed to clear heartbeat');
      });
    } else {
      this.heartbeatTimestamps.delete(workerId);
    }
  }

  private async reaperLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.sleep(this.config.heartbeatCheckIntervalMs, signal);

      if (signal.aborted) break;

      try {
        await this.reapStaleWorkers();
      } catch (error) {
        this.logger.error({ err: error }, 'Error during reaper cycle');
      }
    }
  }

  private async reapStaleWorkers(): Promise<void> {
    for (const [workerId, worker] of this.activeWorkers) {
      try {
        const alive = await this.isHeartbeatAlive(workerId);
        if (!alive) {
          this.logger.warn(
            { workerId, item: `${worker.item.owner}/${worker.item.repo}#${worker.item.issueNumber}` },
            'Reaping stale worker (heartbeat expired)',
          );

          // Clean up labels before releasing queue item
          if (this.labelCleanup) {
            try {
              await this.labelCleanup(
                worker.item.owner, worker.item.repo, worker.item.issueNumber,
              );
            } catch (error) {
              this.logger.warn(
                { err: error, workerId },
                'Failed to clean up labels during reap (non-fatal)',
              );
            }
          }

          clearInterval(worker.heartbeatInterval);
          this.clearHeartbeat(workerId);
          await this.queue.release(workerId, worker.item);
          this.activeWorkers.delete(workerId);
        }
      } catch (error) {
        this.logger.warn(
          { err: error, workerId },
          'Error checking worker heartbeat during reap',
        );
      }
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, ms);

      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
