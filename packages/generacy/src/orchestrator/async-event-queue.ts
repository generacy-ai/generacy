/**
 * Bounded async queue that posts events to the orchestrator.
 * Fire-and-forget: drops oldest events on overflow, never blocks the caller.
 */
export class AsyncEventQueue {
  private queue: Array<{ jobId: string; event: object }> = [];
  private processing = false;
  private readonly maxSize: number;
  private readonly postFn: (jobId: string, event: object) => Promise<void>;

  constructor(
    postFn: (jobId: string, event: object) => Promise<void>,
    maxSize = 100,
  ) {
    this.postFn = postFn;
    this.maxSize = maxSize;
  }

  /**
   * Enqueue an event for async posting.
   * Drops the oldest event if the queue is at capacity.
   * Triggers async processing without blocking the caller.
   */
  push(jobId: string, event: object): void {
    if (this.queue.length >= this.maxSize) {
      this.queue.shift();
    }
    this.queue.push({ jobId, event });
    void this.processQueue();
  }

  /**
   * Process queued items sequentially.
   * Silently drops events that fail to post (non-critical telemetry).
   * Re-entrant guard ensures only one processing loop runs at a time.
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.postFn(item.jobId, item.event);
        } catch {
          // Silently drop failed events — non-critical telemetry
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Drain all pending events. Use for graceful shutdown.
   */
  async flush(): Promise<void> {
    await this.processQueue();
  }
}
